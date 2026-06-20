/**
 * @belay/langchain — Belay reliability adapter for LangChain JS & LangGraph.
 *
 * Two drop-in surfaces:
 *  - `withBelay` / `withBelayAll`: wrap LangChain tools so they keep their
 *    name/description/schema but route execution through Belay. Hand them to
 *    `bindTools`, a prebuilt `ToolNode`, or `createReactAgent` unchanged.
 *  - `createToolRunner` / `guard`: guard the manual tool-calling loop, turning
 *    an AIMessage's `tool_calls` into ready-to-append `ToolMessage`s.
 *
 * Every surface gives you exactly-once idempotency, a durable action ledger,
 * and policy enforcement (budgets, rate limits, approval gates, hard denies).
 */
export { withBelay, withBelayAll, type LangChainToolLike } from "./tools"
export {
	createToolRunner,
	guard,
	type ToolCall,
	type ToolHandler,
	type ToolRunnerOptions,
} from "./graph"
export {
	type BelayBinding,
	type BelayInvocationContext,
	type Resolvable,
	type ApprovalPendingInfo,
	type PolicyDeniedInfo,
	defaultPendingResult,
	defaultDeniedResult,
} from "./types"

// Re-export the approvals inbox API so callers can resolve parked actions
// without a direct `belay` import.
export { approve, reject, listPendingApprovals } from "belay"
