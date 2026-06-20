import { run, ApprovalRequiredError, PolicyDeniedError, listPendingApprovals } from "belay"
import type { Ledger } from "belay"
import {
	type BelayBinding,
	type BelayInvocationContext,
	resolve,
	defaultPendingResult,
	defaultDeniedResult,
} from "./types"

/**
 * Resolve the idempotency key for a parked (awaiting-approval) action. Tries the
 * common error fields, then falls back to the durable approvals inbox
 * (`listPendingApprovals`), whose `.idempotencyKey` is exactly what `approve()`
 * expects. Robust across belay versions/builds.
 */
async function resolvePendingKey(
	err: any,
	ledger: Ledger,
	toolName: string,
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

/** A plain handler for an OpenAI function/tool call (classic function calling). */
export type ToolHandler = (args: any, ctx: { callId?: string }) => unknown | Promise<unknown>

export interface ToolRunnerOptions extends BelayBinding {
	/**
	 * Output message shape. "chat" => Chat Completions `{ role:"tool", tool_call_id, content }`.
	 * "responses" => Responses API `{ type:"function_call_output", call_id, output }`. Default "chat".
	 */
	format?: "chat" | "responses"
	/** How tool results are serialized into the message content. Default: JSON (strings pass through). */
	serialize?: (value: unknown) => string
}

export interface ChatToolMessage {
	role: "tool"
	tool_call_id: string | undefined
	content: string
}
export interface ResponsesToolMessage {
	type: "function_call_output"
	call_id: string | undefined
	output: string
}
export type ToolMessage = ChatToolMessage | ResponsesToolMessage

interface NormalizedCall {
	callId: string | undefined
	name: string
	rawArgs: unknown
}

/** Accept both Chat Completions and Responses tool-call shapes. */
function normalizeToolCall(tc: any): NormalizedCall {
	if (tc && tc.function) {
		// Chat Completions: { id, type:"function", function:{ name, arguments } }
		return { callId: tc.id, name: tc.function.name, rawArgs: tc.function.arguments }
	}
	// Responses API: { call_id, name, arguments, type:"function_call" }
	return { callId: tc?.call_id ?? tc?.id, name: tc?.name, rawArgs: tc?.arguments }
}

function parseArgs(raw: unknown): any {
	if (raw == null) return {}
	if (typeof raw !== "string") return raw
	try {
		return JSON.parse(raw)
	} catch {
		return raw
	}
}

/**
 * Build a Belay-guarded dispatcher for the classic OpenAI function-calling loop
 * (Chat Completions / Responses). You give it your handlers; it consumes the
 * model's `tool_calls` and returns ready-to-send tool messages — with
 * exactly-once dedupe (the documented "model called the same tool twice" bug just
 * works), durable ledger recording, and policy/approval gating built in.
 *
 * ```ts
 * const runner = createToolRunner(ledger, { refund, sendEmail }, {
 *   scope: (a) => `user-${a.userId}`,
 *   policies: [rateLimit({ limit: 5, windowMs: 60_000 })],
 * })
 * const toolMessages = await runner.runToolCalls(assistantMessage.tool_calls)
 * messages.push(assistantMessage, ...toolMessages)
 * ```
 */
export function createToolRunner(
	ledger: Ledger,
	handlers: Record<string, ToolHandler>,
	options: ToolRunnerOptions = {},
) {
	const format = options.format ?? "chat"
	const serialize = options.serialize ?? ((v: unknown) => (typeof v === "string" ? v : JSON.stringify(v)))

	function toMessage(callId: string | undefined, payload: unknown): ToolMessage {
		const content = serialize(payload)
		if (format === "responses") return { type: "function_call_output", call_id: callId, output: content }
		return { role: "tool", tool_call_id: callId, content }
	}

	async function runToolCall(tc: any): Promise<ToolMessage> {
		const { callId, name, rawArgs } = normalizeToolCall(tc)
		const handler = handlers[name]
		const args = parseArgs(rawArgs)
		const ctx: BelayInvocationContext = { toolName: name, callId }
		if (!handler) {
			return toMessage(callId, {
				_belay: "error",
				status: "error",
				message: `No handler registered for tool "${name}".`,
			})
		}
		try {
			const result = await run(ledger, {
				tool: name,
				args,
				scope: resolve(options.scope, args, ctx, "global"),
				cost: resolve(options.cost, args, ctx, 0),
				policies: resolve(options.policies, args, ctx, []),
				execute: () => handler(args, { callId }),
			})
			return toMessage(callId, result)
		} catch (err) {
			if (err instanceof ApprovalRequiredError) {
				const idempotencyKey = await resolvePendingKey(err, ledger, name)
				const info = { toolName: name, args, idempotencyKey, reason: (err as any).reason, callId }
				return toMessage(callId, options.onApprovalRequired ? options.onApprovalRequired(info) : defaultPendingResult(info))
			}
			if (err instanceof PolicyDeniedError) {
				const info = { toolName: name, args, reason: (err as any).reason, callId }
				return toMessage(callId, options.onPolicyDenied ? options.onPolicyDenied(info) : defaultDeniedResult(info))
			}
			throw err
		}
	}

	return {
		/** Guard and execute a single tool call; returns one tool message. */
		runToolCall,
		/** Guard and execute many tool calls; returns one tool message each (order preserved). */
		async runToolCalls(toolCalls: any[]): Promise<ToolMessage[]> {
			const out: ToolMessage[] = []
			for (const tc of toolCalls ?? []) out.push(await runToolCall(tc))
			return out
		},
		/** Convenience: pull `tool_calls` off an assistant chat message and run them. */
		async runFromMessage(message: any): Promise<ToolMessage[]> {
			return this.runToolCalls(message?.tool_calls ?? [])
		},
	}
}

/**
 * Wrap a single handler for manual dispatch (when you route tool calls
 * yourself). Returns a function with the same `(args)` signature that routes
 * through Belay and returns the raw result (or the approval/denied marker).
 */
export function guard(
	ledger: Ledger,
	name: string,
	handler: ToolHandler,
	binding: BelayBinding = {},
): (args: any, ctx?: { callId?: string }) => Promise<unknown> {
	return async (args: any, ctx: { callId?: string } = {}) => {
		const ictx: BelayInvocationContext = { toolName: name, callId: ctx.callId }
		try {
			return await run(ledger, {
				tool: name,
				args,
				scope: resolve(binding.scope, args, ictx, "global"),
				cost: resolve(binding.cost, args, ictx, 0),
				policies: resolve(binding.policies, args, ictx, []),
				execute: () => handler(args, ctx),
			})
		} catch (err) {
			if (err instanceof ApprovalRequiredError) {
				const idempotencyKey = await resolvePendingKey(err, ledger, name)
				const info = { toolName: name, args, idempotencyKey, reason: (err as any).reason }
				return binding.onApprovalRequired ? binding.onApprovalRequired(info) : defaultPendingResult(info)
			}
			if (err instanceof PolicyDeniedError) {
				const info = { toolName: name, args, reason: (err as any).reason }
				return binding.onPolicyDenied ? binding.onPolicyDenied(info) : defaultDeniedResult(info)
			}
			throw err
		}
	}
}
