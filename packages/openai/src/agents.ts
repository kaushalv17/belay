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
 * Resolve the idempotency key for a parked (awaiting-approval) action.
 *
 * Different belay builds expose the key differently on `ApprovalRequiredError`
 * (`.idempotencyKey`, `.key`, ...). Rather than depend on a specific field, we
 * try the common ones, then fall back to the durable approvals inbox
 * (`listPendingApprovals`), whose `.idempotencyKey` is the exact value
 * `approve()` expects. This makes the adapter robust across belay versions.
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

/**
 * The shape of a tool produced by the OpenAI Agents SDK (`@openai/agents`)
 * `tool({ name, description, parameters, execute })`. We only depend on `name`
 * and `execute`; everything else is preserved untouched.
 */
export interface OpenAIAgentTool {
	name: string
	description?: string
	parameters?: unknown
	execute: (args: any, runContext?: any) => unknown | Promise<unknown>
	[key: string]: unknown
}

/**
 * Wrap a single OpenAI Agents SDK tool so every invocation flows through Belay:
 * exactly-once idempotency, durable ledger, policy (budgets / rate limits /
 * approval gates). The returned tool is a drop-in replacement — same name,
 * description, and parameters — so the Agents SDK never knows the difference.
 *
 * ```ts
 * import { tool } from "@openai/agents"
 * import { withBelay } from "@belay/openai"
 *
 * const refund = withBelay(ledger, tool({
 *   name: "refund",
 *   description: "Refund a charge",
 *   parameters: z.object({ chargeId: z.string(), amount: z.number() }),
 *   execute: ({ chargeId, amount }) => stripe.refunds.create({ charge: chargeId, amount }),
 * }), {
 *   scope: (a) => `user-${a.userId}`,
 *   cost: (a) => a.amount / 100,
 *   policies: [requireApprovalWhen((c) => c.cost > 100, "large refund")],
 * })
 * ```
 */
export function withBelay<T extends OpenAIAgentTool>(
	ledger: Ledger,
	tool: T,
	binding: BelayBinding = {},
): T {
	const originalExecute = tool.execute
	const wrappedExecute = async (args: any, runContext?: any) => {
		const ctx: BelayInvocationContext = { toolName: tool.name, runContext }
		try {
			return await run(ledger, {
				tool: tool.name,
				args,
				scope: resolve(binding.scope, args, ctx, "global"),
				cost: resolve(binding.cost, args, ctx, 0),
				policies: resolve(binding.policies, args, ctx, []),
				execute: () => originalExecute(args, runContext),
			})
		} catch (err) {
			if (err instanceof ApprovalRequiredError) {
				const idempotencyKey = await resolvePendingKey(err, ledger, tool.name)
				const info = { toolName: tool.name, args, idempotencyKey, reason: (err as any).reason }
				return binding.onApprovalRequired ? binding.onApprovalRequired(info) : defaultPendingResult(info)
			}
			if (err instanceof PolicyDeniedError) {
				const info = { toolName: tool.name, args, reason: (err as any).reason }
				return binding.onPolicyDenied ? binding.onPolicyDenied(info) : defaultDeniedResult(info)
			}
			throw err
		}
	}
	return { ...tool, execute: wrappedExecute }
}

/** Wrap many Agents SDK tools at once with the same binding. */
export function withBelayAll<T extends OpenAIAgentTool>(
	ledger: Ledger,
	tools: T[],
	binding: BelayBinding = {},
): T[] {
	return tools.map((t) => withBelay(ledger, t, binding))
}
