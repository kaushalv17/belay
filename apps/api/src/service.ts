// Framework-agnostic business logic. Talks only to a Store.
import { createHash } from "node:crypto"
import { actionCreated, actionTransition } from "./events"
import { currentPeriod, planFeatures, planLimit, type UsageLimiter, type UsageSnapshot } from "./billing"
import { generateApiKey, hashApiKey, keyPrefix, newId } from "./keys"
import { toRecord, type Store } from "./store"
import type { ActionEvent, ActionEventLog, EventMetrics } from "./actionEvents"
import type { DeadLetterRecord, DeadLetterStore } from "./deadLetters"
import type { PaddleBilling, CheckoutResult, WebhookResult } from "./paddle"
import type { EventBus } from "./bus"
import { ALERT_TRIGGERS } from "./alertRules"
import type {
    AlertRuleRecord,
    AlertRuleStore,
    AlertTrigger,
    CreateAlertRuleInput,
    UpdateAlertRuleInput,
} from "./alertRules"
import type {
    ActionRecord,
    ActionStatus,
    ApiKeyPublic,
    ApiKeyRecord,
    AuditEntry,
    CreateApiKeyInput,
    InsertPendingInput,
    InsertResult,
    IssueKeyInput,
    IssueKeyResult,
    ProvisionOrgInput,
    ProvisionOrgResult,
    Stats,
    StatsFilter,
    TransitionPatch,
} from "./types"

export class ApiError extends Error {
    constructor(
        message: string,
        readonly statusCode: number,
        readonly code: string,
    ) {
        super(message)
        this.name = "ApiError"
    }
}

export const authError = (msg = "unauthorized") => new ApiError(msg, 401, "unauthorized")
export const badRequest = (msg: string) => new ApiError(msg, 400, "bad_request")
export const quotaError = (msg: string) => new ApiError(msg, 402, "quota_exceeded")

export const DEFAULT_SCOPES = ["actions:read", "actions:write"]

/** Strip the secret hash before returning a key to any client. */
export function toPublicKey(rec: ApiKeyRecord): ApiKeyPublic {
    return {
        id: rec.id,
        orgId: rec.orgId,
        name: rec.name,
        keyPrefix: rec.keyPrefix,
        env: rec.env ?? "live",
        scopes: rec.scopes ?? [...DEFAULT_SCOPES],
        createdAt: rec.createdAt,
        lastUsedAt: rec.lastUsedAt ?? null,
        revokedAt: rec.revokedAt ?? null,
        createdBy: rec.createdBy ?? null,
    }
}

/** Stable hash of method+path+body, to detect Idempotency-Key reuse with a different request. */
function idemFingerprint(req: { method: string; path: string; body: unknown }): string {
    const canonical = JSON.stringify({ m: req.method, p: req.path, b: req.body ?? null })
    return createHash("sha256").update(canonical).digest("hex")
}

export interface ServiceDeps {
    alertRuleStore?: AlertRuleStore
	actionEventLog?: ActionEventLog
    bus?: EventBus
    limiter?: UsageLimiter
    billing?: PaddleBilling
    deadLetters?: DeadLetterStore
    deadLetterReplay?: (rec: DeadLetterRecord) => Promise<void>
}

export class QuorvelCloudService {
    private readonly bus?: EventBus
    private readonly limiter?: UsageLimiter
    private readonly billing?: PaddleBilling
    private readonly deadLetters?: DeadLetterStore
    private readonly deadLetterReplay?: (rec: DeadLetterRecord) => Promise<void>
	private readonly actionEventLog?: ActionEventLog
    private readonly alertRuleStore?: AlertRuleStore

    constructor(private readonly store: Store, deps: ServiceDeps = {}) {
        this.bus = deps.bus
        this.limiter = deps.limiter
        this.billing = deps.billing
        this.deadLetters = deps.deadLetters
        this.deadLetterReplay = deps.deadLetterReplay
		this.actionEventLog = deps.actionEventLog
        this.alertRuleStore = deps.alertRuleStore
    }

