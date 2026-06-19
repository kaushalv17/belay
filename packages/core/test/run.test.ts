import { describe, it, expect } from "vitest"
import { run, DuplicateInFlightError } from "../src/run.js"
import { InMemoryLedger } from "../src/ledger.js"
import { idempotencyKey } from "../src/idempotency.js"

describe("run (exactly-once execution)", () => {
  it("executes the work only once across duplicate calls", async () => {
    const ledger = new InMemoryLedger()
    let executions = 0
    const call = () =>
      run(ledger, {
        tool: "refund",
        args: { chargeId: "ch_1", amount: 1000 },
        execute: async () => {
          executions += 1
          return { ok: true, n: executions }
        },
      })

    const first = await call()
    const second = await call()
    const third = await call()

    expect(executions).toBe(1)
    expect(first).toEqual({ ok: true, n: 1 })
    // Duplicate calls return the SAME stored result.
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  })

  it("runs separately for different args", async () => {
    const ledger = new InMemoryLedger()
    let executions = 0
    const call = (amount: number) =>
      run(ledger, {
        tool: "refund",
        args: { chargeId: "ch_1", amount },
        execute: async () => {
          executions += 1
          return amount
        },
      })

    await call(1000)
    await call(2000)
    expect(executions).toBe(2)
  })

  it("retries on failure and then succeeds", async () => {
    const ledger = new InMemoryLedger()
    let attempts = 0
    const result = await run(ledger, {
      tool: "flaky",
      args: { id: 1 },
      retries: 3,
      backoffMs: 1,
      execute: async () => {
        attempts += 1
        if (attempts < 3) throw new Error("transient")
        return "ok"
      },
    })
    expect(result).toBe("ok")
    expect(attempts).toBe(3)
  })

  it("throws DuplicateInFlightError when a call is already running", async () => {
    const ledger = new InMemoryLedger()
    // Simulate another worker that claimed the slot but hasn't finished.
    const key = idempotencyKey({ tool: "refund", args: { chargeId: "ch_9" } })
    await ledger.insertPending({
      idempotencyKey: key,
      scope: null,
      tool: "refund",
      args: { chargeId: "ch_9" },
    })

    await expect(
      run(ledger, {
        tool: "refund",
        args: { chargeId: "ch_9" },
        execute: async () => "should not run",
      }),
    ).rejects.toBeInstanceOf(DuplicateInFlightError)
  })

  it("throws after exhausting retries", async () => {
    const ledger = new InMemoryLedger()
    await expect(
      run(ledger, {
        tool: "always-fails",
        args: { id: 1 },
        retries: 2,
        backoffMs: 1,
        execute: async () => {
          throw new Error("nope")
        },
      }),
    ).rejects.toThrow("nope")
  })
})
