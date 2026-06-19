import type { Pool } from "pg"
import type {
  ActionRecord,
  ActionStatus,
  InsertPendingInput,
  InsertResult,
  LedgerStore,
  Stats,
  StatsFilter,
} from "./ledger.js"

/**
 * A durable, Postgres-backed ledger. Pass a `pg` Pool.
 * Run migrations/001_init.sql and migrations/002_policy.sql first.
 */
export class PostgresLedger implements LedgerStore {
  constructor(private readonly pool: Pool) {}

  async get(key: string): Promise<ActionRecord | undefined> {
    const { rows } = await this.pool.query(SELECT_BY_KEY, [key])
    return rows.length ? mapRow(rows[0]) : undefined
  }

  async insertPending(input: InsertPendingInput): Promise<InsertResult> {
    // ON CONFLICT DO NOTHING makes this atomic: only the first caller for a
    // given key gets a returned row. Everyone else gets zero rows back.
    const { rows } = await this.pool.query(
      `insert into belay_actions (idempotency_key, scope, tool, args, cost, status)
            values ($1, $2, $3, $4, $5, 'pending')
       on conflict (idempotency_key) do nothing
         returning idempotency_key`,
      [input.idempotencyKey, input.scope, input.tool, JSON.stringify(input.args), input.cost ?? 0],
    )
    if (rows.length > 0) return { inserted: true }
    const existing = await this.get(input.idempotencyKey)
    return { inserted: false, existing }
  }

  async markRunning(key: string): Promise<void> {
    await this.pool.query(
      `update belay_actions set status='running', attempts=attempts+1, updated_at=now() where idempotency_key=$1`,
      [key],
    )
  }
  async markSucceeded(key: string, result: unknown): Promise<void> {
    await this.pool.query(
      `update belay_actions set status='succeeded', result=$2, updated_at=now() where idempotency_key=$1`,
      [key, JSON.stringify(result ?? null)],
    )
  }
  async markFailed(key: string, error: string): Promise<void> {
    await this.pool.query(
      `update belay_actions set status='failed', error=$2, updated_at=now() where idempotency_key=$1`,
      [key, error],
    )
  }
  async markAwaitingApproval(key: string, reason: string): Promise<void> {
    await this.setStatus(key, "awaiting_approval", reason)
  }
  async markApproved(key: string): Promise<void> {
    await this.setStatus(key, "approved", null)
  }
  async markRejected(key: string, reason: string): Promise<void> {
    await this.setStatus(key, "rejected", reason)
  }
  async markDenied(key: string, reason: string): Promise<void> {
    await this.setStatus(key, "denied", reason)
  }

  private async setStatus(key: string, status: ActionStatus, reason: string | null): Promise<void> {
    await this.pool.query(
      `update belay_actions set status=$2, reason=$3, updated_at=now() where idempotency_key=$1`,
      [key, status, reason],
    )
  }

  async listByStatus(status: ActionStatus, limit?: number): Promise<ActionRecord[]> {
    const { rows } = await this.pool.query(
      `${SELECT_COLUMNS} from belay_actions where status=$1 order by created_at asc limit $2`,
      [status, limit ?? 100],
    )
    return rows.map(mapRow)
  }

  async stats(filter: StatsFilter): Promise<Stats> {
    const { rows } = await this.pool.query(
      `select count(*)::int as count, coalesce(sum(cost), 0)::float8 as total_cost
         from belay_actions
        where scope is not distinct from $1
          and ($2::text is null or tool = $2)
          and ($3::timestamptz is null or created_at >= $3)
          and status not in ('failed','denied','rejected')`,
      [filter.scope, filter.tool ?? null, filter.since ?? null],
    )
    return { count: rows[0].count, totalCost: rows[0].total_cost }
  }
}

const SELECT_COLUMNS = `select idempotency_key, scope, tool, args, cost, status, result, error, reason, attempts, created_at`
const SELECT_BY_KEY = `${SELECT_COLUMNS} from belay_actions where idempotency_key = $1`

function mapRow(row: Record<string, unknown>): ActionRecord {
  return {
    idempotencyKey: row.idempotency_key as string,
    scope: (row.scope as string | null) ?? null,
    tool: row.tool as string,
    args: row.args,
    cost: Number(row.cost ?? 0),
    status: row.status as ActionStatus,
    result: row.result ?? undefined,
    error: (row.error as string | null) ?? undefined,
    reason: (row.reason as string | null) ?? undefined,
    attempts: Number(row.attempts ?? 0),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
  }
}
