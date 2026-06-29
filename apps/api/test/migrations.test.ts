// Versioned migration runner: ordering, run-once, drift detection, rollback,
// advisory-lock discipline. The runner talks to a MigrationClient, so a fake
// in-memory client exercises the full logic with no live Postgres.
import { assert, it, section, summary } from "./_assert"
import {
    migrationChecksum,
    runMigrations,
    MIGRATIONS,
    type Migration,
    type MigrationClient,
} from "../src/migrations"

interface FakeOptions {
    preApplied?: Array<{ id: string; checksum: string }>
    failOnSql?: string
}

class FakeClient implements MigrationClient {
    readonly executed: string[] = []
    readonly applied = new Map<string, string>()
    locked = false
    lockCount = 0
    unlockCount = 0
    private readonly failOnSql?: string

    constructor(opts: FakeOptions = {}) {
        for (const r of opts.preApplied ?? []) this.applied.set(r.id, r.checksum)
        this.failOnSql = opts.failOnSql
    }

    async query(text: string, params?: any[]): Promise<{ rows: any[] }> {
        const t = text.trim()
        if (/^create table if not exists schema_migrations/i.test(t)) return { rows: [] }
        if (/pg_advisory_lock/.test(t)) { this.locked = true; this.lockCount++; return { rows: [] } }
        if (/pg_advisory_unlock/.test(t)) { this.locked = false; this.unlockCount++; return { rows: [] } }
        if (/^select id, checksum from schema_migrations/i.test(t)) {
            return { rows: [...this.applied].map(([id, checksum]) => ({ id, checksum })) }
        }
        if (/^insert into schema_migrations/i.test(t)) {
            const [id, checksum] = params ?? []
            this.applied.set(id as string, checksum as string)
            return { rows: [] }
        }
        if (t === "BEGIN" || t === "COMMIT" || t === "ROLLBACK") return { rows: [] }
        // Anything else is a migration body.
        this.executed.push(t)
        if (this.failOnSql && t === this.failOnSql) throw new Error("simulated SQL failure")
        return { rows: [] }
    }
}

const M = (id: string, sql: string): Migration => ({ id, sql })

console.log("belay-cloud-api migration-runner tests")
void (async () => {
    section("runMigrations (fresh + incremental)")

    await it("applies all migrations in order and records each checksum", async () => {
        const c = new FakeClient()
        const migs = [M("0001_a", "create table a (id text)"), M("0002_b", "create table b (id text)")]
        const res = await runMigrations(c, migs)
        assert.deepEqual(res.applied, ["0001_a", "0002_b"])
        assert.equal(res.skipped.length, 0)
        assert.deepEqual(c.executed, ["create table a (id text)", "create table b (id text)"])
        assert.equal(c.applied.get("0001_a"), migrationChecksum("create table a (id text)"))
        assert.equal(c.applied.size, 2)
    })

    await it("re-running skips already-applied migrations (no silent re-fire)", async () => {
        const migs = [M("0001_a", "create table a (id text)")]
        const c = new FakeClient({
            preApplied: [{ id: "0001_a", checksum: migrationChecksum("create table a (id text)") }],
        })
        const res = await runMigrations(c, migs)
        assert.deepEqual(res.skipped, ["0001_a"])
        assert.equal(res.applied.length, 0)
        assert.equal(c.executed.length, 0)
    })

    await it("runs only the pending migrations when some are applied", async () => {
        const migs = [M("0001_a", "sql-a"), M("0002_b", "sql-b")]
        const c = new FakeClient({ preApplied: [{ id: "0001_a", checksum: migrationChecksum("sql-a") }] })
        const res = await runMigrations(c, migs)
        assert.deepEqual(res.applied, ["0002_b"])
        assert.deepEqual(res.skipped, ["0001_a"])
        assert.deepEqual(c.executed, ["sql-b"])
    })

    section("drift detection")

    await it("throws loudly when an applied migration's SQL changed, and does not re-run it", async () => {
        const migs = [M("0001_a", "NEW sql")]
        const c = new FakeClient({ preApplied: [{ id: "0001_a", checksum: migrationChecksum("OLD sql") }] })
        let msg = ""
        try { await runMigrations(c, migs) } catch (e: any) { msg = e.message }
        assert.ok(msg.includes("has changed since it was applied"))
        assert.equal(c.executed.length, 0)
        assert.equal(c.unlockCount, 1) // lock released even on throw
    })

    await it("downgrades drift to a warning when allowDrift is set", async () => {
        const migs = [M("0001_a", "NEW sql")]
        const c = new FakeClient({ preApplied: [{ id: "0001_a", checksum: migrationChecksum("OLD sql") }] })
        const logs: string[] = []
        const res = await runMigrations(c, migs, { allowDrift: true, log: (m) => logs.push(m) })
        assert.deepEqual(res.skipped, ["0001_a"])
        assert.ok(logs.some((l) => l.includes("WARNING")))
        assert.equal(c.executed.length, 0)
    })

    section("failure + locking")

    await it("a failing migration rolls back, is not recorded, and halts the run", async () => {
        const migs = [M("0001_a", "good"), M("0002_b", "BAD"), M("0003_c", "good3")]
        const c = new FakeClient({ failOnSql: "BAD" })
        let msg = ""
        try { await runMigrations(c, migs) } catch (e: any) { msg = e.message }
        assert.ok(msg.includes("0002_b"))
        assert.ok(msg.includes("rolled back"))
        assert.deepEqual(c.executed, ["good", "BAD"]) // 0003 never attempted
        assert.ok(c.applied.has("0001_a"))
        assert.ok(!c.applied.has("0002_b"))
        assert.equal(c.unlockCount, 1)
    })

    await it("takes the advisory lock once and releases it once", async () => {
        const c = new FakeClient()
        await runMigrations(c, [M("0001_a", "a")])
        assert.equal(c.lockCount, 1)
        assert.equal(c.unlockCount, 1)
        assert.equal(c.locked, false)
    })

    await it("rejects a list with duplicate ids before touching the db", async () => {
        const c = new FakeClient()
        let msg = ""
        try { await runMigrations(c, [M("0001_a", "a"), M("0001_a", "b")]) } catch (e: any) { msg = e.message }
        assert.ok(msg.includes("duplicate migration id"))
        assert.equal(c.lockCount, 0) // failed before locking
    })

    section("real MIGRATIONS list")

    await it("has unique, sorted, non-empty ids and includes the baseline", async () => {
        const ids = MIGRATIONS.map((m) => m.id)
        assert.equal(new Set(ids).size, ids.length)
        assert.deepEqual(ids, [...ids].sort())
        assert.ok(MIGRATIONS.every((m) => m.sql.trim().length > 0))
        assert.ok(ids.includes("0003_dead_letters"))
    })

    summary()
})()