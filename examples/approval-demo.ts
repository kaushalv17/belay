/**
 * Belay Phase 2 demo: an agent tries a big refund. Policy parks it for approval.
 * A human approves it. Only then does it run — exactly once.
 *
 * Run it:  pnpm demo:approval
 */
import { run, approve, listPendingApprovals } from "../packages/core/src/run.js"
import { ApprovalRequiredError } from "../packages/core/src/errors.js"
import { InMemoryLedger } from "../packages/core/src/ledger.js"
import { requireApprovalWhen, budget } from "../packages/core/src/policy.js"
import { idempotencyKey } from "../packages/core/src/idempotency.js"

let refundsIssued = 0
async function issueRefund(chargeId: string, amount: number) {
  refundsIssued += 1
  console.log(`  💸 issuing refund #${refundsIssued} for ${chargeId} ($${amount / 100})`)
  return { ok: true, refundNumber: refundsIssued }
}

async function main() {
  const ledger = new InMemoryLedger()
  const args = { chargeId: "ch_999", amount: 250_00 } // $250 — a big one
  const opts = {
    tool: "refund",
    args,
    scope: "user-42",
    cost: args.amount / 100,
    policies: [
      requireApprovalWhen((c) => (c.args as any).amount > 100_00, "refund over $100"),
      budget({ limit: 1000, windowMs: 24 * 60 * 60 * 1000 }),
    ],
    execute: () => issueRefund(args.chargeId, args.amount),
  }

  console.log("Agent attempts a $250 refund...")
  try {
    await run(ledger, opts)
  } catch (err) {
    if (err instanceof ApprovalRequiredError) {
      console.log(`  ⏸️  parked for approval: ${err.reason}`)
    } else throw err
  }

  const inbox = await listPendingApprovals(ledger)
  console.log(`\nApprovals inbox: ${inbox.length} item(s) waiting`)
  console.log(`Refunds issued so far: ${refundsIssued} (should be 0)\n`)

  console.log("👩‍⚖️  Human approves it...")
  await approve(ledger, idempotencyKey({ tool: "refund", args, scope: "user-42" }))

  console.log("Agent retries the same refund...")
  const result = await run(ledger, opts)
  console.log("  result:", result)
  console.log(`\n🎉 Refunds ACTUALLY issued: ${refundsIssued} (exactly 1, after approval)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
