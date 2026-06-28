import { ToolMessage } from "@langchain/core/messages"
import { run, ApprovalRequiredError, PolicyDeniedError, listPendingApprovals } from "@quorvel/core"
import type { LedgerStore as Ledger } from "@quorvel/core"
import {
	type QuorvelBinding,
	type QuorvelInvocationContext,
	resolve,
	resolvePendingKey,
	defaultPendingResult,
	defaultDeniedResult,
} from "./types"
import type { LangChainToolLike } from "./tools"

/** A LangChain / LangGraph tool call as it appears on an AIMessage. */
export interface ToolCall {
	name: string
	args: any
	id?: string
	type?: "tool_call"
}

/** A plain handler for a tool call when you don't have a LangChain tool object. */
export type ToolHandler = (args: any, ctx: { callId?: string }) => unknown | Promise<unknown>

export interface ToolRunnerOptions extends QuorvelBinding {
	/** How tool results are serialized into ToolMessage content. Default: JSON (strings pass through). */
	serialize?: (value: unknown) => string
}

function toHandlerMap(
	tools: LangChainToolLike[] | Record<string, ToolHandler>,
): Record<string, ToolHandler> {
	if (!Array.isArray(tools)) return tools
	const map: Record<string, ToolHandler> = {}
	for (const t of tools) {
		map[t.name] =
			typeof t.func === "function"
				? (args: any) => (t.func as (i: any, c?: any) => unknown)(args)
				: (args: any) => t.invoke(args)
	}
	return map
}

/**
 * Build a Quorvel-guarded dispatcher for the LangGraph / LangChain tool-calling
 * loop. Give it your tools (or raw handlers); it consumes an AIMessage's
 * `tool_calls` and returns ready-to-append `ToolMessage`s — with exactly-once
 * dedupe (the "model emitted the same tool call twice" problem just works),
 * durable ledger recording, and policy / approval gating built in.
 *
 * This is the manual-dispatch alternative to wrapping tools with `withQuorvel`
 * and handing them to a prebuilt `ToolNode`; use whichever fits your graph.
 *
 * ```ts
 * const runner = createToolRunner(ledger, [refund, sendEmail], {
 *   scope: (a) => `user-${a.userId}`,
 *   policies: [rateLimit({ limit: 5, windowMs: 60_000 })],
 * })
 * const toolMessages = await runner.runFromMessage(aiMessage)
 * ```
 */
export function createToolRunner(
	ledger: Ledger,
	tools: LangChainToolLike[] | Record<string, ToolHandler>,
	options: ToolRunnerOptions = {},
) {
	const handlers = toHandlerMap(tools)
	const serialize = options.serialize ?? ((v: unknown) => (typeof v === "string" ? v : JSON.stringify(v)))

	async function runToolCall(call: ToolCall): Promise<ToolMessage> {
		const name = call.name
		const args = call.args ?? {}
		const callId = call.id ?? ""
		const handler = handlers[name]
		if (!handler) {
			return new ToolMessage({
				content: serialize({ _belay: "error", status: "error", message: `No handler registered for tool "${name}".` }),
				name,
				tool_call_id: callId,
				status: "error",
			})
		}
		const ctx: QuorvelInvocationContext = { toolName: name, callId }
		try {
			const result = await run(ledger, {
				tool: name,
				args,
				scope: resolve(options.scope, args, ctx, "global"),
				cost: resolve(options.cost, args, ctx, 0),
				policies: resolve(options.policies, args, ctx, []),
				execute: async () => handler(args, { callId }),
			})
			return new ToolMessage({ content: serialize(result), name, tool_call_id: callId })
		} catch (err) {
			if (err instanceof ApprovalRequiredError) {
				const idempotencyKey = await resolvePendingKey(err, ledger, name, listPendingApprovals)
				const info = { toolName: name, args, idempotencyKey, reason: (err as any).reason, callId }
				const payload = options.onApprovalRequired ? options.onApprovalRequired(info) : defaultPendingResult(info)
				return new ToolMessage({ content: serialize(payload), name, tool_call_id: callId })
			}
			if (err instanceof PolicyDeniedError) {
				const info = { toolName: name, args, reason: (err as any).reason, callId }
				const payload = options.onPolicyDenied ? options.onPolicyDenied(info) : defaultDeniedResult(info)
				return new ToolMessage({ content: serialize(payload), name, tool_call_id: callId })
			}
			throw err
		}
	}

	return {
		/** Guard and execute a single tool call; returns one ToolMessage. */
		runToolCall,
		/** Guard and execute many tool calls; returns one ToolMessage each (order preserved). */
		async runToolCalls(calls: ToolCall[]): Promise<ToolMessage[]> {
			const out: ToolMessage[] = []
			for (const call of calls ?? []) out.push(await runToolCall(call))
			return out
		},
		/** Convenience: pull `tool_calls` off an AIMessage and run them. */
		async runFromMessage(message: any): Promise<ToolMessage[]> {
			return this.runToolCalls(message?.tool_calls ?? [])
		},
	}
}

/**
 * Wrap a single raw handler for manual dispatch (when you route tool calls
 * yourself). Returns a function with the same `(args)` signature that routes
 * through Quorvel and returns the raw result (or the approval/denied marker).
 */
export function guard(
	ledger: Ledger,
	name: string,
	handler: ToolHandler,
	binding: QuorvelBinding = {},
): (args: any, ctx?: { callId?: string }) => Promise<unknown> {
	return async (args: any, ctx: { callId?: string } = {}) => {
		const ictx: QuorvelInvocationContext = { toolName: name, callId: ctx.callId }
		try {
			return await run(ledger, {
				tool: name,
				args,
				scope: resolve(binding.scope, args, ictx, "global"),
				cost: resolve(binding.cost, args, ictx, 0),
				policies: resolve(binding.policies, args, ictx, []),
				execute: async () => handler(args, ctx),
			})
		} catch (err) {
			if (err instanceof ApprovalRequiredError) {
				const idempotencyKey = await resolvePendingKey(err, ledger, name, listPendingApprovals)
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
