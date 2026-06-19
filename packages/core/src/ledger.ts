/**
 * The durable ledger: a record of every action Belay has seen, keyed by its
 * idempotency key. It answers "have we already done this?" and powers budgets,
 * rate limits, and the approval queue.
 */

export type ActionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "denied"

export interface ActionRecord {
  idempotencyKey: string
  scope: string | null
  tool: string
  args: unknown
  cost: number
  status: ActionStatus
  result?: unknown
  error?: string
  reason?: string
  attempts: number
  createdAt: string
}

export interface InsertPendingInput {
  idempotencyKey: string
  scope: string | null
  tool: string
  args: unknown
  cost?: number
}

export interface InsertResult {
  /** True if WE created the row. False if a row already existed. */
  inserted: boolean
  existing?: ActionRecord
}

export interface StatsFilter {
  scope: string | null
  tool?: string
  /** ISO timestamp; only count actions created at/after this. Omit for all-time. */
  since?: string | null
}

export interface Stats {
  count: number
  totalCost: number
}

/**
 * Storage backend for the ledger. `insertPending` MUST be atomic: only one
 * caller can win the insert for a given key (this is what prevents two workers
 * both running the action).
 */
export interface LedgerStore {
  get(key: string): Promise<ActionRecord | undefined>
  insertPending(input: InsertPendingInput): Promise<InsertResult>
  markRunning(key: string): Promise<void>
  markSucceeded(key: string, result: unknown): Promise<void>
  markFailed(key: string, error: string): Promise<void>
  markAwaitingApproval(key: string, reason: string): Promise<void>
  markApproved(key: string): Promise<void>
  markRejected(key: string, reason: string): Promise<void>
  markDenied(key: string, reason: string): Promise<void>
  listByStatus(status: ActionStatus, limit?: number): Promise<ActionRecord[]>
  /** Aggregate count + cost of NON-failed actions (excludes failed/denied/rejected). */
  stats(filter: StatsFilter): Promise<Stats>
}

/** Statuses that should NOT count toward budgets / rate limits. */
const NON_COUNTING: ReadonlySet<ActionStatus> = new Set(["failed", "denied", "rejected"])

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
      cost: input.cost ?? 0,
      status: "pending",
      attempts: 0,
      createdAt: new Date().toISOString(),
    })
    return { inserted: true }
  }

  private patch(key: string, fields: Partial<ActionRecord>): void {
    const r = this.store.get(key)
    if (r) Object.assign(r, fields)
  }

  async markRunning(key: string): Promise<void> {
    const r = this.store.get(key)
    if (r) {
      r.status = "running"
      r.attempts += 1
    }
  }
  async markSucceeded(key: string, result: unknown): Promise<void> {
    this.patch(key, { status: "succeeded", result })
  }
  async markFailed(key: string, error: string): Promise<void> {
    this.patch(key, { status: "failed", error })
  }
  async markAwaitingApproval(key: string, reason: string): Promise<void> {
    this.patch(key, { status: "awaiting_approval", reason })
  }
  async markApproved(key: string): Promise<void> {
    this.patch(key, { status: "approved" })
  }
  async markRejected(key: string, reason: string): Promise<void> {
    this.patch(key, { status: "rejected", reason })
  }
  async markDenied(key: string, reason: string): Promise<void> {
    this.patch(key, { status: "denied", reason })
  }

  async listByStatus(status: ActionStatus, limit?: number): Promise<ActionRecord[]> {
    const out: ActionRecord[] = []
    for (const r of this.store.values()) {
      if (r.status === status) out.push(r)
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return typeof limit === "number" ? out.slice(0, limit) : out
  }

  async stats(filter: StatsFilter): Promise<Stats> {
    let count = 0
    let totalCost = 0
    for (const r of this.store.values()) {
      if (r.scope !== filter.scope) continue
      if (filter.tool && r.tool !== filter.tool) continue
      if (filter.since && r.createdAt < filter.since) continue
      if (NON_COUNTING.has(r.status)) continue
      count += 1
      totalCost += r.cost
    }
    return { count, totalCost }
  }
}
