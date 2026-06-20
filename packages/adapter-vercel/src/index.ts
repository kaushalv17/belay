// @belay/adapter-vercel — reliability layer for Vercel AI SDK tools.
//
// Quick start:
//
//   import { tool } from "ai"
//   import { z } from "zod"
//   import { createBelay } from "@belay/adapter-vercel"
//
//   const belay = createBelay({
//     budget: { maxCostCents: 5_00 },
//     perTool: { refund: { requiresApproval: (a) => a.amountCents > 10_000 } },
//     onEvent: (e) => dashboard.publish(e), // stream into Mission Control
//   })
//
//   const tools = belay.wrap({
//     search: tool({ description: "...", parameters: z.object({ q: z.string() }), execute: async ({ q }) => ... }),
//     refund: tool({ description: "...", parameters: z.object({ amountCents: z.number() }), execute: async (a) => ... }),
//   })
//
//   // pass `tools` straight to generateText / streamText

export { createBelay, withBelay, wrapTool } from "./wrap.js"
export type { Belay, BelayOptions } from "./wrap.js"
export { InMemoryStore } from "./store.js"
export type { ReliabilityStore } from "./store.js"
export { canonicalize, idempotencyKey } from "./canonical.js"
export {
	computeDelay,
	defaultIsRetryable,
	defaultRetry,
	type RetryPolicy,
} from "./retry.js"
export type { Budget, ToolPolicy } from "./policy.js"
export {
	ApprovalRequiredError,
	BelayError,
	BudgetExceededError,
	NonRetryableError,
	RejectedError,
	TimeoutError,
} from "./errors.js"
export type {
	ActionRecord,
	ActionStatus,
	ApprovalRecord,
	Hook,
	LifecycleEvent,
	LifecycleEventType,
	VercelLikeTool,
} from "./types.js"
