import { describe, it, expect } from "vitest"
import { run, approve, reject, listPendingApprovals } from "../src/run.js"
import {
  ApprovalRequiredError,
  PolicyDeniedError,
  ActionRejectedError,
} from "../src/errors.js"
import { InMemoryLedger } from "../src/ledger.js"
import { idempotencyKey } from "../src/idempotency.js"
import {
  budget,
  rateLimit,
  requireApprovalWhen,
  denyWhen,
} from "../src/policy.js"

function keyFor(tool: string, args: unknown, scope?: string) {
  return idempotencyKey({ tool, args, scope })
}

describe("approval workflow", () => {
  it("parks an action for approval, then runs it once after approve()", async () => {
    const ledger = new InMemoryLedger()
    let executed = 0
    const opts = {
      tool: "refund",
      args: { chargeId: "ch_1", amount: 100_00 },
      scope: "user-1",
      policies: [requireApprovalWhen((c) => (c.args as any).amount > 50_00, "large refund")],
      execute: async () => {
        executed += 1
        return { ok: true }
      },
    }

    await expect(run(ledger, opts)).rejects.toBeInstanceOf(ApprovalRequiredError)
    expect(executed).toBe(0)

    const pending = await listPendingApprovals(ledger)
    expect(pending).toHaveLength(1)

    await approve(ledger, keyFor("refund", opts.args, "user-1"))
    const result = await run(ledger, opts)
    expect(result).toEqual({ ok: true })
    expect(executed).toBe(1)
  })

  it("rejects an action so it never runs", async () => {
    const ledger = new InMemoryLedger()
    let executed = 0
    const opts = {
      tool: "wire",
      args: { amount: 1 },
      scope: "u",
      policies: [requireApprovalWhen(() => true)],
      execute: async () => {
        executed += 1
        return "sent"
      },
    }
    await expect(run(ledger, opts)).rejects.toBeInstanceOf(ApprovalRequiredError)
    await reject(ledger, keyFor("wire", { amount: 1 }, "u"), "too risky")
    await expect(run(ledger, opts)).rejects.toBeInstanceOf(ActionRejectedError)
    expect(executed).toBe(0)
  })
})

describe("deny policy", () => {
  it("blocks an action entirely", async () => {
    const ledger = new InMemoryLedger()
    let executed = 0
    await expect(
      run(ledger, {
        tool: "delete-prod-db",
        args: {},
        policies: [denyWhen(() => true, "never delete prod")],
        execute: async () => {
          executed += 1
          return "boom"
        },
      }),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
    expect(executed).toBe(0)
  })
})

describe("budget policy", () => {
  it("allows spend under the limit and denies over it", async () => {
    const ledger = new InMemoryLedger()
    const spend = (id: string, amount: number) =>
      run(ledger, {
        tool: "charge",
        args: { id },
        scope: "team-1",
        cost: amount,
        policies: [budget({ limit: 100 })],
        execute: async () => amount,
      })

    await spend("a", 60)
    await spend("b", 30) // total 90, ok
    await expect(spend("c", 20)).rejects.toBeInstanceOf(PolicyDeniedError) // 110 > 100
  })

  it("can require approval instead of denying when over budget", async () => {
    const ledger = new InMemoryLedger()
    const spend = (id: string, amount: number) =>
      run(ledger, {
        tool: "charge",
        args: { id },
        scope: "team-2",
        cost: amount,
        policies: [budget({ limit: 50, onExceed: "require_approval" })],
        execute: async () => amount,
      })
    await spend("a", 40)
    await expect(spend("b", 20)).rejects.toBeInstanceOf(ApprovalRequiredError)
  })
})

describe("rate limit policy", () => {
  it("denies after the limit is hit in the window", async () => {
    const ledger = new InMemoryLedger()
    const hit = (id: string) =>
      run(ledger, {
        tool: "email",
        args: { id },
        scope: "user-9",
        policies: [rateLimit({ limit: 2, windowMs: 60_000 })],
        execute: async () => "sent",
      })
    await hit("1")
    await hit("2")
    await expect(hit("3")).rejects.toBeInstanceOf(PolicyDeniedError)
  })
})
