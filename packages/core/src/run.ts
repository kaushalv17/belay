import { idempotencyKey } from "./idempotency.js"
import type { ActionRecord, LedgerStore } from "./ledger.js"
import { evaluatePolicies, type ActionContext, type Policy } from "./policy.js"
import {
  ActionRejectedError,
  ApprovalRequiredError,
  DuplicateInFlightError,
  PolicyDeniedError,
} from "./errors.js"

export {
  ActionRejectedError,
  ApprovalRequiredError,
  DuplicateInFlightError,
  PolicyDeniedError,
} from "./errors.js"

export interface RunOptions<T> {
  /** The tool/action name, e.g. "refund". */
  tool: string
  /** The arguments for this call. */
  args: unknown
  /** Optional scope to isolate keys/budgets, e.g. a userId or runId. */
  scope?: string
  /** Numeric cost of this action, used by budget policies. Default 0. */
  cost?: number
  /** How many times to retry execute() on failure. Default 0. */
  retries?: number
  /** Base delay (ms) for exponential backoff between retries. Default 100. */
  backoffMs?: number
  /** Policies evaluated before the action runs (approval, budgets, rate limits). */
  policies?: Policy[]
  /** The real, side-effecting work. Runs AT MOST ONCE across duplicate calls. */
  execute: () => Promise<T>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run a tool call exactly once, durably, subject to policy.
 *
 * Flow:
 *   1. Look at the existing ledger row (if any) and react to its status.
 *   2. For a new (or previously failed) action, evaluate policies.
 *   3. allow -> execute (+retries).  deny -> record + throw.
 *      require_approval -> park as awaiting_approval + throw.
 *   4. Once a human approves, re-calling run() resumes from "approved".
 */
export async function run<T>(ledger: LedgerStore, opts: RunOptions<T>): Promise<T> {
  const scope = opts.scope ?? null
  const cost = opts.cost ?? 0
  const key = idempotencyKey({ tool: opts.tool, args: opts.args, scope: opts.scope })
  const ctx: ActionContext = { tool: opts.tool, args: opts.args, scope, cost }

  const existing = await ledger.get(key)
  if (existing) {
    switch (existing.status) {
      case "succeeded":
        return existing.result as T
      case "approved":
        // A human approved it. Skip policy and run it.
        return execute(ledger, key, opts)
      case "awaiting_approval":
        throw new ApprovalRequiredError(key, existing.reason ?? "approval required")
      case "rejected":
        throw new ActionRejectedError(key, existing.reason ?? null)
      case "denied":
        throw new PolicyDeniedError(key, existing.reason ?? "denied by policy")
      case "pending":
      case "running":
        throw new DuplicateInFlightError(key)
      case "failed":
        // Terminal-but-retryable: fall through to evaluate + run again.
        break
    }
  }

  // Evaluate policy BEFORE claiming the slot, so this action doesn't count
  // toward its own budget / rate limit.
  const decision = await evaluatePolicies(opts.policies ?? [], ctx, ledger)

  if (!existing) {
    const claim = await ledger.insertPending({
      idempotencyKey: key,
      scope,
      tool: opts.tool,
      args: opts.args,
      cost,
    })
    if (!claim.inserted) {
      const current = claim.existing ?? (await ledger.get(key))
      if (current?.status === "succeeded") return current.result as T
      throw new DuplicateInFlightError(key)
    }
  }

  if (decision.type === "deny") {
    await ledger.markDenied(key, decision.reason)
    throw new PolicyDeniedError(key, decision.reason)
  }
  if (decision.type === "require_approval") {
    await ledger.markAwaitingApproval(key, decision.reason)
    throw new ApprovalRequiredError(key, decision.reason)
  }

  return execute(ledger, key, opts)
}

async function execute<T>(
  ledger: LedgerStore,
  key: string,
  opts: RunOptions<T>,
): Promise<T> {
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
      if (attempt < retries) await sleep(backoffMs * 2 ** attempt)
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  await ledger.markFailed(key, message)
  throw lastError
}

// ---------------------------------------------------------------------------
// Approval workflow — call these from your API / dashboard / Slack handler.
// ---------------------------------------------------------------------------

/** Approve a parked action. The next run() with the same args will execute it. */
export async function approve(ledger: LedgerStore, key: string): Promise<void> {
  const rec = await ledger.get(key)
  if (!rec) throw new Error(`Belay: no action found for key ${key}`)
  if (rec.status !== "awaiting_approval") {
    throw new Error(`Belay: action ${key} is not awaiting approval (status: ${rec.status})`)
  }
  await ledger.markApproved(key)
}

/** Reject a parked action. The next run() with the same args will throw. */
export async function reject(
  ledger: LedgerStore,
  key: string,
  reason = "rejected by reviewer",
): Promise<void> {
  const rec = await ledger.get(key)
  if (!rec) throw new Error(`Belay: no action found for key ${key}`)
  if (rec.status !== "awaiting_approval") {
    throw new Error(`Belay: action ${key} is not awaiting approval (status: ${rec.status})`)
  }
  await ledger.markRejected(key, reason)
}

/** List actions waiting for a human decision (powers an approvals inbox). */
export function listPendingApprovals(
  ledger: LedgerStore,
  limit?: number,
): Promise<ActionRecord[]> {
  return ledger.listByStatus("awaiting_approval", limit)
}
