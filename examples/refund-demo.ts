/**
 * Belay demo: an agent loops and tries to issue the SAME refund 5 times.
 * Without Belay that's 5 refunds. With Belay the real work runs once.
 *
 * Run it:  pnpm demo
 */
import { run } from "../packages/core/src/run.js"
import { InMemoryLedger } from "../packages/core/src/ledger.js"

// The real side effect we must protect. In real life this calls Stripe.
let refundsIssued = 0
async function issueRefund(chargeId: string, amount: number) {
  refundsIssued += 1
  console.log(`  💸 ACTUALLY issuing refund #${refundsIssued} for ${chargeId} ($${amount / 100})`)
  return { ok: true, chargeId, amount, refundNumber: refundsIssued }
}

async function main() {
  const ledger = new InMemoryLedger()
  const args = { chargeId: "ch_123", amount: 1000 }

  console.log("Agent loops and calls refund 5 times with the SAME args...\n")
  const results = []
  for (let i = 1; i <= 5; i++) {
    console.log(`Call ${i}:`)
    const r = await run(ledger, {
      tool: "refund",
      args,
      scope: "user-42",
      execute: () => issueRefund(args.chargeId, args.amount),
    })
    results.push(r)
  }

  console.log("\nEvery call returned the same result:")
  console.log(results.every((r) => r.refundNumber === 1) ? "  ✅ yes" : "  ❌ no")
  console.log(`\n🎉 Refunds ACTUALLY issued: ${refundsIssued} (should be 1, not 5)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