    async issueApiKey(input: IssueKeyInput): Promise<IssueKeyResult> {
        const now = new Date().toISOString()
        const orgId = newId("org")
        await this.store.insertOrg({
            id: orgId,
            name: input.orgName ?? "org",
            plan: input.plan ?? "free",
            createdAt: now,
        })
        const apiKey = generateApiKey("live")
        await this.store.insertApiKey({
            id: newId("key"),
            orgId,
            keyHash: hashApiKey(apiKey),
            keyPrefix: keyPrefix(apiKey),
            name: "default",
            createdAt: now,
        })
        return { orgId, apiKey, keyPrefix: keyPrefix(apiKey) }
    }

    async provisionOrg(input: ProvisionOrgInput): Promise<ProvisionOrgResult> {
        if (!input || !input.clerkOrgId || !input.clerkUserId) {
            throw badRequest("clerkOrgId and clerkUserId are required")
        }
        const role = input.role ?? "owner"
        const now = new Date().toISOString()
        const existing = await this.store.getOrgByClerkId(input.clerkOrgId)
        if (existing) {
            const member = await this.store.getMembership(input.clerkUserId, existing.id)
            if (!member) {
                await this.store.upsertMembership({
                    clerkUserId: input.clerkUserId,
                    orgId: existing.id,
                    role,
                    createdAt: now,
                })
            }
            return { orgId: existing.id, created: false }
        }
        const orgId = newId("org")
        await this.store.insertOrg({
            id: orgId,
            name: input.orgName ?? "org",
            plan: "free",
            clerkOrgId: input.clerkOrgId,
            createdAt: now,
        })
        await this.store.upsertMembership({
            clerkUserId: input.clerkUserId,
            orgId,
            role,
            createdAt: now,
        })
        const apiKey = generateApiKey("live")
        await this.store.insertApiKey({
            id: newId("key"),
            orgId,
            keyHash: hashApiKey(apiKey),
            keyPrefix: keyPrefix(apiKey),
            name: "default",
            createdAt: now,
        })
        return { orgId, created: true, apiKey, keyPrefix: keyPrefix(apiKey) }
    }

    async authenticate(authHeader: string | undefined): Promise<{ orgId: string }> {
        if (!authHeader) throw authError("missing Authorization header")
        const token = authHeader.startsWith("Bearer ")
            ? authHeader.slice("Bearer ".length).trim()
            : authHeader.trim()
        if (!token) throw authError("empty API key")
        const rec = await this.store.getApiKeyByHash(hashApiKey(token))
        if (!rec) throw authError("invalid API key")
        if (rec.revokedAt) throw authError("API key revoked")
        void Promise.resolve(this.store.touchApiKeyLastUsed(rec.keyHash)).catch(
            () => {},
        )
        return { orgId: rec.orgId }
    }

    async authenticateDashboard(
        clerkOrgId: string | undefined,
        clerkUserId: string | undefined,
        orgName?: string,
    ): Promise<{ orgId: string; role: string }> {
        if (!clerkOrgId || !clerkUserId) {
            throw authError("missing Clerk org/user context")
        }
        const org = await this.store.getOrgByClerkId(clerkOrgId)
        if (!org) {
            const res = await this.provisionOrg({
                clerkOrgId,
                clerkUserId,
                orgName,
                role: "owner",
            })
            return { orgId: res.orgId, role: "owner" }
        }
        const member = await this.store.getMembership(clerkUserId, org.id)
        if (!member) {
            await this.store.upsertMembership({
                clerkUserId,
                orgId: org.id,
                role: "member",
                createdAt: new Date().toISOString(),
            })
            return { orgId: org.id, role: "member" }
        }
        return { orgId: org.id, role: member.role }
    }

