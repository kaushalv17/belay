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

export interface QuorvelClientOptions {
	baseUrl: string
	apiKey: string
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
	private readonly apiKey: string
	private readonly fetchImpl: FetchLike

	constructor(opts: QuorvelClientOptions) {
		this.baseUrl = opts.baseUrl.replace(/\/$/, "")
		this.apiKey = opts.apiKey
		this.fetchImpl = opts.fetchImpl ?? globalFetch
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${this.apiKey}`,
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
