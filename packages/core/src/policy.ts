import type { LedgerStore } from "./ledger.js"

/** Everything a policy needs to know about the action being attempted. */
export interface ActionContext {
  tool: string
  args: unknown
  scope: string | null
  /** Numeric cost of this action (dollars, tokens, credits — your unit). */
  cost: number
}

export type PolicyDecision =
  | { type: "allow" }
  | { type: "deny"; reason: string }
  | { type: "require_approval"; reason: string }

export interface Policy {
  name: string
  evaluate(
    ctx: ActionContext,
    ledger: LedgerStore,
  ): Promise<PolicyDecision> | PolicyDecision
}

/**
 * Evaluate policies with most-restrictive-wins precedence:
 *   deny  >  require_approval  >  allow
 * The first deny short-circuits. Otherwise the first approval requirement wins.
 */
export async function evaluatePolicies(
  policies: Policy[],
  ctx: ActionContext,
  ledger: LedgerStore,
): Promise<PolicyDecision> {
  let approval: { type: "require_approval"; reason: string } | undefined
  for (const policy of policies) {
    const decision = await policy.evaluate(ctx, ledger)
    if (decision.type === "deny") return decision
    if (decision.type === "require_approval" && !approval) approval = decision
  }
  return approval ?? { type: "allow" }
}

// ---------------------------------------------------------------------------
// Built-in policies
// ---------------------------------------------------------------------------

/** Require human approval whenever the predicate is true. */
export function requireApprovalWhen(
  predicate: (ctx: ActionContext) => boolean,
  reason = "manual approval required",
): Policy {
  return {
    name: "requireApprovalWhen",
    evaluate: (ctx) =>
      predicate(ctx) ? { type: "require_approval", reason } : { type: "allow" },
  }
}

/** Hard-deny whenever the predicate is true. */
export function denyWhen(
  predicate: (ctx: ActionContext) => boolean,
  reason = "denied by policy",
): Policy {
  return {
    name: "denyWhen",
    evaluate: (ctx) =>
      predicate(ctx) ? { type: "deny", reason } : { type: "allow" },
  }
}

export interface BudgetOptions {
  /** Max total cost allowed (per scope) within the window. */
  limit: number
  /** Rolling window in ms. Omit for an all-time budget. */
  windowMs?: number
  /** Restrict the budget to one tool. Omit to budget across all tools. */
  tool?: string
  /** What to do when exceeded. Default "deny". */
  onExceed?: "deny" | "require_approval"
}

/** Cap cumulative cost per scope. e.g. "this agent may refund <= $500/day". */
export function budget(opts: BudgetOptions): Policy {
  return {
    name: "budget",
    async evaluate(ctx, ledger) {
      const since = opts.windowMs
        ? new Date(Date.now() - opts.windowMs).toISOString()
        : null
      const { totalCost } = await ledger.stats({
        scope: ctx.scope,
        tool: opts.tool,
        since,
      })
      const projected = totalCost + ctx.cost
      if (projected > opts.limit) {
        const reason = `budget exceeded for scope ${ctx.scope ?? "(none)"}: ${projected} > ${opts.limit}`
        return opts.onExceed === "require_approval"
          ? { type: "require_approval", reason }
          : { type: "deny", reason }
      }
      return { type: "allow" }
    },
  }
}

export interface RateLimitOptions {
  /** Max number of actions (per scope) within the window. */
  limit: number
  /** Rolling window in ms. */
  windowMs: number
  /** Restrict the limit to one tool. Omit to count across all tools. */
  tool?: string
  /** What to do when exceeded. Default "deny". */
  onExceed?: "deny" | "require_approval"
}

/** Cap how many actions a scope can take in a window. */
export function rateLimit(opts: RateLimitOptions): Policy {
  return {
    name: "rateLimit",
    async evaluate(ctx, ledger) {
      const since = new Date(Date.now() - opts.windowMs).toISOString()
      const { count } = await ledger.stats({
        scope: ctx.scope,
        tool: opts.tool,
        since,
      })
      if (count >= opts.limit) {
        const reason = `rate limit exceeded for scope ${ctx.scope ?? "(none)"}: ${count} >= ${opts.limit} per ${opts.windowMs}ms`
        return opts.onExceed === "require_approval"
          ? { type: "require_approval", reason }
          : { type: "deny", reason }
      }
      return { type: "allow" }
    },
  }
}
