// Applies the idempotent schema at boot.
import type { Pool } from "pg"
import { SCHEMA_SQL } from "./schema"

// Phase 2 hardening: Idempotency-Key replay store. Kept here (not in schema.ts)
// so it ships as an additive, idempotent migration.
const IDEMPOTENCY_SQL = `
create table if not exists idempotency_keys (
    org_id text not null,
    idem_key text not null,
    fingerprint text not null,
    method text not null,
    path text not null,
    status_code int,
    response_body jsonb,
    created_at timestamptz not null default now(),
    primary key (org_id, idem_key)
);
`

export async function migrate(pool: Pool): Promise<void> {
    await pool.query(SCHEMA_SQL)
    await pool.query(IDEMPOTENCY_SQL)
}