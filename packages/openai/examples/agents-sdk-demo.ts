// Demo: OpenAI Agents SDK + Belay. The agent loops and "retries" a refund;
// Belay guarantees the real refund happens exactly once, and a large refund is
// parked for human approval.
//
//   pnpm tsx examples/agents-sdk-demo.ts
//
// In your real app you'd pass these tools to `new Agent({ tools })`.
import { InMemoryLedger, approve, requireApprovalWhen } from "belay"
import { withBelay } from "../src/index"

const ledger = new InMemoryLedger()
let realRefunds = 0

const refund = withBelay(
	ledger,
	{
		name: "refund",
		description: "Refund a charge",
		execute: ({ chargeId, amount }: { userId: string; chargeId: string; amount: number }) => {
			realRefunds++
			return { ok: true, chargeId, amount }
		},
	},
	{
		scope: (a: { userId: string }) => `user-${a.userId}`,
		cost: (a: { amount: number }) => a.amount / 100,
		policies: [requireApprovalWhen((c) => c.cost > 100, "refund over $100")],
	},
)

const main = async () => {
	// The model calls the same small refund 3 times (loop / retry).
	for (let i = 0; i < 3; i++) await refund.execute({ userId: "42", chargeId: "ch_small", amount: 5000 })
	console.log("Small refund — model attempts: 3, real refunds:", realRefunds) // 1

	// A big refund is parked for approval instead of executing.
	const pending: any = await refund.execute({ userId: "42", chargeId: "ch_big", amount: 20000 })
	console.log("Big refund status:", pending.status, "| real refunds:", realRefunds) // pending_approval | 1

	// A human approves; the next agent turn executes it exactly once.
	await approve(ledger, pending.idempotencyKey)
	await refund.execute({ userId: "42", chargeId: "ch_big", amount: 20000 })
	console.log("After approval — real refunds:", realRefunds) // 2
}
main()
