/**
 * Belay DB smoke test — proves the durable stores are REALLY backed by Postgres
 * (Neon), not just in-memory.
 *
 * It runs a tiny workflow with PostgresWorkflowStore, then THROWS AWAY the
 * engine and rebuilds a fresh one against the SAME database (simulating a
 * process crash / redeploy). The workflow resumes from its durable checkpoint,
 * and each side effect runs exactly once — with the state living in Postgres
 * between the two engines.
 *
 * It also pokes the ledger and saga stores so you know all three Phase 1–4
 * tables are wired up.
 *
 * Run it:  pnpm db:smoke   (needs a .env with DATABASE_URL)
 */
import pg from "pg"
import {
  WorkflowEngine,
  defineWorkflow,
  PostgresWorkflowStore,
  PostgresLedger,
  PostgresSagaStore,
} from "../packages/core/src/index.js"

const url = process.env.DATABASE_URL
if (!url) {
  console.error("\u274c DATABASE_URL is not set. Try: node --env-file=.env ... or use pnpm db:smoke")
  process.exit(1)
}

const needsSsl = /sslmode=require|neon\.tech|\.aws\./i.test(url)
const pool = new pg.Pool({
  connectionString: url,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
})

const clock = { t: Date.parse("2026-06-19T10:00:00Z") }
const HOUR = 3600_000
const world = { plans: 0, publishes: 0 }

const flow = defineWorkflow<{ topic: string }, { ok: boolean }>(
  "db-smoke-flow",
  async (ctx, input) => {
    await ctx.step("plan", async () => {
      world.plans++
      console.log(`  \ud83e\udded planned "${input.topic}" (persisted to Postgres)`)
      return { ok: true }
    })
    console.log("  \u23f3 durable sleep 1h ... [SUSPENDS — state now lives in Postgres]")
    await ctx.sleep("cooldown", HOUR)
    await ctx.step("publish", async () => {
      world.publishes++
      console.log("  \ud83d\udce4 published (after resume)")
      return { ok: true }
    })
    return { ok: true }
  },
)

async function ok(label, cond) {
  console.log(`  ${cond ? "\u2705" : "\u274c"} ${label}`)
  if (!cond) process.exitCode = 1
}

async function main() {
  const id = `db-smoke-${Date.now()}`
  const store = new PostgresWorkflowStore(pool)

  console.log("=== connectivity check ===")
  const { rows } = await pool.query("select current_database() as db, version() as v")
  console.log(`  connected to ${rows[0].db}`)
  await ok("server is Postgres", /PostgreSQL/i.test(rows[0].v))

  console.log("\n=== tables present ===")
  const tableNames = [
    "belay_actions",
    "belay_sagas",
    "belay_saga_steps",
    "belay_workflows",
    "belay_workflow_events",
    "belay_workflow_signals",
    "belay_migrations",
  ]
  const { rows: present } = await pool.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name = any($1)`,
    [tableNames],
  )
  const found = new Set(present.map((r) => r.table_name))
  for (const t of tableNames) await ok(`table ${t}`, found.has(t))

  // Touch the ledger + saga stores so we know those backends construct cleanly.
  new PostgresLedger(pool)
  new PostgresSagaStore(pool)

  console.log("\n=== process #1: start workflow, then 'crash' ===")
  const engine1 = new WorkflowEngine({ store, clock: () => clock.t })
  engine1.register(flow)
  let run = await engine1.start("db-smoke-flow", {
    workflowId: id,
    input: { topic: "durable agents" },
  })
  console.log(`  status -> ${run.status}`)
  await ok("suspended on durable sleep", run.status === "suspended")

  console.log("\n=== process #2: fresh engine, same Postgres store ===")
  const engine2 = new WorkflowEngine({ store, clock: () => clock.t })
  engine2.register(flow)
  clock.t += HOUR
  const fired = await engine2.tick()
  run = (await engine2.getRun(id))
  console.log(`  tick fired ${fired} timer(s); status -> ${run?.status}`)
  await ok("completed after resume", run?.status === "completed")

  console.log("\n=== exactly-once across the crash ===")
  console.log(`  plans=${world.plans}  publishes=${world.publishes}`)
  await ok("plan ran exactly once", world.plans === 1)
  await ok("publish ran exactly once", world.publishes === 1)

  console.log("\n=== cleanup (remove this smoke run's rows) ===")
  await pool.query("delete from belay_workflow_events where workflow_id = $1", [id])
  await pool.query("delete from belay_workflow_signals where workflow_id = $1", [id])
  await pool.query("delete from belay_workflows where workflow_id = $1", [id])
  console.log("  removed.")

  console.log(
    process.exitCode
      ? "\n\u274c DB smoke test FAILED — see above."
      : "\n\ud83c\udf89 DB smoke test PASSED — durable workflow survived a crash with state in Postgres.",
  )
}

main()
  .catch((err) => {
    console.error("\n\u274c DB smoke test errored:", err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
