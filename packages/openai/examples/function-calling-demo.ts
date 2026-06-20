// Demo: classic OpenAI function calling (Chat Completions) + Belay.
// This mirrors vercel/ai issue #7261: the model emits duplicate tool calls.
// Belay's dispatcher dedupes them and returns ready-to-send tool messages.
//
//   pnpm tsx examples/function-calling-demo.ts
import { InMemoryLedger, rateLimit } from "belay"
import { createToolRunner } from "../src/index"

const ledger = new InMemoryLedger()
let emailsSent = 0

const runner = createToolRunner(
	ledger,
	{
		sendEmail: ({ to, subject }: { to: string; subject: string }) => {
			emailsSent++
			return { sent: true, to, subject }
		},
	},
	{
		scope: () => "user-42",
		policies: [rateLimit({ limit: 10, windowMs: 60_000 })],
	},
)

// Simulated assistant message with TWO identical tool calls (the bug).
const assistantMessage = {
	role: "assistant",
	tool_calls: [
		{ id: "call_a", type: "function", function: { name: "sendEmail", arguments: JSON.stringify({ to: "guest@hotel.com", subject: "Your booking" }) } },
		{ id: "call_b", type: "function", function: { name: "sendEmail", arguments: JSON.stringify({ to: "guest@hotel.com", subject: "Your booking" }) } },
	],
}

const main = async () => {
	const toolMessages = await runner.runFromMessage(assistantMessage)
	// You'd push these straight back into the conversation:
	//   messages.push(assistantMessage, ...toolMessages)
	console.log("Tool messages returned:", toolMessages.length) // 2 (one per call id)
	console.log("Real emails sent:", emailsSent) // 1 — deduped
	console.log(JSON.stringify(toolMessages, null, 2))
}
main()