    /**
     * RFC-style Idempotency-Key replay for write endpoints. Claims the key, runs
     * the handler once, persists the 2xx response, and replays it on retries.
     */
    async withIdempotency(
        orgId: string,
        idemKey: string,
        req: { method: string; path: string; body: unknown },
        run: () => Promise<{ status: number; body?: unknown }>,
    ): Promise<{ status: number; body?: unknown }> {
        const fingerprint = idemFingerprint(req)
        const claim = await this.store.claimIdempotency({
            orgId,
            idemKey,
            fingerprint,
            method: req.method,
            path: req.path,
            createdAt: new Date().toISOString(),
        })
        if (!claim.claimed) {
            const ex = claim.existing
            if (ex.fingerprint !== fingerprint) {
                throw new ApiError(
                    "Idempotency-Key was reused with a different request",
                    422,
                    "idempotency_key_reuse",
                )
            }
            if (ex.statusCode == null) {
                throw new ApiError(
                    "a request with this Idempotency-Key is still being processed",
                    409,
                    "idempotency_in_progress",
                )
            }
            return { status: ex.statusCode, body: ex.responseBody }
        }
        try {
            const res = await run()
            if (res.status >= 200 && res.status < 300) {
                await this.store.completeIdempotency(orgId, idemKey, res.status, res.body ?? null)
            } else {
                await this.store.deleteIdempotency(orgId, idemKey).catch(() => {})
            }
            return res
        } catch (e) {
            await this.store.deleteIdempotency(orgId, idemKey).catch(() => {})
            throw e
        }
    }

    async insertPending(orgId: string, input: InsertPendingInput): Promise<InsertResult> {
        if (!input || typeof input.idempotencyKey !== "string" || !input.tool) {
            throw badRequest("idempotencyKey and tool are required")
        }
        // Atomic quota enforcement: reserve a usage slot up front. The store's
        // increment is atomic, so concurrent inserts each take a distinct slot and
        // any over-limit reservation is rolled back inside reserve() -- no overshoot.
        if (this.limiter) {
            const verdict = await this.limiter.reserve(orgId)
            if (!verdict.allowed) throw quotaError(verdict.reason ?? "quota exceeded")
        }
        const normalized: InsertPendingInput = {
            idempotencyKey: input.idempotencyKey,
            scope: input.scope ?? null,
            tool: input.tool,
            args: input.args,
            cost: input.cost,
        }
        let res: InsertResult
        try {
            res = await this.store.insertPending(orgId, normalized)
        } catch (err) {
            if (this.limiter) await this.limiter.release(orgId)
            throw err
        }
        if (!res.inserted) {
            // Idempotent duplicate: no new row was created, so refund the slot we
            // reserved above. Duplicates must never consume quota.
            if (this.limiter) await this.limiter.release(orgId)
            return res
        }
        if (this.bus) {
            const row = await this.store.getAction(orgId, normalized.idempotencyKey)
            if (row) await this.bus.publish(actionCreated(row))
        }
        return res
    }

    /**
	 * Phase 4 observability: a run plus its full lifecycle timeline (the
	 * ordered event log), for the per-run inspector view.
	 */
	async runTimeline(
		orgId: string,
		key: string,
	): Promise<{ action: ActionRecord; events: ActionEvent[] } | undefined> {
		const row = await this.store.getAction(orgId, key)
		if (!row) return undefined
		const events = this.actionEventLog
			? await this.actionEventLog.listByRun(orgId, key)
			: []
		return { action: toRecord(row), events }
	}

	/** Cross-run recent event feed (newest first), for the activity view. */
	private retentionFloorIso(retentionDays: number): string | null {
        if (!Number.isFinite(retentionDays)) return null
        return new Date(Date.now() - retentionDays * 86400000).toISOString()
    }

    private clampSince(since: string | null | undefined, retentionDays: number): string | null {
        const floor = this.retentionFloorIso(retentionDays)
        if (floor === null) return since ?? null
        if (!since) return floor
        return since > floor ? since : floor
    }

