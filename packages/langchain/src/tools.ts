import { tool as createLcTool } from "@langchain/core/tools"
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

/**
 * The minimal shape we depend on from a LangChain tool (as produced by
 * `tool(func, { name, description, schema })` from `@langchain/core/tools`).
 * We read `name`/`description`/`schema` to preserve the drop-in contract and
 * call the tool to route the real work through Quorvel.
 */
export interface LangChainToolLike {
	name: string
	description?: string
	schema?: unknown
	func?: (input: any, runManager?: any) => unknown | Promise<unknown>
	invoke: (input: any, config?: any) => Promise<unknown>
	[key: string]: unknown
}

/**
 * Resolve a callable that executes the original tool's work for `args`.
 *
 * IMPORTANT: LangChain's `DynamicStructuredTool.func` has the signature
 * `(input, runManager?, config?)` — the SECOND argument is a callback
 * run-manager, NOT a RunnableConfig. We must therefore call it with `args`
 * ONLY; passing anything as the second argument makes LangChain try to call
 * `runManager.getChild()` and throw. We never have a real run-manager here
 * (Quorvel sits between the model and execution), so `undefined` is correct and
 * safe. For class-based tools without an exposed `func`, we fall back to the
 * public `invoke(args)` (single-arg) which sets up its own run-manager.
 */
function makeExecutor(tool: LangChainToolLike): (args: any) => unknown | Promise<unknown> {
	if (typeof tool.func === "function") {
		const fn = tool.func.bind(tool)
		return (args: any) => fn(args)
	}
	return (args: any) => tool.invoke(args)
}

/**
 * Wrap a single LangChain tool so every invocation flows through Quorvel:
 * exactly-once idempotency, durable ledger, and policy (budgets / rate limits /
 * approval gates). The returned value is a real LangChain `DynamicStructuredTool`
 * with the **same name, description, and schema** — a drop-in you can hand to
 * `bindTools`, a prebuilt `ToolNode`, or `createReactAgent` unchanged.
 *
 * ```ts
 * import { tool } from "@langchain/core/tools"
 * import { PostgresLedger, requireApprovalWhen } from "@quorvel/core"
 * import { withQuorvel } from "@quorvel/langchain"
 *
 * const refund = withQuorvel(ledger, tool(
 *   async ({ chargeId, amount }) => stripe.refunds.create({ charge: chargeId, amount }),
 *   { name: "refund", description: "Refund a charge", schema: refundSchema },
 * ), {
 *   scope: (a) => `user-${a.userId}`,
 *   cost: (a) => a.amount / 100,
 *   policies: [requireApprovalWhen((c) => c.cost > 100, "refund over $100")],
 * })
 * ```
 */
export function withQuorvel<T extends LangChainToolLike>(
	ledger: Ledger,
	tool: T,
	binding: QuorvelBinding = {},
): T {
	const name = tool.name
	const execute = makeExecutor(tool)
	// LangChain calls the wrapped function as (input, runManager?, config?).
	// We accept input only and intentionally ignore the run-manager argument.
	const wrapped = async (args: any) => {
		const ctx: QuorvelInvocationContext = { toolName: name }
		try {
			return await run(ledger, {
				tool: name,
				args,
				scope: resolve(binding.scope, args, ctx, "global"),
				cost: resolve(binding.cost, args, ctx, 0),
				policies: resolve(binding.policies, args, ctx, []),
				execute: async () => execute(args),
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
	return createLcTool(wrapped, {
		name,
		description: tool.description ?? "",
		schema: tool.schema as any,
	}) as unknown as T
}

/** Wrap many LangChain tools at once with the same binding. */
export function withQuorvelAll<T extends LangChainToolLike>(
	ledger: Ledger,
	tools: T[],
	binding: QuorvelBinding = {},
): T[] {
	return tools.map((t) => withQuorvel(ledger, t, binding))
}
