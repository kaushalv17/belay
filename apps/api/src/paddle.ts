// apps/api/src/paddle.ts
//
// Paddle (Merchant of Record) billing integration. Plan management happens via
// hosted checkout -> signed webhook -> flip org.plan. Self-contained: depends
// only on node:crypto + a tiny PlanStore interface, so it compiles and unit-tests
// in isolation. Mirrors the StripeMeter pattern: an optional, env-gated
// collaborator that the wiring layer injects only when configured.
//
// Provider-agnostic seam: the surface (verifySignature / handleWebhook /
// createCheckout / priceForPlan) is generic enough that a Lemon Squeezy adapter
// could implement the same shape if we ever swap MoR.

import { createHmac, timingSafeEqual } from "node:crypto"

export type FetchLike = (
	url: string,
	init: {
		method: string
		headers: Record<string, string>
		body?: string
	},
) => Promise<{
	ok: boolean
	status: number
	json(): Promise<any>
	text(): Promise<string>
}>

const defaultFetch: FetchLike = (url, init) =>
	(globalThis as any).fetch(url, init)

/** Minimal store surface Paddle needs: flip an org's plan. */
export interface PlanStore {
	setOrgPlan(orgId: string, plan: string): Promise<void>
}

/** Extended store the webhook can use to also persist the Paddle customer id. */
export interface BillingStore extends PlanStore {
	setOrgPaddleCustomer?(orgId: string, customerId: string): Promise<void>
}

export interface PaddleConfig {
	apiKey: string
	webhookSecret: string
	/** Maps a Paddle price id (pri_...) to an internal plan name. */
	priceToPlan: Record<string, string>
	/** API base. Sandbox: https://sandbox-api.paddle.com ; Prod: https://api.paddle.com */
	apiBase?: string
	fetchImpl?: FetchLike
	/** Replay-tolerance window for webhook timestamps (seconds). 0 disables. */
	toleranceSeconds?: number
}

/** The bits of a Paddle webhook event we actually use. */
export interface PaddleEvent {
	event_type?: string
	data?: {
		id?: string
		status?: string
		customer_id?: string
		items?: Array<{ price?: { id?: string }; price_id?: string }>
		custom_data?: Record<string, unknown> | null
	}
}

export interface CheckoutResult {
	transactionId: string
	checkoutUrl: string | null
	plan: string
	priceId: string
}

export interface WebhookResult {
	handled: boolean
	eventType?: string
	orgId?: string
	plan?: string
}

const DEFAULT_API_BASE = "https://api.paddle.com"

/**
 * Verify a Paddle webhook signature.
 * Header format: `ts=<unix>;h1=<hex hmac>`. The signed payload is `<ts>:<rawBody>`,
 * HMAC-SHA256 keyed with the destination secret, constant-time compared.
 */
export function verifyPaddleSignature(
	rawBody: string,
	signatureHeader: string | undefined,
	secret: string,
	opts: { toleranceSeconds?: number; nowMs?: number } = {},
): boolean {
	if (!signatureHeader || !secret) return false
	const parts: Record<string, string> = {}
	for (const seg of signatureHeader.split(";")) {
		const idx = seg.indexOf("=")
		if (idx === -1) continue
		parts[seg.slice(0, idx).trim()] = seg.slice(idx + 1).trim()
	}
	const ts = parts["ts"]
	const h1 = parts["h1"]
	if (!ts || !h1) return false

	// Optional replay protection.
	const tol = opts.toleranceSeconds
	if (tol && tol > 0) {
		const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000)
		const tsNum = Number(ts)
		if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > tol) return false
	}

	const expected = createHmac("sha256", secret)
		.update(`${ts}:${rawBody}`)
		.digest("hex")
	const a = Buffer.from(expected, "utf8")
	const b = Buffer.from(h1, "utf8")
	if (a.length !== b.length) return false
	return timingSafeEqual(a, b)
}

/** Extract the internal org id from an event's custom_data. */
export function orgIdFromEvent(event: PaddleEvent): string | undefined {
	const cd = event.data?.custom_data
	if (cd && typeof cd === "object") {
		const v = (cd as Record<string, unknown>).org_id
		if (typeof v === "string" && v) return v
	}
	return undefined
}

/** First price id present on the event's line items. */
export function priceIdFromEvent(event: PaddleEvent): string | undefined {
	const items = event.data?.items
	if (!Array.isArray(items)) return undefined
	for (const it of items) {
		const id = it?.price?.id ?? it?.price_id
		if (typeof id === "string" && id) return id
	}
	return undefined
}

/**
 * Resolve the plan an event implies, or undefined if it maps to nothing.
 * - subscription.canceled OR status canceled/paused -> "free"
 * - otherwise map the line-item price id via priceToPlan
 */
