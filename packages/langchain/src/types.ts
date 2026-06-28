import type { Policy } from "@quorvel/core"

/**
 * A value provided statically, or derived per-call from the tool's arguments and
 * invocation context. Lets you scope budgets/approvals to a user, run, or
 * argument shape without re-wrapping the tool.
 */
export type Resolvable<T, A = any> = T | ((args: A, ctx: QuorvelInvocationContext) => T)

export interface QuorvelInvocationContext {
	/** The tool name as registered with LangChain / called by the model. */
	toolName: string
	/** The provider tool-call id, when available (LangChain `tool_call.id`). */
	callId?: string
	/** The LangChain/LangGraph RunnableConfig passed through invoke, when present. */
	runConfig?: unknown
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
 * Reliability binding shared by every LangChain adapter surface. Attach it once;
 * Quorvel derives the idempotency key, enforces policy, and records the action in
 * the durable ledger on every call.
 */
export interface QuorvelBinding<A = any> {
	/** Logical scope for idempotency + budgets/limits, e.g. `user-${id}`. Default: "global". */
	scope?: Resolvable<string, A>
	/** Cost charged against budgets for this call (e.g. dollars, tokens). Default: 0. */
	cost?: Resolvable<number, A>
	/** Quorvel policies (budget, rateLimit, requireApprovalWhen, denyWhen). Default: []. */
	policies?: Resolvable<Policy[], A>
	/** Custom result returned to the model when an action is parked for approval. */
	onApprovalRequired?: (info: ApprovalPendingInfo<A>) => unknown
	/** Custom result returned to the model when a policy denies the action. */
	onPolicyDenied?: (info: PolicyDeniedInfo<A>) => unknown
}

export function resolve<T, A>(
	r: Resolvable<T, A> | undefined,
	args: A,
	ctx: QuorvelInvocationContext,
	fallback: T,
): T {
	if (r === undefined) return fallback
	return typeof r === "function" ? (r as (args: A, ctx: QuorvelInvocationContext) => T)(args, ctx) : r
}

/**
 * Default tool result the model sees when an action is parked for human
 * approval. Structured so the model can explain the pause instead of crashing
 * the graph. The real action is durably parked as `awaiting_approval`.
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

/** Resolve the idempotency key for a parked action. Tries common error fields,
 * then falls back to the durable approvals inbox (`listPendingApprovals`), whose
 * `.idempotencyKey` is exactly what `approve()` expects. Robust across belay
 * builds regardless of how `ApprovalRequiredError` exposes the key. */
export async function resolvePendingKey(
	err: any,
	ledger: any,
	toolName: string,
	listPendingApprovals: (ledger: any) => Promise<any[]>,
): Promise<string | undefined> {
	const direct = err?.idempotencyKey ?? err?.key ?? err?.id
	if (direct) return direct
	try {
		const pendings: any[] = (await listPendingApprovals(ledger)) ?? []
		const match = pendings.find((p) => (p?.tool ?? p?.toolName) === toolName)
		return (match ?? pendings[pendings.length - 1])?.idempotencyKey
	} catch {
		return undefined
	}
}