    async listEvents(
		orgId: string,
		filter: {
			status?: ActionStatus
			idempotencyKey?: string
			since?: string | null
			limit?: number
		} = {},
	): Promise<ActionEvent[]> {
		if (!this.actionEventLog) return []
		const org = await this.store.getOrg(orgId)
        const features = planFeatures(org?.plan)
        const clampedSince = this.clampSince(filter.since, features.retentionDays)
        return this.actionEventLog.listRecent(orgId, { ...filter, since: clampedSince })
	}

	/** Aggregate run metrics for a window, merged with the current usage snapshot. */
	async metrics(
		orgId: string,
		window: { since?: string | null; until?: string | null } = {},
	): Promise<EventMetrics & { usage: UsageSnapshot }> {
		const org = await this.store.getOrg(orgId)
        const features = planFeatures(org?.plan)
        window = { ...window, since: this.clampSince(window.since, features.retentionDays) }
        const base: EventMetrics = this.actionEventLog
			? await this.actionEventLog.metrics(orgId, window)
			: {
				since: window.since ?? null,
				until: window.until ?? null,
				runs: 0,
				events: 0,
				outcomes: { succeeded: 0, failed: 0, denied: 0, rejected: 0 },
				terminalRuns: 0,
				errorRate: 0,
				latencyMs: { count: 0, avg: null, p50: null, p95: null },
			}
		const usage = await this.usage(orgId)
		return { ...base, usage }
	}

	async getAction(orgId: string, key: string): Promise<ActionRecord | undefined> {
        const row = await this.store.getAction(orgId, key)
        return row ? toRecord(row) : undefined
    }

    private async transition(orgId: string, key: string, patch: TransitionPatch): Promise<void> {
        await this.store.applyTransition(orgId, key, patch)
        if (this.bus) {
            const row = await this.store.getAction(orgId, key)
            if (row) await this.bus.publish(actionTransition(row))
        }
    }

    markRunning(orgId: string, key: string): Promise<void> {
        return this.transition(orgId, key, { status: "running", incrementAttempts: true })
    }
    markSucceeded(orgId: string, key: string, result: unknown): Promise<void> {
        return this.transition(orgId, key, { status: "succeeded", result: result ?? null })
    }
    markFailed(orgId: string, key: string, error: string): Promise<void> {
        return this.transition(orgId, key, { status: "failed", error: error ?? "" })
    }
    markAwaitingApproval(orgId: string, key: string, reason: string): Promise<void> {
        return this.transition(orgId, key, { status: "awaiting_approval", reason: reason ?? "" })
    }
    markApproved(orgId: string, key: string): Promise<void> {
        return this.transition(orgId, key, { status: "approved" })
    }
    markRejected(orgId: string, key: string, reason: string): Promise<void> {
        return this.transition(orgId, key, { status: "rejected", reason: reason ?? "" })
    }
    markDenied(orgId: string, key: string, reason: string): Promise<void> {
        return this.transition(orgId, key, { status: "denied", reason: reason ?? "" })
    }

    listByStatus(orgId: string, status: ActionStatus, limit?: number): Promise<ActionRecord[]> {
        return this.store.listByStatus(orgId, status, limit)
    }
    listRecent(orgId: string, limit?: number): Promise<ActionRecord[]> {
        return this.store.listRecent(orgId, limit)
    }
    stats(orgId: string, filter: StatsFilter): Promise<Stats> {
        return this.store.stats(orgId, {
            scope: filter.scope ?? null,
            tool: filter.tool,
            since: filter.since ?? null,
        })
    }

    async createCheckout(
        orgId: string,
        input: { plan?: string },
    ): Promise<CheckoutResult> {
        if (!this.billing) throw badRequest("billing is not configured")
        const plan = input?.plan
        if (plan !== "pro" && plan !== "scale") {
            throw badRequest("plan must be 'pro' or 'scale'")
        }
        return this.billing.createCheckout(orgId, plan)
    }

