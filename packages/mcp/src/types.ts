import type { Policy } from "@quorvel/core"

/** A single MCP content block (text/image/audio/resource/...). */
export interface McpContent {
	type: string
	text?: string
	[k: string]: unknown
}

/**
 * The MCP `CallToolResult` shape (per the spec): a list of content blocks,
 * optional `structuredContent`, and an `isError` flag. This is what every MCP
 * tool handler resolves to and what Quorvel stores/replays for exactly-once.
 */
export interface CallToolResult {
	content: McpContent[]
	structuredContent?: Record<string, unknown>
	isError?: boolean
	_meta?: Record<string, unknown>
	[k: string]: unknown
}

/** The per-request `extra` object the MCP SDK passes as the 2nd handler arg. */
export interface McpToolExtra {
	signal?: AbortSignal
	requestId?: string | number
	sessionId?: string
	[k: string]: unknown
}

/** An MCP tool handler: `(args, extra) => CallToolResult`. */
export type McpToolHandler<A = any> = (
	args: A,
	extra?: McpToolExtra,
) => CallToolResult | Promise<CallToolResult>

/** The config object passed to `registerTool(name, config, handler)`. */
export interface McpToolConfig {
	title?: string
	description?: string
	inputSchema?: unknown
	outputSchema?: unknown
	annotations?: Record<string, unknown>
	[k: string]: unknown
}

/** A portable `{ name, config, handler }` tool definition. */
export interface McpToolDefinition<A = any> {
	name: string
	config?: McpToolConfig
	handler: McpToolHandler<A>
}

/** The minimal slice of `McpServer` we depend on. Structural typing keeps the
 * SDK an optional peer dependency — any object with a compatible `registerTool`
 * works, and a real `McpServer` assigns cleanly. */
export interface McpServerLike {
	registerTool: (name: string, config: McpToolConfig, handler: McpToolHandler) => unknown
}

/**
 * A value provided statically, or derived per-call from the tool's arguments
 * and invocation context. Lets you scope budgets/approvals to a user, run, or
 * argument shape without re-wrapping the tool.
 */
export type Resolvable<T, A = any> = T | ((args: A, ctx: QuorvelInvocationContext) => T)

export interface QuorvelInvocationContext {
	/** The tool name as registered on the MCP server. */
	toolName: string
	/** The per-request `extra` the MCP SDK passed through, when available. */
	extra?: McpToolExtra
}

export interface ApprovalPendingInfo<A = any> {
	toolName: string
	args: A
	idempotencyKey?: string
	reason?: string
}

export interface PolicyDeniedInfo<A = any> {
	toolName: string
	args: A
	reason?: string
}

/**
 * Reliability binding shared by every MCP adapter surface. Attach it once;
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
	/** Custom CallToolResult returned when an action is parked for approval. */
	onApprovalRequired?: (info: ApprovalPendingInfo<A>) => CallToolResult
	/** Custom CallToolResult returned when a policy denies the action. */
	onPolicyDenied?: (info: PolicyDeniedInfo<A>) => CallToolResult
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

/** Wrap a plain marker object into a valid MCP `CallToolResult`. The marker is
 * serialized into a TextContent block (so any client can read it) and also
 * mirrored into `structuredContent` (per the MCP structured-output spec). */
export function toCallToolResult(marker: Record<string, unknown>, isError: boolean): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(marker) }],
		structuredContent: marker,
		isError,
	}
}

/**
 * Default MCP result when an action is parked for human approval. Returned as a
 * non-error structured result so the model can explain the pause instead of
 * treating it as a failure. The real action is durably parked as
 * `awaiting_approval` and runs once approved.
 */
export function defaultPendingResult(info: ApprovalPendingInfo): CallToolResult {
	return toCallToolResult(
		{
			_belay: "awaiting_approval",
			status: "pending_approval",
			tool: info.toolName,
			idempotencyKey: info.idempotencyKey,
			reason: info.reason,
			message: `The action "${info.toolName}" is paused and needs human approval before it can run. It has been recorded and will execute once approved.`,
		},
		false,
	)
}

/** Default MCP result when a policy blocks the action (flagged `isError`). */
export function defaultDeniedResult(info: PolicyDeniedInfo): CallToolResult {
	return toCallToolResult(
		{
			_belay: "denied",
			status: "blocked",
			tool: info.toolName,
			reason: info.reason,
			message: `The action "${info.toolName}" was blocked by a reliability policy${info.reason ? `: ${info.reason}` : ""}.`,
		},
		true,
	)
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
