import type { Pool } from "pg"
import type {
  ActionRecord,
  InsertPendingInput,
  InsertResult,
  LedgerStore,
} from "./ledger.js"

/**
 * A durable, Postgres-backed ledger. Pass a `pg` Pool.
 * Run the migration in migrations/001_init.sql first.
 */
export class PostgresLedger implements LedgerStore {
  constructor(private readonly pool: Pool) {}

  async get(key: string): Promise<ActionRecord | undefined> {
    const { rows } = await this.pool.query(
      `select idempotency_key, scope, tool, args, status, result, error, attempts
         from belay_actions
        where idempotency_key = $1`,
      [key],
    )
    if (rows.length === 0) return undefined
    return mapRow(rows[0])
  }

  async insertPending(input: InsertPendingInput): Promise<InsertResult> {
    // ON CONFLICT DO NOTHING makes this atomic: only the first caller for a
    // given key gets a returned row. Everyone else gets zero rows back.
    const { rows } = await this.pool.query(
      `insert into belay_actions (idempotency_key, scope, tool, args, status)
            values ($1, $2, $3, $4, 'pending')
       on conflict (idempotency_key) do nothing
         returning idempotency_key`,
      [input.idempotencyKey, input.scope, input.tool, JSON.stringify(input.args)],
    )
    if (rows.length > 0) {
      return { inserted: true }
    }
    const existing = await this.get(input.idempotencyKey)
    return { inserted: false, existing }
  }

  async markRunning(key: string): Promise<void> {
    await this.pool.query(
      `update belay_actions
          set status = 'running', attempts = attempts + 1, updated_at = now()
        where idempotency_key = $1`,
      [key],
    )
  }

  async markSucceeded(key: string, result: unknown): Promise<void> {
    await this.pool.query(
      `update belay_actions
          set status = 'succeeded', result = $2, updated_at = now()
        where idempotency_key = $1`,
      [key, JSON.stringify(result ?? null)],
    )
  }

  async markFailed(key: string, error: string): Promise<void> {
    await this.pool.query(
      `update belay_actions
          set status = 'failed', error = $2, updated_at = now()
        where idempotency_key = $1`,
      [key, error],
    )
  }
}

function mapRow(row: Record<string, unknown>): ActionRecord {
  return {
    idempotencyKey: row.idempotency_key as string,
    scope: (row.scope as string | null) ?? null,
    tool: row.tool as string,
    args: row.args,
    status: row.status as ActionRecord["status"],
    result: row.result ?? undefined,
    error: (row.error as string | null) ?? undefined,
    attempts: row.attempts as number,
  }
}
