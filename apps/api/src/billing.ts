// Billing (Part 9). Per-org monthly usage metering with plan quotas, a pluggable
// usage store (memory or Postgres), and an optional Stripe metered-billing
// reporter. The meter doubles as the UsageLimiter the service checks on insert.
import type { DomainEvent } from "./events"
import { defaultFetch, type FetchLike } from "./alerts"

export type { FetchLike } from "./alerts"

export const PLANS: Record<string, number> = {
	free: 1000,
	pro: 100000,
	scale: Infinity,
}

export function planLimit(plan: string | undefined): number {
	if (plan === undefined) return PLANS.free
	return PLANS[plan] ?? PLANS.free
}

export interface PlanFeatures {
  maxAlertRules: number
  retentionDays: number
  maxSeats: number
}

export const PLAN_FEATURES: Record<string, PlanFeatures> = {
  free: { maxAlertRules: 1, retentionDays: 7, maxSeats: 2 },
  pro: { maxAlertRules: 10, retentionDays: 30, maxSeats: 10 },
  scale: { maxAlertRules: Infinity, retentionDays: 365, maxSeats: Infinity },
}

export function planFeatures(plan: string | undefined): PlanFeatures {
  if (plan === undefined) return PLAN_FEATURES.free
  return PLAN_FEATURES[plan] ?? PLAN_FEATURES.free
}
export const NEAR_LIMIT_THRESHOLD = 0.8

export function currentPeriod(now: Date = new Date()): string {
	const y = now.getUTCFullYear()
	const m = String(now.getUTCMonth() + 1).padStart(2, "0")
	return `${y}-${m}`
}

export interface UsageStore {
	increment(orgId: string, period: string, by: number): Promise<number>
	get(orgId: string, period: string): Promise<number>
}

export class MemUsageStore implements UsageStore {
	private counts = new Map<string, number>()
	private key(o: string, p: string): string {
		return `${o}\u0000${p}`
	}
	async increment(orgId: string, period: string, by: number): Promise<number> {
		const k = this.key(orgId, period)
		const next = (this.counts.get(k) ?? 0) + by
		this.counts.set(k, next)
		return next
	}
	async get(orgId: string, period: string): Promise<number> {
		return this.counts.get(this.key(orgId, period)) ?? 0
	}
}

export interface SqlPool {
	query(text: string, params?: unknown[]): Promise<{ rows: any[] }>
}

export class PgUsageStore implements UsageStore {
	constructor(private readonly pool: SqlPool) {}
	async increment(orgId: string, period: string, by: number): Promise<number> {
		const { rows } = await this.pool.query(
			`INSERT INTO usage_counters (org_id, period, count) VALUES ($1,$2,$3)
			 ON CONFLICT (org_id, period) DO UPDATE SET count = usage_counters.count + EXCLUDED.count
			 RETURNING count`,
			[orgId, period, by],
		)
		return Number(rows[0].count)
	}
	async get(orgId: string, period: string): Promise<number> {
		const { rows } = await this.pool.query(
			`SELECT count FROM usage_counters WHERE org_id=$1 AND period=$2`,
			[orgId, period],
		)
		return rows[0] ? Number(rows[0].count) : 0
	}
}

export type PlanLookup = (orgId: string) => Promise<string>

export interface UsageSnapshot {
    plan: string
    period: string
    used: number
    limit: number
    remaining: number
    percentUsed: number
    nearLimit: boolean
    over: boolean
}
export interface UsageVerdict {
	allowed: boolean
	reason?: string
}
export interface UsageLimiter {
    check(orgId: string): Promise<UsageVerdict>
    reserve(orgId: string): Promise<UsageVerdict>
    release(orgId: string): Promise<void>
    usage(orgId: string): Promise<UsageSnapshot>
}
export interface UsageReporter {
	report(orgId: string, value: number): Promise<void>
}

export class UsageMeter implements UsageLimiter {
	constructor(
		private readonly store: UsageStore,
		private readonly plans: PlanLookup,
		private readonly reporter?: UsageReporter,
	) {}

	async check(orgId: string): Promise<UsageVerdict> {
		const plan = await this.plans(orgId)
		const limit = planLimit(plan)
		const used = await this.store.get(orgId, currentPeriod())
		if (used >= limit) {
			return {
				allowed: false,
				reason: `monthly quota of ${limit} reached for plan ${plan}`,
			}
		}
		return { allowed: true }
	}

	async reserve(orgId: string): Promise<UsageVerdict> {
        const plan = await this.plans(orgId)
        const limit = planLimit(plan)
        const period = currentPeriod()
        // Atomically claim a slot; the store returns the post-increment count.
        const next = await this.store.increment(orgId, period, 1)
        if (limit !== Infinity && next > limit) {
            // Over the limit: roll back the reservation and deny.
            await this.store.increment(orgId, period, -1)
            return {
                allowed: false,
                reason: `monthly quota of ${limit} reached for plan ${plan}`,
            }
        }
        return { allowed: true }
    }

    async release(orgId: string): Promise<void> {
        // Refund a previously reserved slot (e.g. an idempotent duplicate).
        await this.store.increment(orgId, currentPeriod(), -1)
    }

    async usage(orgId: string): Promise<UsageSnapshot> {
		const plan = await this.plans(orgId)
		const limit = planLimit(plan)
		const period = currentPeriod()
		const used = await this.store.get(orgId, period)
		const remaining = limit === Infinity ? Infinity : Math.max(0, limit - used)
		const percentUsed = limit === Infinity || limit === 0 ? 0 : Math.min(1, used / limit)
        const over = limit !== Infinity && used >= limit
        const nearLimit = limit !== Infinity && !over && percentUsed >= NEAR_LIMIT_THRESHOLD
        return { plan, period, used, limit, remaining, percentUsed, nearLimit, over }
	}

	onEvent = async (e: DomainEvent): Promise<void> => {
		if (e.type !== "action.created") return
		// counting is atomic in reserve(); onEvent only reports usage
		if (this.reporter) await this.reporter.report(e.orgId, 1)
	}
}

export class StripeMeter implements UsageReporter {
	private readonly eventName: string
	constructor(
		private readonly opts: { secretKey: string; eventName?: string },
		private readonly fetchImpl: FetchLike = defaultFetch,
	) {
		this.eventName = opts.eventName ?? "belay_action"
	}
	async report(orgId: string, value: number): Promise<void> {
		const body = new URLSearchParams()
		body.set("event_name", this.eventName)
		body.set("payload[stripe_customer_id]", orgId)
		body.set("payload[value]", String(value))
		const res = await this.fetchImpl(
			"https://api.stripe.com/v1/billing/meter_events",
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${this.opts.secretKey}`,
					"content-type": "application/x-www-form-urlencoded",
				},
				body: body.toString(),
			},
		)
		if (!res.ok) {
			const text = await res.text().catch(() => "")
			throw new Error(`stripe meter failed: ${res.status} ${text}`)
		}
	}
}
