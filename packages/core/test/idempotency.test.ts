import { describe, it, expect } from "vitest"
import { idempotencyKey } from "../src/idempotency.js"

describe("idempotencyKey", () => {
  it("is stable for the same input", () => {
    const a = idempotencyKey({ tool: "refund", args: { amount: 10, user: "x" } })
    const b = idempotencyKey({ tool: "refund", args: { amount: 10, user: "x" } })
    expect(a).toBe(b)
  })

  it("ignores argument key order", () => {
    const a = idempotencyKey({ tool: "refund", args: { amount: 10, user: "x" } })
    const b = idempotencyKey({ tool: "refund", args: { user: "x", amount: 10 } })
    expect(a).toBe(b)
  })

  it("differs when the tool, args, or scope differ", () => {
    const base = idempotencyKey({ tool: "refund", args: { amount: 10 } })
    expect(idempotencyKey({ tool: "charge", args: { amount: 10 } })).not.toBe(base)
    expect(idempotencyKey({ tool: "refund", args: { amount: 11 } })).not.toBe(base)
    expect(
      idempotencyKey({ tool: "refund", args: { amount: 10 }, scope: "user-2" }),
    ).not.toBe(base)
  })
})
