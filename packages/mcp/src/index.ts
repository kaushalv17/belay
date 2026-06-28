/**
 * @quorvel/mcp — Quorvel reliability adapter for the Model Context Protocol
 * TypeScript SDK (`@modelcontextprotocol/sdk`).
 *
 * Wrap any MCP tool handler so `tools/call` gets exactly-once execution, a
 * durable ledger, budgets, rate limits, and human approval gates — while
 * keeping the native `(args, extra) => CallToolResult` contract. Parked and
 * denied actions come back as valid structured `CallToolResult`s, so MCP
 * clients and agents keep working.
 *
 * Three surfaces, pick what fits:
 *  - `registerQuorvelTool(server, ledger, name, config, handler, binding)` — register a guarded tool in one call.
 *  - `withQuorvelServer(server, ledger, binding)` — guard every tool on a server.
 *  - `withQuorvel` / `withQuorvelAll` / `guard` — wrap definitions or raw handlers yourself.
 */
export {
	guard,
	withQuorvel,
	withQuorvelAll,
	registerQuorvelTool,
	withQuorvelServer,
} from "./tools"

export {
	type CallToolResult,
	type McpContent,
	type McpToolHandler,
	type McpToolConfig,
	type McpToolDefinition,
	type McpToolExtra,
	type McpServerLike,
	type QuorvelBinding,
	type QuorvelInvocationContext,
	type ApprovalPendingInfo,
	type PolicyDeniedInfo,
	type Resolvable,
	resolve,
	resolvePendingKey,
	toCallToolResult,
	defaultPendingResult,
	defaultDeniedResult,
} from "./types"

// Re-export the human-in-the-loop controls so apps can manage the approval
// inbox without importing belay-core directly.
export {
	approve,
	reject,
	listPendingApprovals,
	InMemoryLedger,
	budget,
	rateLimit,
	requireApprovalWhen,
	denyWhen,
} from "@quorvel/core"
export type { LedgerStore as Ledger, Policy } from "@quorvel/core"
