/**
 * The durable ledger: a record of every action Belay has seen, keyed by its
 * idempotency key. This is what lets us answer "have we already done this?"
 */

export type ActionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "awaiting_approval"

export interface ActionRecord {
  idempotencyKey: string
  scope: string | null
  tool: string
  args: unknown
  status: ActionStatus
  result?: unknown
  error?: string
  attempts: number
}

export interface InsertPendingInput {
  idempotencyKey: string
  scope: string | null
  tool: string
  args: unknown
}

export interface InsertResult {
  /** True if WE created the row. False if a row already existed. */
  inserted: boolean
  /** The pre-existing row, when inserted is false. */
  existing?: ActionRecord
}

/**
 * Storage backend for the ledger. Implement this once per database.
 * `insertPending` MUST be atomic: only one caller can win the insert for a
 * given key (this is what prevents two workers both running the action).
 */
export interface LedgerStore {
  get(key: string): Promise<ActionRecord | undefined>
  insertPending(input: InsertPendingInput): Promise<InsertResult>
  markRunning(key: string): Promise<void>
  markSucceeded(key: string, result: unknown): Promise<void>
  markFailed(key: string, error: string): Promise<void>
}

/**
 * An in-memory ledger. Perfect for tests and local demos.
 * NOT durable — everything is lost when the process exits. Use PostgresLedger
 * for anything real.
 */
export class InMemoryLedger implements LedgerStore {
  private readonly store = new Map<string, ActionRecord>()

  async get(key: string): Promise<ActionRecord | undefined> {
    return this.store.get(key)
  }

  async insertPending(input: InsertPendingInput): Promise<InsertResult> {
    const existing = this.store.get(input.idempotencyKey)
    if (existing) {
      return { inserted: false, existing }
    }
    this.store.set(input.idempotencyKey, {
      idempotencyKey: input.idempotencyKey,
      scope: input.scope,
      tool: input.tool,
      args: input.args,
      status: "pending",
      attempts: 0,
    })
    return { inserted: true }
  }

  async markRunning(key: string): Promise<void> {
    const r = this.store.get(key)
    if (r) {
      r.status = "running"
      r.attempts += 1
    }
  }

  async markSucceeded(key: string, result: unknown): Promise<void> {
    const r = this.store.get(key)
    if (r) {
      r.status = "succeeded"
      r.result = result
    }
  }

  async markFailed(key: string, error: string): Promise<void> {
    const r = this.store.get(key)
    if (r) {
      r.status = "failed"
      r.error = error
    }
  }
}
