// Framework-agnostic business logic. Talks only to a Store.
import { createHash } from "node:crypto"
import { actionCreated, actionTransition } from "./events"
import { currentPeriod, planLimit, type UsageLimiter, type UsageSnapshot } from "./billing"
import { generateApiKey, hashApiKey, keyPrefix, newId } from "./keys"
import { toRecord, type Store } from "./store"
import type { PaddleBilling, CheckoutResult, WebhookResult } from "./paddle"
import type { EventBus } from "./bus"
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
    bus?: EventBus
    limiter?: UsageLimiter
    billing?: PaddleBilling
}

export class QuorvelCloudService {
    private readonly bus?: EventBus
    private readonly limiter?: UsageLimiter
    private readonly billing?: PaddleBilling

    constructor(private readonly store: Store, deps: ServiceDeps = {}) {
        this.bus = deps.bus
        this.limiter = deps.limiter
        this.billing = deps.billing
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
        if (this.limiter) {
            const verdict = await this.limiter.check(orgId)
            if (!verdict.allowed) throw quotaError(verdict.reason ?? "quota exceeded")
        }
        const normalized: InsertPendingInput = {
            idempotencyKey: input.idempotencyKey,
            scope: input.scope ?? null,
            tool: input.tool,
            args: input.args,
            cost: input.cost,
        }
        const res = await this.store.insertPending(orgId, normalized)
        if (res.inserted && this.bus) {
            const row = await this.store.getAction(orgId, normalized.idempotencyKey)
            if (row) await this.bus.publish(actionCreated(row))
        }
        return res
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
        return { plan: "free", period: currentPeriod(), used: 0, limit, remaining: limit }
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
}