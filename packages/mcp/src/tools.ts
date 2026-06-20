import { run, ApprovalRequiredError, PolicyDeniedError, listPendingApprovals } from "belay"
import type { Ledger } from "belay"
import {
	type BelayBinding,
	type BelayInvocationContext,
	type CallToolResult,
	type McpServerLike,
	type McpToolConfig,
	type McpToolDefinition,
	type McpToolExtra,
	type McpToolHandler,
	resolve,
	resolvePendingKey,
	defaultPendingResult,
	defaultDeniedResult,
} from "./types"

/**
 * Wrap a single MCP tool handler so every `tools/call` routes through Belay:
 * exactly-once execution (the "model called the same tool twice" problem just
 * works), durable ledger recording, budgets / rate limits, and human approval
 * gates. The returned handler keeps the exact MCP `(args, extra) =>
 * CallToolResult` contract, so it is a drop-in for `server.registerTool`.
 *
 * Parked and denied actions are surfaced as valid `CallToolResult`s (a
 * structured marker in both a TextContent block and `structuredContent`) rather
 * than thrown errors, so the agent loop keeps moving and can explain the pause.
 *
 * ```ts
 * server.registerTool("refund", config, guard(ledger, "refund", handler, {
 *   cost: (a) => a.amount,
 *   policies: [requireApprovalWhen((c) => c.cost > 100, "refund over $100")],
 * }))
 * ```
 */
export function guard<A = any>(
	ledger: Ledger,
	name: string,
	handler: McpToolHandler<A>,
	binding: BelayBinding<A> = {},
): McpToolHandler<A> {
	return async (args: A, extra?: McpToolExtra): Promise<CallToolResult> => {
		const ctx: BelayInvocationContext = { toolName: name, extra }
		try {
			return (await run(ledger, {
				tool: name,
				args,
				scope: resolve(binding.scope, args, ctx, "global"),
				cost: resolve(binding.cost, args, ctx, 0),
				policies: resolve(binding.policies, args, ctx, []),
				execute: () => handler(args, extra),
			})) as CallToolResult
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

/**
 * Wrap a portable `{ name, config, handler }` tool definition, returning a new
 * definition with the same name/config and a Belay-guarded handler. Use this
 * when you keep tool definitions in an array and register them in a loop.
 */
export function withBelay<A = any>(
	ledger: Ledger,
	tool: McpToolDefinition<A>,
	binding: BelayBinding<A> = {},
): McpToolDefinition<A> {
	return {
		name: tool.name,
		config: tool.config,
		handler: guard(ledger, tool.name, tool.handler, binding),
	}
}

/** Wrap many tool definitions at once (same binding applied to each). */
export function withBelayAll<A = any>(
	ledger: Ledger,
	tools: McpToolDefinition<A>[],
	binding: BelayBinding<A> = {},
): McpToolDefinition<A>[] {
	return tools.map((t) => withBelay(ledger, t, binding))
}

/**
 * Convenience: register a Belay-guarded tool directly on an `McpServer`. Mirrors
 * `server.registerTool(name, config, handler)` and returns whatever the SDK
 * returns (the `RegisteredTool` handle), so it is a true drop-in.
 *
 * ```ts
 * registerBelayTool(server, ledger, "charge_card", { description, inputSchema }, handler, {
 *   scope: (a) => `user-${a.userId}`,
 * })
 * ```
 */
export function registerBelayTool<A = any>(
	server: McpServerLike,
	ledger: Ledger,
	name: string,
	config: McpToolConfig,
	handler: McpToolHandler<A>,
	binding: BelayBinding<A> = {},
): unknown {
	return server.registerTool(name, config, guard(ledger, name, handler, binding) as McpToolHandler)
}

/**
 * Wrap an entire `McpServer` so that *every* `registerTool` call is
 * automatically Belay-guarded with a shared binding — protect your whole server
 * in one line, no per-tool changes. Returns a transparent proxy: all other
 * methods/properties pass straight through to the real server (preserving its
 * private state), while `registerTool` injects the guard.
 *
 * ```ts
 * const server = withBelayServer(new McpServer(info), ledger, {
 *   policies: [rateLimit({ limit: 100, windowMs: 60_000 })],
 * })
 * server.registerTool("a", cfgA, handlerA) // guarded
 * server.registerTool("b", cfgB, handlerB) // guarded
 * ```
 */
export function withBelayServer<S extends McpServerLike>(
	server: S,
	ledger: Ledger,
	binding: BelayBinding = {},
): S {
	return new Proxy(server, {
		get(target, prop, receiver) {
			if (prop === "registerTool") {
				return (name: string, config: McpToolConfig, handler: McpToolHandler) =>
					target.registerTool(name, config, guard(ledger, name, handler, binding) as McpToolHandler)
			}
			const value = Reflect.get(target, prop, target)
			return typeof value === "function" ? value.bind(target) : value
		},
	}) as S
}
