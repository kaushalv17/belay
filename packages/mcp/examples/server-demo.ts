/**
 * Example: protect an entire MCP server in one line with `withBelayServer`.
 *
 * Every tool you register is automatically Belay-guarded: exactly-once
 * `tools/call`, durable ledger, rate limiting, and approval gates — with no
 * change to your handlers, which keep returning native `CallToolResult`s.
 *
 * Run it against any MCP client (Claude Desktop, an IDE, the Inspector) over
 * stdio; here we just wire the transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { withBelayServer, InMemoryLedger, rateLimit, requireApprovalWhen } from "@belay/mcp"

const ledger = new InMemoryLedger() // swap for PostgresLedger in production

const server = withBelayServer(new McpServer({ name: "billing", version: "1.0.0" }), ledger, {
	// One binding guards every tool registered below.
	scope: (args: any) => `user-${args.userId ?? "anon"}`,
	cost: (args: any) => args.amountUsd ?? 0,
	policies: [
		rateLimit({ limit: 100, windowMs: 60_000 }),
		requireApprovalWhen((c) => (c.cost as number) > 100, "charge over $100 needs a human"),
	],
})

server.registerTool(
	"charge_card",
	{
		title: "Charge a card",
		description: "Charges the customer's card for the given amount (USD).",
		inputSchema: { userId: z.string(), amountUsd: z.number() },
	},
	async ({ userId, amountUsd }) => {
		const receiptId = await chargeCard(userId, amountUsd) // your real side effect
		return {
			content: [{ type: "text", text: `Charged $${amountUsd} to ${userId} (receipt ${receiptId}).` }],
			structuredContent: { receiptId, userId, amountUsd },
		}
	},
)

async function chargeCard(userId: string, amountUsd: number): Promise<string> {
	return `rcpt_${userId}_${amountUsd}`
}

await server.connect(new StdioServerTransport())
// A repeated tools/call (model retried, client reconnected) now runs once;
// a $500 charge is parked as `awaiting_approval` until you approve() the key.
