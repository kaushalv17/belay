import type { Policy } from "belay"

/**
 * A value that can be provided statically, or derived per-call from the tool's
 * arguments and invocation context. This is how you scope budgets/approvals to
 * a specific user, run, or argument shape without re-wrapping the tool.
 */
export type Resolvable<T, A = any> = T | ((args: A, ctx: BelayInvocationContext) => T)

export interface BelayInvocationContext {
	/** The tool/function name as the model called it. */
	toolName: string
	/** The provider tool-call id, when available (OpenAI `tool_call.id` / `call_id`). */
	callId?: string
	/** The framework run context (OpenAI Agents SDK passes one through). */
	runContext?: unknown
}

export interface ApprovalPendingInfo<A = any> {
	toolName: string
	args: A
	idempotencyKey?: string
	reason?: string
	callId?: string
}

export interface PolicyDeniedInfo<A = any> {
	toolName: string
	args: A
	reason?: string
	callId?: string
}

/**
 * Reliability binding shared by every OpenAI adapter surface. You attach this
 * once; Belay derives the idempotency key, enforces policy, and records the
 * action in the durable ledger on every call.
 */
export interface BelayBinding<A = any> {
	/** Logical scope for idempotency + budgets/limits, e.g. `user-${id}`. Default: "global". */
	scope?: Resolvable<string, A>
	/** Cost charged against budgets for this call (e.g. dollars, tokens). Default: 0. */
	cost?: Resolvable<number, A>
	/** Belay policies (budget, rateLimit, requireApprovalWhen, denyWhen). Default: []. */
	policies?: Resolvable<Policy[], A>
	/** Custom result returned to the model when an action is parked for approval. */
	onApprovalRequired?: (info: ApprovalPendingInfo<A>) => unknown
	/** Custom result returned to the model when a policy denies the action. */
	onPolicyDenied?: (info: PolicyDeniedInfo<A>) => unknown
}

export function resolve<T, A>(
	r: Resolvable<T, A> | undefined,
	args: A,
	ctx: BelayInvocationContext,
	fallback: T,
): T {
	if (r === undefined) return fallback
	return typeof r === "function" ? (r as (args: A, ctx: BelayInvocationContext) => T)(args, ctx) : r
}

/**
 * Default tool result the model sees when an action is parked for human
 * approval. It is intentionally structured so the model can explain the pause
 * to the user instead of crashing the agent loop. The real action is durably
 * parked as `awaiting_approval` in the ledger.
 */
export function defaultPendingResult(info: ApprovalPendingInfo): Record<string, unknown> {
	return {
		_belay: "awaiting_approval",
		status: "pending_approval",
		tool: info.toolName,
		idempotencyKey: info.idempotencyKey,
		reason: info.reason,
		message: `The action "${info.toolName}" is paused and needs human approval before it can run. It has been recorded and will execute once approved.`,
	}
}

export function defaultDeniedResult(info: PolicyDeniedInfo): Record<string, unknown> {
	return {
		_belay: "denied",
		status: "blocked",
		tool: info.toolName,
		reason: info.reason,
		message: `The action "${info.toolName}" was blocked by a reliability policy${info.reason ? `: ${info.reason}` : ""}.`,
	}
}