    async handlePaddleWebhook(
        rawBody: string,
        signature: string | undefined,
    ): Promise<WebhookResult> {
        if (!this.billing) throw badRequest("billing is not configured")
        try {
            return await this.billing.handleWebhook(rawBody, signature, this.store)
        } catch (e) {
            const msg = e instanceof Error ? e.message : "webhook error"
            if (msg.includes("signature") || msg.includes("payload")) {
                throw authError(msg)
            }
            throw e
        }
    }

    async usage(orgId: string): Promise<UsageSnapshot> {
        if (this.limiter) return this.limiter.usage(orgId)
        const limit = planLimit("free")
        return {
            plan: "free",
            period: currentPeriod(),
            used: 0,
            limit,
            remaining: limit,
            percentUsed: 0,
            nearLimit: false,
            over: false,
            overage: 0,
        }
    }

    private async audit(
        orgId: string,
        actorId: string | undefined | null,
        action: string,
        target?: string,
        metadata?: unknown,
    ): Promise<void> {
        try {
            await this.store.insertAuditLog({
                id: newId("aud"),
                orgId,
                actorId: actorId ?? null,
                action,
                target: target ?? null,
                metadata,
                createdAt: new Date().toISOString(),
            })
        } catch {
            // Auditing must never break the request path.
        }
    }

    async listApiKeys(orgId: string): Promise<ApiKeyPublic[]> {
        const rows = await this.store.listApiKeys(orgId)
        return rows.map(toPublicKey)
    }

    async createApiKey(
        orgId: string,
        input: CreateApiKeyInput = {},
    ): Promise<{ apiKey: string; key: ApiKeyPublic }> {
        const env = input.env === "test" ? "test" : "live"
        const scopes =
            Array.isArray(input.scopes) && input.scopes.length
                ? input.scopes
                : [...DEFAULT_SCOPES]
        const apiKey = generateApiKey(env)
        const rec: ApiKeyRecord = {
            id: newId("key"),
            orgId,
            keyHash: hashApiKey(apiKey),
            keyPrefix: keyPrefix(apiKey),
            name: (input.name ?? "").trim() || "default",
            env,
            scopes,
            createdBy: input.createdBy ?? null,
            createdAt: new Date().toISOString(),
        }
        await this.store.insertApiKey(rec)
        await this.audit(orgId, input.createdBy, "api_key.created", rec.id, {
            name: rec.name,
            env,
            scopes,
        })
        return { apiKey, key: toPublicKey(rec) }
    }

    async rotateApiKey(
        orgId: string,
        id: string,
        actorId?: string | null,
    ): Promise<{ apiKey: string; key: ApiKeyPublic }> {
        const old = await this.store.getApiKeyById(orgId, id)
        if (!old) throw new ApiError("API key not found", 404, "not_found")
        await this.store.revokeApiKey(orgId, id)
        const created = await this.createApiKey(orgId, {
            name: old.name,
            env: old.env ?? "live",
            scopes: old.scopes ?? [...DEFAULT_SCOPES],
            createdBy: actorId ?? old.createdBy ?? null,
        })
        await this.audit(orgId, actorId, "api_key.rotated", id, {
            replacedBy: created.key.id,
        })
        return created
    }

    async revokeApiKey(
        orgId: string,
        id: string,
        actorId?: string | null,
    ): Promise<{ revoked: boolean }> {
        const ok = await this.store.revokeApiKey(orgId, id)
        if (!ok) throw new ApiError("API key not found", 404, "not_found")
        await this.audit(orgId, actorId, "api_key.revoked", id)
        return { revoked: true }
    }

    async listAuditLog(orgId: string, limit = 100): Promise<AuditEntry[]> {
        return this.store.listAuditLog(orgId, limit)
    }

