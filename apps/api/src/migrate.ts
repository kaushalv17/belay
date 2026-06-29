// Applies all pending migrations at boot, via the versioned runner. Uses one
// dedicated client so the advisory lock + per-migration transactions share a
// single session.
import type { Pool } from "pg"
import { MIGRATIONS, runMigrations, type MigrationClient } from "./migrations"

export async function migrate(pool: Pool): Promise<void> {
    const allowDrift = process.env.QUORVEL_MIGRATIONS_ALLOW_DRIFT === "1"
    const client = await pool.connect()
    try {
        const { applied, skipped } = await runMigrations(
            client as unknown as MigrationClient,
            MIGRATIONS,
            { allowDrift, log: (msg) => console.log(`[migrate] ${msg}`) },
        )
        console.log(
            `[migrate] done -- ${applied.length} applied, ${skipped.length} already up to date`,
        )
    } finally {
        client.release()
    }
}