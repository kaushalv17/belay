import { idempotencyKey } from "./idempotency.js"
import type { LedgerStore } from "./ledger.js"

/**
 * Thrown when another caller is already running the same action and it hasn't
 * finished yet. The safe thing to do is NOT run it again — wait and retry later.
 */
export class DuplicateInFlightError extends Error {
  constructor(public readonly key: string) {
    super(`Belay: an action with this idempotency key is already in flight (${key})`)
    this.name = "DuplicateInFlightError"
  }
}

export interface RunOptions<T> {
  /** The tool/action name, e.g. "refund". */
  tool: string
  /** The arguments for this call. */
  args: unknown
  /** Optional scope to isolate keys, e.g. a userId or runId. */
  scope?: string
  /** How many times to retry execute() on failure. Default 0. */
  retries?: number
  /** Base delay (ms) for exponential backoff between retries. Default 100. */
  backoffMs?: number
  /** The real, side-effecting work. Runs AT MOST ONCE across duplicate calls. */
  execute: () => Promise<T>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run a tool call exactly once, durably.
 *
 * Flow:
 *   1. Already succeeded?            -> return the stored result (no re-run).
 *   2. Claim the slot atomically.    -> if someone else holds it, don't double-run.
 *   3. We own it: execute (+retries) -> store the result, return it.
 */
export async function run<T>(ledger: LedgerStore, opts: RunOptions<T>): Promise<T> {
  const key = idempotencyKey({ tool: opts.tool, args: opts.args, scope: opts.scope })

  // 1. Fast path: we've already done this successfully. Return stored result.
  const existing = await ledger.get(key)
  if (existing?.status === "succeeded") {
    return existing.result as T
  }

  // 2. Try to claim the slot. Only one caller can win this insert.
  const claim = await ledger.insertPending({
    idempotencyKey: key,
    scope: opts.scope ?? null,
    tool: opts.tool,
    args: opts.args,
  })
  if (!claim.inserted) {
    const current = claim.existing ?? (await ledger.get(key))
    if (current?.status === "succeeded") {
      return current.result as T
    }
    // Someone else is running it and it isn't done. Do NOT run it again.
    throw new DuplicateInFlightError(key)
  }

  // 3. We own the slot. Execute the real work, with optional retries.
  const retries = opts.retries ?? 0
  const backoffMs = opts.backoffMs ?? 100
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    await ledger.markRunning(key)
    try {
      const result = await opts.execute()
      await ledger.markSucceeded(key, result)
      return result
    } catch (err) {
      lastError = err
      if (attempt < retries) {
        await sleep(backoffMs * 2 ** attempt)
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  await ledger.markFailed(key, message)
  throw lastError
}