    async me(orgId: string): Promise<{
        org: { id: string; name: string; plan: string; createdAt: string }
        features: { maxAlertRules: number; retentionDays: number; maxSeats: number; alertRulesUsed: number }
        usage: UsageSnapshot
    }> {
        const org = await this.store.getOrg(orgId)
        const usage = await this.usage(orgId)
        return {
            org: {
                id: orgId,
                name: org?.name ?? "org",
                plan: org?.plan ?? "free",
                createdAt: org?.createdAt ?? new Date().toISOString(),
            },
            features: {
                maxAlertRules: planFeatures(org?.plan).maxAlertRules,
                retentionDays: planFeatures(org?.plan).retentionDays,
                maxSeats: planFeatures(org?.plan).maxSeats,
                alertRulesUsed: this.alertRuleStore ? (await this.alertRuleStore.list(orgId)).length : 0,
            },
            usage,
        }
    }

    async createBillingPortal(orgId: string): Promise<{ url: string }> {
        if (!this.billing) throw badRequest("billing is not configured")
        const org = await this.store.getOrg(orgId)
        const customerId = org?.paddleCustomerId
        if (!customerId) {
            throw badRequest(
                "no billing customer yet \u2014 complete a checkout first to open the portal",
            )
        }
        return this.billing.createBillingPortal(customerId)
    }

    async seedSampleData(orgId: string): Promise<{ created: number }> {
        const samples: Array<{ tool: string; scope: string; awaiting?: boolean }> = [
            { tool: "refund.issue", scope: "sample-agent", awaiting: true },
            { tool: "email.send", scope: "sample-agent" },
            { tool: "db.write", scope: "sample-agent" },
        ]
        let created = 0
        for (let i = 0; i < samples.length; i++) {
            const s = samples[i]
            const key = `sample-${Date.now()}-${i}`
            const res = await this.store.insertPending(orgId, {
                idempotencyKey: key,
                scope: s.scope,
                tool: s.tool,
                args: { sample: true },
                cost: 1,
            })
            if (res.inserted) {
                created++
                if (s.awaiting) {
                    await this.store.applyTransition(orgId, key, {
                        status: "awaiting_approval",
                        reason: "Sample action awaiting your approval",
                    })
                } else {
                    await this.store.applyTransition(orgId, key, {
                        status: "succeeded",
                        result: { ok: true },
                    })
                }
            }
        }
        await this.audit(orgId, null, "onboarding.sample_seeded", undefined, { created })
        return { created }
    }

    // --- Alert rules (Phase 4-D) ---------------------------------------------
    async listAlertRules(orgId: string): Promise<AlertRuleRecord[]> {
        if (!this.alertRuleStore) return []
        return this.alertRuleStore.list(orgId)
    }

    private normalizeTrigger(trigger: unknown): AlertTrigger {
        if (typeof trigger !== "string" || !ALERT_TRIGGERS.includes(trigger as AlertTrigger)) {
            throw badRequest(`trigger must be one of: ${ALERT_TRIGGERS.join(", ")}`)
        }
        return trigger as AlertTrigger
    }

    private normalizeChannels(channels: unknown): string[] {
        if (!Array.isArray(channels) || channels.some((c) => typeof c !== "string")) {
            throw badRequest("channels must be an array of channel names")
        }
        return channels as string[]
    }

    async createAlertRule(
        orgId: string,
        input: CreateAlertRuleInput,
        actorId?: string | null,
    ): Promise<AlertRuleRecord> {
        if (!this.alertRuleStore) throw badRequest("alert rules are not configured")
        const name = typeof input?.name === "string" ? input.name.trim() : ""
        if (!name) throw badRequest("name is required")
        const trigger = this.normalizeTrigger(input.trigger)
        const channels = this.normalizeChannels(input.channels)
        const org = await this.store.getOrg(orgId)
        const features = planFeatures(org?.plan)
        const existing = await this.alertRuleStore.list(orgId)
        if (existing.length >= features.maxAlertRules) {
            throw new ApiError(
                `alert rule limit reached for the ${org?.plan ?? "free"} plan (max ${features.maxAlertRules})`,
                403,
                "plan_limit",
            )
        }
        const rule = await this.alertRuleStore.create(orgId, newId("alr"), {
            name,
            trigger,
            scope: input.scope ?? null,
            channels,
            enabled: input.enabled ?? true,
        })
        await this.audit(orgId, actorId, "alert_rule.created", rule.id, { name, trigger, channels })
        return rule
    }

