// Belay migration runner — applies every SQL migration in order, exactly once.
//
// Usage:
//   node --env-file=.env scripts/migrate.mjs            # apply pending migrations
//   node --env-file=.env scripts/migrate.mjs --status    # show applied/pending, no changes
//   node --env-file=.env scripts/migrate.mjs --dry-run    # show what WOULD run, no changes
//   node --env-file=.env scripts/migrate.mjs --force      # re-run even if checksum changed
//
// Design:
//   * Discovers packages/core/migrations/*.sql and sorts them lexicographically
//     (001_, 002_, ... so naming controls order).
//   * Tracks applied migrations in a belay_migrations table (name + sha256 + time).
//   * Each migration runs inside its own transaction: all-or-nothing.
//   * Idempotent — already-applied files are skipped. If a file changed after
//     being applied, it aborts (unless --force) so you never silently drift.
import { readFile, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import path from "node:path"
import pg from "pg"

const args = new Set(process.argv.slice(2))
const STATUS = args.has("--status")
const DRY = args.has("--dry-run")
const FORCE = args.has("--force")

const url = process.env.DATABASE_URL
if (!url) {
  console.error("\u274c DATABASE_URL is not set. Try: node --env-file=.env scripts/migrate.mjs")
  process.exit(1)
}

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../packages/core/migrations/", import.meta.url),
)

const sha256 = (s) => createHash("sha256").update(s).digest("hex")

async function loadMigrations() {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort()
  const out = []
  for (const name of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8")
    out.push({ name, sql, checksum: sha256(sql) })
  }
  return out
}

// Neon (and most managed PG) require TLS. sslmode=require in the URL is enough
// for node-postgres, but we set ssl explicitly so it also works on URLs that
// omit it. rejectUnauthorized:false avoids self-signed-chain issues on some
// Windows Node installs; Neon terminates TLS with a valid public cert.
const needsSsl = /sslmode=require|neon\.tech|\.aws\./i.test(url)
const pool = new pg.Pool({
  connectionString: url,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
})

async function ensureTrackingTable(client) {
  await client.query(`
    create table if not exists belay_migrations (
      name        text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )
  `)
}

async function getApplied(client) {
  const { rows } = await client.query(
    "select name, checksum, applied_at from belay_migrations order by name",
  )
  return new Map(rows.map((r) => [r.name, r]))
}

async function main() {
  const client = await pool.connect()
  try {
    await ensureTrackingTable(client)
    const migrations = await loadMigrations()
    const applied = await getApplied(client)

    if (migrations.length === 0) {
      console.log("No migration files found in packages/core/migrations/.")
      return
    }

    if (STATUS) {
      console.log("Belay migrations:\n")
      for (const m of migrations) {
        const a = applied.get(m.name)
        if (!a) console.log(`  \u23f3 PENDING  ${m.name}`)
        else if (a.checksum !== m.checksum)
          console.log(`  \u26a0\ufe0f  CHANGED  ${m.name} (applied copy differs from file)`)
        else
          console.log(`  \u2705 applied  ${m.name}  (${new Date(a.applied_at).toISOString()})`)
      }
      return
    }

    const pending = migrations.filter((m) => {
      const a = applied.get(m.name)
      if (!a) return true
      if (a.checksum !== m.checksum && !FORCE) {
        throw new Error(
          `Migration ${m.name} was already applied but its contents changed.\n` +
            `Refusing to continue. Re-run with --force only if you know what you're doing.`,
        )
      }
      return a.checksum !== m.checksum && FORCE
    })

    if (pending.length === 0) {
      console.log("\u2705 Database is up to date \u2014 nothing to apply.")
      return
    }

    console.log(`Found ${pending.length} migration(s) to apply:\n`)
    for (const m of pending) console.log(`  \u2192 ${m.name}`)
    console.log("")

    if (DRY) {
      console.log("--dry-run: no changes made.")
      return
    }

    for (const m of pending) {
      process.stdout.write(`Applying ${m.name} ... `)
      try {
        await client.query("begin")
        await client.query(m.sql)
        await client.query(
          `insert into belay_migrations (name, checksum) values ($1, $2)
           on conflict (name) do update set checksum = excluded.checksum, applied_at = now()`,
          [m.name, m.checksum],
        )
        await client.query("commit")
        console.log("done")
      } catch (err) {
        await client.query("rollback")
        console.log("FAILED")
        throw err
      }
    }

    console.log(`\n\ud83c\udf89 Applied ${pending.length} migration(s). Belay schema is ready.`)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error(`\n\u274c Migration failed: ${err.message}`)
  process.exit(1)
})
