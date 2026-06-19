import { createHash } from "node:crypto"

export interface IdempotencyKeyInput {
  /** The tool/action name, e.g. "refund" or "sendEmail". */
  tool: string
  /** The arguments the agent wants to call the tool with. */
  args: unknown
  /** Optional scope to isolate keys, e.g. a userId or runId. */
  scope?: string
}

/**
 * Canonical JSON: a stable, order-independent string for any value.
 *
 * { a: 1, b: 2 } and { b: 2, a: 1 } MUST produce the same string, otherwise the
 * same logical call would get two different keys (and a double charge).
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`
}

/**
 * Derive a stable idempotency key for a tool call.
 * Same tool + same args + same scope => same key.
 *
 * @returns a SHA-256 hex string.
 */
export function idempotencyKey(input: IdempotencyKeyInput): string {
  const canonical = canonicalize({
    tool: input.tool,
    args: input.args,
    scope: input.scope ?? null,
  })
  return createHash("sha256").update(canonical).digest("hex")
}
