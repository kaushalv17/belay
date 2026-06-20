/**
 * LangGraph demo: drop a Belay-guarded tool into a prebuilt ToolNode.
 *
 * The tool keeps its name/description/schema, so nothing else in your graph
 * changes — but every execution is now idempotent, durably recorded, and
 * policy-gated. Here a refund over $100 is parked for human approval.
 */
import { tool } from "@langchain/core/tools"
import { AIMessage } from "@langchain/core/messages"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import { InMemoryLedger, approve, requireApprovalWhen } from "belay"
import { withBelay } from "../src/index.ts"

const ledger = new InMemoryLedger()

const refund = withBelay(
	ledger,
	tool(async ({ chargeId, amount }: any) => ({ ok: true, chargeId, amount }), {
		name: "refund",
		description: "Refund a charge",
		schema: {},
	}),
	{
		scope: (a: any) => `customer-${a.chargeId}`,
		cost: (a: any) => a.amount,
		policies: [requireApprovalWhen((c: any) => c.cost > 100, "refund over $100")],
	},
)

const toolNode = new ToolNode([refund])

// The model decides to refund $250 — above the approval threshold.
const aiMessage = new AIMessage({
	content: "",
	tool_calls: [{ name: "refund", args: { chargeId: "ch_123", amount: 250 }, id: "call_1", type: "tool_call" }],
})

const parked = await toolNode.invoke({ messages: [aiMessage] })
console.log("Parked tool message:", parked.messages[0].content)

// A human approves it out-of-band, then the graph re-runs the same call.
const pending = JSON.parse(parked.messages[0].content as string)
await approve(ledger, pending.idempotencyKey)

const settled = await toolNode.invoke({ messages: [aiMessage] })
console.log("After approval:", settled.messages[0].content)
