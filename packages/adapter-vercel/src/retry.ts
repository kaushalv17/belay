import { NonRetryableError } from "./errors.js"

export interface RetryPolicy {
	maxAttempts: number
	baseDelayMs: number
	maxDelayMs: number
	jitter: boolean
	isRetryable?: (err: unknown) => boolean
}

export const defaultRetry: RetryPolicy = {
	maxAttempts: 3,
	baseDelayMs: 200,
	maxDelayMs: 5_000,
	jitter: true,
	isRetryable: defaultIsRetryable,
}

// Full-jitter exponential backoff (AWS "Exponential Backoff and Jitter").
// attempt is 1-based: attempt 1 -> base, attempt 2 -> 2x base, capped at max.
export function computeDelay(attempt: number, p: RetryPolicy): number {
	const exp = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** (attempt - 1))
	if (!p.jitter) return exp
	return Math.round(exp / 2 + Math.random() * (exp / 2))
}

// Conservative default classifier: explicit non-retryable wins; common network
// error codes and 429/5xx HTTP statuses are retried; everything else is treated
// as transient (optimistic) since most tool failures are I/O related.
export function defaultIsRetryable(err: unknown): boolean {
	if (err instanceof NonRetryableError) return false
	const code = (err as any)?.code
	if (
		typeof code === "string" &&
		["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "EPIPE"].includes(
			code,
		)
	)
		return true
	const status = (err as any)?.status ?? (err as any)?.statusCode
	if (typeof status === "number") return status === 429 || status >= 500
	return true
}

export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms))