export function resolvePlan(
	event: PaddleEvent,
	priceToPlan: Record<string, string>,
): string | undefined {
	const type = event.event_type ?? ""
	if (!type.startsWith("subscription.")) return undefined
	const status = event.data?.status
	if (
		type === "subscription.canceled" ||
		status === "canceled" ||
		status === "paused"
	) {
		return "free"
	}
	const priceId = priceIdFromEvent(event)
	if (priceId && priceToPlan[priceId]) return priceToPlan[priceId]
	return undefined
}

export class PaddleBilling {
	private readonly apiKey: string
	private readonly webhookSecret: string
	private readonly priceToPlan: Record<string, string>
	private readonly apiBase: string
	private readonly fetchImpl: FetchLike
	private readonly toleranceSeconds: number

	constructor(config: PaddleConfig) {
		this.apiKey = config.apiKey
		this.webhookSecret = config.webhookSecret
		this.priceToPlan = config.priceToPlan
		this.apiBase = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "")
		this.fetchImpl = config.fetchImpl ?? defaultFetch
		this.toleranceSeconds = config.toleranceSeconds ?? 5 * 60
	}

	/** Price id for an internal plan name (reverse of priceToPlan). */
	priceForPlan(plan: string): string | undefined {
		for (const [priceId, p] of Object.entries(this.priceToPlan)) {
			if (p === plan) return priceId
		}
		return undefined
	}

	verifySignature(rawBody: string, signatureHeader: string | undefined): boolean {
		return verifyPaddleSignature(rawBody, signatureHeader, this.webhookSecret, {
			toleranceSeconds: this.toleranceSeconds,
		})
	}

	parseEvent(rawBody: string): PaddleEvent {
		return JSON.parse(rawBody) as PaddleEvent
	}

	/**
	 * Verify + apply a webhook. Returns handled=false (caller still 200-acks) for
	 * events we don't care about; throws on invalid signature so the caller 401s.
	 */
	async handleWebhook(
		rawBody: string,
		signatureHeader: string | undefined,
		store: BillingStore,
	): Promise<WebhookResult> {
		if (!this.verifySignature(rawBody, signatureHeader)) {
			throw new Error("invalid paddle signature")
		}
		let event: PaddleEvent
		try {
			event = this.parseEvent(rawBody)
		} catch {
			throw new Error("invalid paddle payload")
		}
		const eventType = event.event_type
		const orgId = orgIdFromEvent(event)
		// Persist the Paddle customer id so we can open the billing portal later.
		const customerId = event.data?.customer_id
		if (orgId && customerId && store.setOrgPaddleCustomer) {
			await store.setOrgPaddleCustomer(orgId, customerId)
		}
		const plan = resolvePlan(event, this.priceToPlan)
		if (!orgId || !plan) {
			return { handled: false, eventType }
		}
		await store.setOrgPlan(orgId, plan)
		return { handled: true, eventType, orgId, plan }
	}

	/**
	 * Create a Paddle transaction (checkout) for a plan, tagging custom_data with
	 * the org id so the resulting webhook can flip the right org.
	 */
	async createCheckout(orgId: string, plan: string): Promise<CheckoutResult> {
		const priceId = this.priceForPlan(plan)
		if (!priceId) {
			throw new Error(`no Paddle price configured for plan "${plan}"`)
		}
		const res = await this.fetchImpl(`${this.apiBase}/transactions`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${this.apiKey}`,
				"content-type": "application/json",
				"Paddle-Version": "1",
			},
			body: JSON.stringify({
				items: [{ price_id: priceId, quantity: 1 }],
				custom_data: { org_id: orgId },
			}),
		})
		if (!res.ok) {
			const text = await res.text().catch(() => "")
			throw new Error(`paddle create transaction failed: ${res.status} ${text}`)
		}
		const json = await res.json()
		const data = json?.data ?? {}
		return {
			transactionId: data.id ?? "",
			checkoutUrl: data.checkout?.url ?? null,
			plan,
			priceId,
		}
	}

	/**
	 * Create a hosted customer-portal session (update card, view invoices,
	 * change/cancel plan). Requires the org's Paddle customer id, which we
	 * capture from subscription webhooks.
	 */
	async createBillingPortal(customerId: string): Promise<{ url: string }> {
		const res = await this.fetchImpl(
			`${this.apiBase}/customers/${encodeURIComponent(customerId)}/portal-sessions`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${this.apiKey}`,
					"content-type": "application/json",
					"Paddle-Version": "1",
				},
				body: JSON.stringify({}),
			},
		)
		if (!res.ok) {
			const text = await res.text().catch(() => "")
			throw new Error(`paddle portal session failed: ${res.status} ${text}`)
		}
		const json = await res.json()
		const general = json?.data?.urls?.general
		const url = general?.overview ?? general?.cancel ?? null
		if (!url) throw new Error("paddle portal session returned no url")
		return { url }
	}
}
