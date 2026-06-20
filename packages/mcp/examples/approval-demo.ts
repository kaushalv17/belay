/**
 * Example: human-in-the-loop approvals + the durable approvals inbox.
 *
 * A parked action comes back to the model as a structured `CallToolResult`
 * (`_belay: "awaiting_approval"`) instead of throwing — so the agent can tell
 * the user “this needs approval” and keep going. A separate operator surface
 * lists pending actions and approves them; the next identical call then runs
 * exactly once.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
	registerBelayTool,
	InMemoryLedger,
	listPendingApprovals,
	approve,
	requireApprovalWhen,
} from "@belay/mcp"

const ledger = new InMemoryLedger()
const server = new McpServer({ name: "ops", version: "1.0.0" })

registerBelayTool(
	server,
	ledger,
	"delete_account",
	{
		description: "Permanently delete a customer account.",
		inputSchema: { accountId: z.string() },
	},
	async ({ accountId }) => ({
		content: [{ type: "text", text: `Deleted ${accountId}.` }],
		structuredContent: { deleted: accountId },
	}),
	{ policies: [requireApprovalWhen(() => true, "account deletion always needs review")] },
)

// --- operator surface (e.g. an admin dashboard) ---
async function operatorApprovesAll() {
	const pending = await listPendingApprovals(ledger)
	for (const p of pending) {
		console.log(`approving ${p.tool} — ${p.reason}`)
		await approve(ledger, p.idempotencyKey)
	}
}

void operatorApprovesAll
export { server, ledger }
