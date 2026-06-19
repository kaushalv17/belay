// Applies the Belay schema to your Postgres database.
// Usage:  node --env-file=.env scripts/migrate.mjs
import { readFile } from "node:fs/promises"
import pg from "pg"

const url = process.env.DATABASE_URL
if (!url) {
  console.error("❌ DATABASE_URL is not set. Try: node --env-file=.env scripts/migrate.mjs")
  process.exit(1)
}

const sql = await readFile(
  new URL("../packages/core/migrations/001_init.sql", import.meta.url),
  "utf8",
)

const pool = new pg.Pool({ connectionString: url })
try {
  await pool.query(sql)
  console.log("✅ Belay schema applied.")
} finally {
  await pool.end()
}
