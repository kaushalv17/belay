/**
 * Manual dispatch demo: guard the tool-calling loop with createToolRunner.
 *
 * Even if the model emits the same tool call twice (a known LLM failure mode),
 * the side effect happens exactly once — the second call replays the recorded
 * result from the ledger.
 */
import { tool } from "@langchain/core/tools"
import { AIMessage } from "@langchain/core/messages"
import { InMemoryLedger, rateLimit } from "belay"
import { createToolRunner } from "../src/index.ts"

const ledger = new InMemoryLedger()

let emailsSent = 0
const sendEmail = tool(
	async ({ to, subject }: any) => {
		emailsSent++
		return { delivered: true, to, subject }
	},
	{ name: "send_email", description: "Send an email", schema: {} },
)

const runner = createToolRunner(ledger, [sendEmail], {
	scope: (a: any) => `to-${a.to}`,
	policies: [rateLimit({ limit: 10, windowMs: 60_000 })],
})

// The model duplicated the same tool call across two turns.
const turn1 = new AIMessage({
	content: "",
	tool_calls: [{ name: "send_email", args: { to: "ceo@corp.com", subject: "Q3" }, id: "a1", type: "tool_call" }],
})
const turn2 = new AIMessage({
	content: "",
	tool_calls: [{ name: "send_email", args: { to: "ceo@corp.com", subject: "Q3" }, id: "a2", type: "tool_call" }],
})

const m1 = await runner.runFromMessage(turn1)
const m2 = await runner.runFromMessage(turn2)

console.log("turn 1:", m1[0].content)
console.log("turn 2:", m2[0].content)
console.log("emails actually sent:", emailsSent) // -> 1
