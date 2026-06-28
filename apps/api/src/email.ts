// Transactional email via Resend (Phase 6). Dependency-free: uses fetch and the
// Resend REST API. All sends are best-effort and no-op when RESEND_API_KEY is
// unset, so local/dev never tries to send real mail.
//
// Templates: welcome, api_key_created, usage_alert, dunning, receipt.

export interface EmailConfig {
	apiKey?: string
	from?: string
	apiBase?: string
	fetchImpl?: (url: string, init: any) => Promise<any>
}

export interface SendEmailInput {
	to: string | string[]
	subject: string
	html: string
	text?: string
	replyTo?: string
}

export interface SendResult {
	sent: boolean
	id?: string
	skipped?: boolean
	error?: string
}

const DEFAULT_BASE = "https://api.resend.com"

export class Emailer {
	private readonly apiKey?: string
	private readonly from: string
	private readonly apiBase: string
	private readonly fetchImpl: (url: string, init: any) => Promise<any>

	constructor(cfg: EmailConfig = {}) {
		this.apiKey = cfg.apiKey ?? process.env.RESEND_API_KEY
		this.from = cfg.from ?? process.env.EMAIL_FROM ?? "Quorvel <hello@quorvel.tech>"
		this.apiBase = cfg.apiBase ?? DEFAULT_BASE
		this.fetchImpl =
			cfg.fetchImpl ?? ((url, init) => (globalThis as any).fetch(url, init))
	}

	get enabled(): boolean {
		return Boolean(this.apiKey)
	}

	async send(input: SendEmailInput): Promise<SendResult> {
		if (!this.apiKey) return { sent: false, skipped: true }
		try {
			const res = await this.fetchImpl(`${this.apiBase}/emails`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					from: this.from,
					to: Array.isArray(input.to) ? input.to : [input.to],
					subject: input.subject,
					html: input.html,
					text: input.text,
					reply_to: input.replyTo,
				}),
			})
			if (!res.ok) {
				const text = await res.text().catch(() => "")
				return { sent: false, error: `resend ${res.status}: ${text}` }
			}
			const json = await res.json().catch(() => ({}))
			return { sent: true, id: json?.id }
		} catch (err) {
			return { sent: false, error: (err as Error).message }
		}
	}

	// ---- Templates ----

	welcome(to: string, orgName: string): Promise<SendResult> {
		return this.send({
			to,
			subject: "Welcome to Quorvel",
			html: layout(
				`<h1>Welcome to Quorvel</h1><p>Your workspace <b>${esc(orgName)}</b> is ready. Create an API key and track your first agent action.</p><p><a href=\"https://app.quorvel.tech/onboarding\">Start onboarding &rarr;</a></p>`,
			),
		})
	}

	apiKeyCreated(to: string, keyPrefix: string): Promise<SendResult> {
		return this.send({
			to,
			subject: "A new Quorvel API key was created",
			html: layout(
				`<h1>New API key created</h1><p>A key with prefix <code>${esc(keyPrefix)}</code> was just created. If this wasn't you, revoke it in Settings &rarr; API keys immediately.</p>`,
			),
		})
	}

	usageAlert(to: string, used: number, limit: number): Promise<SendResult> {
		const pct = limit > 0 ? Math.round((used / limit) * 100) : 0
		return this.send({
			to,
			subject: `You've used ${pct}% of your Quorvel plan`,
			html: layout(
				`<h1>Usage alert</h1><p>You've used <b>${used}</b> of <b>${limit}</b> actions this period (${pct}%). <a href=\"https://app.quorvel.tech/settings/billing\">Upgrade your plan &rarr;</a></p>`,
			),
		})
	}

	dunning(to: string): Promise<SendResult> {
		return this.send({
			to,
			subject: "Action needed: your Quorvel payment failed",
			html: layout(
				`<h1>Payment failed</h1><p>We couldn't process your latest payment. Please update your card to avoid interruption.</p><p><a href=\"https://app.quorvel.tech/settings/billing\">Update payment method &rarr;</a></p>`,
			),
		})
	}

	receipt(to: string, plan: string, amount: string): Promise<SendResult> {
		return this.send({
			to,
			subject: "Your Quorvel receipt",
			html: layout(
				`<h1>Thanks for your payment</h1><p>Plan: <b>${esc(plan)}</b><br/>Amount: <b>${esc(amount)}</b></p><p>Manage your subscription anytime in the billing portal.</p>`,
			),
		})
	}
}

function esc(s: string): string {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
}

function layout(inner: string): string {
	return `<div style=\"font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#111\">${inner}<hr style=\"margin-top:32px;border:none;border-top:1px solid #eee\"/><p style=\"color:#888;font-size:12px\">Quorvel \u00b7 <a href=\"https://quorvel.tech\">quorvel.tech</a></p></div>`
}
