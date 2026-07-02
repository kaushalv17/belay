// Typed client for the Quorvel Cloud REST API. Pure TS (no React/Next) so it can
// be unit-tested with an injected fetch and reused by server components, server
// actions, and route handlers alike. The default fetch is the global one.

export interface FetchResponse {
	ok: boolean
	status: number
	json(): Promise<any>
	text(): Promise<string>
}

export interface FetchInit {
	method?: string
	headers?: Record<string, string>
	body?: string
	cache?: string
}

export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>

const globalFetch: FetchLike = (url, init) => (globalThis as any).fetch(url, init)

export type ActionStatus =
	| "pending"
	| "running"
	| "succeeded"
	| "failed"
	| "awaiting_approval"
	| "approved"
	| "rejected"
	| "denied"

export interface ActionRecord {
	idempotencyKey: string
	scope: string | null
	tool: string
	args: unknown
	cost: number
	status: ActionStatus
	result?: unknown
	error?: string
	reason?: string
	attempts: number
	createdAt: string
}

export interface UsageSnapshot {
	plan: string
	period: string
	used: number
	limit: number
	remaining: number
}

export interface CheckoutResult {
	transactionId: string
	checkoutUrl: string | null
	plan: string
	priceId: string
}

// ---- Phase 4: observability (event timeline + run metrics) ----

export type ActionEventType = "created" | "transition"

export interface ActionEvent {
    id: string
    idempotencyKey: string
    type: ActionEventType
    status: ActionStatus
    attempt: number
    reason?: string
    error?: string
    at: string
}

export interface EventOutcomes {
    succeeded: number
    failed: number
    denied: number
    rejected: number
}

export interface LatencyStats {
    count: number
    avg: number
    p50: number
    p95: number
}

export interface EventMetrics {
    since: string | null
    until: string | null
    runs: number
    events: number
    outcomes: EventOutcomes
    terminalRuns: number
    errorRate: number
    latencyMs: LatencyStats
}

export type MetricsResult = EventMetrics & { usage: UsageSnapshot }

export interface RunTimeline {
    action: ActionRecord
    events: ActionEvent[]
}

export interface EventsFilter {
    status?: ActionStatus
    action?: string
    since?: string
}

export interface MetricsWindow {
    since?: string
    until?: string
}

// ---- Phase 1/2: API keys, account, billing portal, onboarding ----

export interface ApiKeyPublic {
	id: string
	orgId: string
	name: string
	keyPrefix: string
	env: string
	scopes: string[]
	createdAt: string
	lastUsedAt?: string | null
	revokedAt?: string | null
	createdBy?: string | null
}

export interface CreateKeyInput {
	name?: string
	env?: string
	scopes?: string[]
}

export interface AuditEntry {
	id: string
	orgId: string
	actorId?: string | null
	action: string
	target?: string | null
	metadata?: unknown
	createdAt: string
}

export interface MeResult {
	org: { id: string; name: string; plan: string; createdAt: string }
	usage: UsageSnapshot
}

/** Returns the auth headers to attach to each request (dashboard service-auth mode). */
export type AuthHeaderProvider = () =>
	| Promise<Record<string, string>>
	| Record<string, string>

export interface QuorvelClientOptions {
	baseUrl: string
	/** SDK / Bearer mode. Provide this OR authProvider. */
	apiKey?: string
	/** Dashboard service-auth mode: per-request auth headers (e.g. Clerk org context). */
	authProvider?: AuthHeaderProvider
	fetchImpl?: FetchLike
}

export class QuorvelApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message)
		this.name = "QuorvelApiError"
	}
}

export class QuorvelClient {
	private readonly baseUrl: string
	private readonly apiKey?: string
	private readonly authProvider?: AuthHeaderProvider
	private readonly fetchImpl: FetchLike

	constructor(opts: QuorvelClientOptions) {
		this.baseUrl = opts.baseUrl.replace(/\/$/, "")
		this.apiKey = opts.apiKey
		this.authProvider = opts.authProvider
		this.fetchImpl = opts.fetchImpl ?? globalFetch
		if (!this.apiKey && !this.authProvider) {
			throw new Error("QuorvelClient requires either apiKey or authProvider")
		}
	}