    async updateAlertRule(
        orgId: string,
        id: string,
        patch: UpdateAlertRuleInput,
        actorId?: string | null,
    ): Promise<AlertRuleRecord> {
        if (!this.alertRuleStore) throw badRequest("alert rules are not configured")
        const clean: UpdateAlertRuleInput = {}
        if (patch?.name !== undefined) {
            const name = typeof patch.name === "string" ? patch.name.trim() : ""
            if (!name) throw badRequest("name must be a non-empty string")
            clean.name = name
        }
        if (patch?.trigger !== undefined) clean.trigger = this.normalizeTrigger(patch.trigger)
        if (patch?.scope !== undefined) clean.scope = patch.scope ?? null
        if (patch?.channels !== undefined) clean.channels = this.normalizeChannels(patch.channels)
        if (patch?.enabled !== undefined) {
            if (typeof patch.enabled !== "boolean") throw badRequest("enabled must be a boolean")
            clean.enabled = patch.enabled
        }
        const updated = await this.alertRuleStore.update(orgId, id, clean)
        if (!updated) throw new ApiError("alert rule not found", 404, "not_found")
        await this.audit(orgId, actorId, "alert_rule.updated", id, clean)
        return updated
    }

    async deleteAlertRule(
        orgId: string,
        id: string,
        actorId?: string | null,
    ): Promise<{ deleted: boolean }> {
        if (!this.alertRuleStore) throw badRequest("alert rules are not configured")
        const ok = await this.alertRuleStore.remove(orgId, id)
        if (!ok) throw new ApiError("alert rule not found", 404, "not_found")
        await this.audit(orgId, actorId, "alert_rule.deleted", id)
        return { deleted: true }
    }

    // --- Dead-letter queue (Phase 3 reliability) ------------------------------
    async listDeadLetters(orgId: string, limit = 100): Promise<DeadLetterRecord[]> {
        if (!this.deadLetters) return []
        return this.deadLetters.listDeadLetters(orgId, limit)
    }

    async getDeadLetter(orgId: string, id: string): Promise<DeadLetterRecord> {
        const rec = this.deadLetters
            ? await this.deadLetters.getDeadLetter(orgId, id)
            : undefined
        if (!rec) throw new ApiError("dead letter not found", 404, "not_found")
        return rec
    }

    async replayDeadLetter(orgId: string, id: string): Promise<{ replayed: boolean }> {
        const rec = await this.getDeadLetter(orgId, id)
        if (!this.deadLetterReplay) throw badRequest("dead-letter replay is not configured")
        // Re-runs ONLY the failed subscriber; if it throws again the row is kept.
        await this.deadLetterReplay(rec)
        if (this.deadLetters) await this.deadLetters.deleteDeadLetter(orgId, id)
        await this.audit(orgId, null, "dead_letter.replayed", id, {
            subscriber: rec.subscriber,
            eventType: rec.eventType,
        })
        return { replayed: true }
    }

    async discardDeadLetter(orgId: string, id: string): Promise<{ discarded: boolean }> {
        const ok = this.deadLetters
            ? await this.deadLetters.deleteDeadLetter(orgId, id)
            : false
        if (!ok) throw new ApiError("dead letter not found", 404, "not_found")
        await this.audit(orgId, null, "dead_letter.discarded", id)
        return { discarded: true }
    }
}