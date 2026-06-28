// Simple in-memory fixed-window rate limiter. Good enough to cap abuse on a
// SINGLE instance; for multi-instance deployments back this with Redis
// (INCR + EXPIRE) so the window is shared. See PRODUCTION-RUNBOOK.md (Phase 3).

export interface RateLimitResult {
	allowed: boolean
	limit: number
	remaining: number
	resetMs: number
}

interface Bucket {
	count: number
	resetAt: number
}

export class FixedWindowRateLimiter {
	private readonly hits = new Map<string, Bucket>()

	constructor(
		private readonly max: number,
		private readonly windowMs: number = 60_000,
	) {}

	check(key: string, now: number = Date.now()): RateLimitResult {
		let bucket = this.hits.get(key)
		if (!bucket || now >= bucket.resetAt) {
			bucket = { count: 0, resetAt: now + this.windowMs }
			this.hits.set(key, bucket)
		}
		bucket.count++
		const remaining = Math.max(0, this.max - bucket.count)
		return {
			allowed: bucket.count <= this.max,
			limit: this.max,
			remaining,
			resetMs: bucket.resetAt - now,
		}
	}

	/** Drop expired buckets. Call periodically if the keyspace is large. */
	sweep(now: number = Date.now()): void {
		for (const [k, b] of this.hits) {
			if (now >= b.resetAt) this.hits.delete(k)
		}
	}
}
