// Versioned migration runner. Replaces the old "fire every create-table-if-not-
// exists on boot" approach, which silently no-ops once a table exists -- so an
// ALTER or backfill in an edited SQL string would never actually run, with no
// signal that it was skipped.
//
// This runner:
//   - tracks applied migrations in a schema_migrations table (id + checksum),
//   - runs each pending migration exactly once, in order, inside its own
//     transaction (a failure rolls back cleanly and halts the run),
//   - serializes concurrent boots with a Postgres advisory lock,
//   - FAILS LOUDLY if an already-applied migration's SQL has changed (drift),
//     instead of silently ignoring it. Add a NEW migration; never edit an
//     applied one. (Escape hatch: QUORVEL_MIGRATIONS_ALLOW_DRIFT=1 downgrades
//     drift to a warning, for emergencies only.)
import { createHash } from "node:crypto"
import { SCHEMA_SQL } from "./schema"
import { DEAD_LETTERS_SQL } from "./deadLetters"

export interface Migration {
    /** Stable, ordered id, e.g. "0004_add_org_region". Never reuse or rename. */
    id: string
    sql: string
}

const IDEMPOTENCY_SQL = `create table if not exists idempotency_keys (
    org_id text not null,
    idem_key text not null,
    fingerprint text not null,
    method text not null,
    path text not null,
    status_code int,
    response_body jsonb,
    created_at timestamptz not null default now(),
    primary key (org_id, idem_key)
);`

// Ordered, APPEND-ONLY. The three baseline entries reproduce the historical
// boot SQL (all "if not exists"), so they no-op on the existing prod DB and are
// simply recorded as applied on the first run of this runner. Add new schema
// changes as 0004_*, 0005_*, ... and NEVER edit an entry once it has shipped.
export const MIGRATIONS: Migration[] = [
    { id: "0001_baseline_schema", sql: SCHEMA_SQL },
    { id: "0002_idempotency_keys", sql: IDEMPOTENCY_SQL },
    { id: "0003_dead_letters", sql: DEAD_LETTERS_SQL },
]

/** Advisory-lock key so two booting instances can't migrate concurrently. */
export const MIGRATION_LOCK_KEY = 776655

export function migrationChecksum(sql: string): string {
    return createHash("sha256").update(sql).digest("hex")
}

/** Minimal surface satisfied by a pg client (pool.connect()) and the test fake. */
export interface MigrationClient {
    query(text: string, params?: any[]): Promise<{ rows: any[] }>
}

export interface RunMigrationsResult {
    applied: string[]
    skipped: string[]
}

export interface RunMigrationsOptions {
    allowDrift?: boolean
    log?: (msg: string) => void
}

const MIGRATIONS_TABLE_SQL = `create table if not exists schema_migrations (
    id text primary key,
    checksum text not null,
    applied_at timestamptz not null default now()
);`

export async function runMigrations(
    client: MigrationClient,
    migrations: Migration[] = MIGRATIONS,
    opts: RunMigrationsOptions = {},
): Promise<RunMigrationsResult> {
    const log = opts.log ?? (() => {})
    const allowDrift = opts.allowDrift ?? false

    // Guard against duplicate ids in the list itself (a copy-paste hazard).
    const seen = new Set<string>()
    for (const m of migrations) {
        if (seen.has(m.id)) throw new Error(`duplicate migration id "${m.id}"`)
        seen.add(m.id)
    }

    await client.query(MIGRATIONS_TABLE_SQL)
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY])

    const applied: string[] = []
    const skipped: string[] = []
    try {
        const { rows } = await client.query("select id, checksum from schema_migrations")
        const appliedMap = new Map<string, string>()
        for (const r of rows) appliedMap.set(r.id as string, r.checksum as string)

        for (const m of migrations) {
            const checksum = migrationChecksum(m.sql)
            const prev = appliedMap.get(m.id)
            if (prev !== undefined) {
                if (prev !== checksum) {
                    const msg =
                        `migration "${m.id}" has changed since it was applied ` +
                        `(recorded ${prev.slice(0, 12)}..., current ${checksum.slice(0, 12)}...). ` +
                        `Never edit an applied migration -- add a new one instead.`
                    if (!allowDrift) throw new Error(msg)
                    log(`WARNING: ${msg}`)
                }
                skipped.push(m.id)
                continue
            }
            await client.query("BEGIN")
            try {
                await client.query(m.sql)
                await client.query(
                    "insert into schema_migrations (id, checksum) values ($1, $2)",
                    [m.id, checksum],
                )
                await client.query("COMMIT")
            } catch (e) {
                await client.query("ROLLBACK").catch(() => {})
                const reason = e instanceof Error ? e.message : String(e)
                throw new Error(`migration "${m.id}" failed and was rolled back: ${reason}`)
            }
            applied.push(m.id)
            log(`applied migration ${m.id}`)
        }
    } finally {
        await client
            .query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
            .catch(() => {})
    }
    return { applied, skipped }
}