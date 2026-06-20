// belay/openai — Phase 6 Part 2: the OpenAI tool-calls adapter.
//
// Two surfaces, one reliability layer:
//   1. OpenAI Agents SDK (@openai/agents)  → withBelay / withBelayAll
//   2. Classic function calling (Chat Completions / Responses) → createToolRunner / guard
//
// Both route every tool call through Belay's durable turnstile: exactly-once
// idempotency, the action ledger, budgets, rate limits, and human approval gates.

export { withBelay, withBelayAll, type OpenAIAgentTool } from "./agents"
export {
	createToolRunner,
	guard,
	type ToolHandler,
	type ToolRunnerOptions,
	type ToolMessage,
	type ChatToolMessage,
	type ResponsesToolMessage,
} from "./functions"
export {
	type BelayBinding,
	type BelayInvocationContext,
	type Resolvable,
	type ApprovalPendingInfo,
	type PolicyDeniedInfo,
	defaultPendingResult,
	defaultDeniedResult,
} from "./types"

// Re-export the approval-inbox helpers from core so callers can approve/reject
// directly from `belay/openai` without a second import.
export { approve, reject, listPendingApprovals } from "belay"