	private async authHeaders(): Promise<Record<string, string>> {
		if (this.authProvider) return this.authProvider()
		return { authorization: `Bearer ${this.apiKey}` }
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method,
			headers: {
				...(await this.authHeaders()),
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			cache: "no-store",
		})
		if (!res.ok) {
			let code: string | undefined
			let message = `request failed: ${res.status}`
			try {
				const data = await res.json()
				if (data?.error) message = data.error
				if (data?.code) code = data.code
			} catch {
				/* non-JSON error body */
			}
			throw new QuorvelApiError(message, res.status, code)
		}
		if (res.status === 204) return undefined as T
		return (await res.json()) as T
	}

	listRecent(limit = 50): Promise<ActionRecord[]> {
		return this.request("GET", `/v1/actions?limit=${limit}`)
	}

	listByStatus(status: ActionStatus, limit = 50): Promise<ActionRecord[]> {
		return this.request("GET", `/v1/actions?status=${encodeURIComponent(status)}&limit=${limit}`)
	}

	approvalQueue(limit = 50): Promise<ActionRecord[]> {
		return this.listByStatus("awaiting_approval", limit)
	}

	getAction(key: string): Promise<ActionRecord> {
		return this.request("GET", `/v1/actions/${encodeURIComponent(key)}`)
	}

	approve(key: string): Promise<void> {
		return this.request("POST", `/v1/actions/${encodeURIComponent(key)}/approved`, {})
	}

	reject(key: string, reason: string): Promise<void> {
		return this.request("POST", `/v1/actions/${encodeURIComponent(key)}/rejected`, { reason })
	}

	checkout(plan: string): Promise<CheckoutResult> {
		return this.request("POST", `/v1/billing/checkout`, { plan })
	}

	usage(): Promise<UsageSnapshot> {
		return this.request("GET", `/v1/usage`)
	}

	// Mirror/link the caller's active Clerk org (identity travels in auth headers
	// in dashboard service-auth mode). Idempotent; returns the org's API key only
	// the first time the org is created. Useful for the Step 5 onboarding flow.
	provisionOrg(): Promise<{
		orgId: string
		created: boolean
		apiKey?: string
		keyPrefix?: string
	}> {
		return this.request("POST", `/v1/orgs/provision`, {})
	}

	    // ---- Phase 4: observability ----

    /** Cross-run event feed (newest first). Filter by status, action key, or ISO `since`. */
    listEvents(filter: EventsFilter = {}): Promise<ActionEvent[]> {
        const q = new URLSearchParams()
        if (filter.status) q.set("status", filter.status)
        if (filter.action) q.set("action", filter.action)
        if (filter.since) q.set("since", filter.since)
        const qs = q.toString()
        return this.request("GET", `/v1/events${qs ? `?${qs}` : ""}`)
    }

    /** Full event timeline for one run: the action row plus its ordered events. */
    runTimeline(key: string): Promise<RunTimeline> {
        return this.request("GET", `/v1/actions/${encodeURIComponent(key)}/events`)
    }

    /** Aggregate run metrics (+ current usage) over an optional time window. */
    metrics(window: MetricsWindow = {}): Promise<MetricsResult> {
        const q = new URLSearchParams()
        if (window.since) q.set("since", window.since)
        if (window.until) q.set("until", window.until)
        const qs = q.toString()
        return this.request("GET", `/v1/metrics${qs ? `?${qs}` : ""}`)
    }

		// ---- Phase 1/2 account surface ----

	/** Org + current-period usage for the signed-in org (billing summary). */
	me(): Promise<MeResult> {
		return this.request("GET", `/v1/me`)
	}

	/** List this org's API keys (secrets are never returned here). */
	listKeys(): Promise<ApiKeyPublic[]> {
		return this.request("GET", `/v1/account/keys`)
	}

	/** Create a new API key. The plaintext secret is returned exactly once. */
	createKey(input: CreateKeyInput = {}): Promise<{ apiKey: string; key: ApiKeyPublic }> {
		return this.request("POST", `/v1/account/keys`, input)
	}

	/** Rotate a key: revoke the old one and issue a replacement (secret once). */
	rotateKey(id: string): Promise<{ apiKey: string; key: ApiKeyPublic }> {
		return this.request("POST", `/v1/account/keys/${encodeURIComponent(id)}/rotate`, {})
	}

	/** Revoke a key immediately. */
	revokeKey(id: string): Promise<{ revoked: boolean }> {
		return this.request("DELETE", `/v1/account/keys/${encodeURIComponent(id)}`)
	}

	/** Audit log (who did what, when) for the org. */
	auditLog(limit = 100): Promise<AuditEntry[]> {
		return this.request("GET", `/v1/audit?limit=${limit}`)
	}

	/** Create a Paddle hosted billing-portal session for the org. */
	billingPortal(): Promise<{ url: string }> {
		return this.request("POST", `/v1/billing/portal`, {})
	}

	/** Onboarding helper: seed a few sample actions so the dashboard isn't empty. */
	seedSample(): Promise<{ created: number }> {
		return this.request("POST", `/v1/onboarding/sample`, {})
	}
}

// Group a flat action list by scope (agent) for the timeline view.
export function groupByScope(actions: ActionRecord[]): Map<string, ActionRecord[]> {
	const out = new Map<string, ActionRecord[]>()
	for (const a of actions) {
		const key = a.scope ?? "(unscoped)"
		const list = out.get(key) ?? []
		list.push(a)
		out.set(key, list)
	}
	return out
}