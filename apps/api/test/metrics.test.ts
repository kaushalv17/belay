import { section, it, summary, assert } from "./_assert"
import { MemActionEventLog, computeMetrics, makeActionEventSink } from "../src/actionEvents"
import type { ActionEvent } from "../src/actionEvents"
import { QuorvelCloudService } from "../src/service"
import { MemStore } from "../src/store"
import { UsageMeter, MemUsageStore } from "../src/billing"
import { handleRequest } from "../src/router"
import type { DomainEvent } from "../src/events"
import type { EventBus } from "../src/bus"

const T0 = "2026-06-01T00:00:00.000Z"

let seq = 0
const mk = (
    key: string,
    type: "created" | "transition",
    status: string,
    at: string,
): ActionEvent => ({
    id: String(++seq),
    orgId: "o1",
    idempotencyKey: key,
    type,
    status: status as ActionEvent["status"],
    attempt: 0,
    reason: null,
    error: null,
    at,
})

const fakeBus = (log: MemActionEventLog): EventBus => {
    const sink = makeActionEventSink(log)
    return { publish: async (ev: DomainEvent) => { await sink(ev) } } as unknown as EventBus
}

section("metrics: computeMetrics aggregator")

await it("derives runs, outcome mix, error rate, and latency percentiles", () => {
    const events: ActionEvent[] = [
        mk("A", "created", "pending", T0),
        mk("A", "transition", "running", "2026-06-01T00:00:00.500Z"),
        mk("A", "transition", "succeeded", "2026-06-01T00:00:01.000Z"),
        mk("B", "created", "pending", T0),
        mk("B", "transition", "failed", "2026-06-01T00:00:02.000Z"),
        mk("C", "created", "pending", T0),
    ]
    const m = computeMetrics(events)
    assert(m.runs === 3, "three runs created")
    assert(m.events === 6, "six events total")
    assert(m.outcomes.succeeded === 1 && m.outcomes.failed === 1, "outcome mix")
    assert(m.terminalRuns === 2, "two terminal runs")
    assert(Math.abs(m.errorRate - 0.5) < 1e-9, "error rate is 0.5")
    assert(m.latencyMs.count === 2, "two latencies (C has no terminal)")
    assert(m.latencyMs.avg === 1500, "avg latency 1500ms")
    assert(m.latencyMs.p50 === 2000, "p50 nearest-rank")
    assert(m.latencyMs.p95 === 2000, "p95 nearest-rank")
})

await it("respects the since/until window and drops orphaned latencies", () => {
    const events: ActionEvent[] = [
        mk("A", "created", "pending", T0),
        mk("A", "transition", "succeeded", "2026-06-01T00:00:01.000Z"),
        mk("B", "created", "pending", T0),
        mk("B", "transition", "failed", "2026-06-01T00:00:02.000Z"),
    ]
    const m = computeMetrics(events, { since: "2026-06-01T00:00:01.500Z" })
    assert(m.runs === 0, "no created events inside the window")
    assert(m.outcomes.failed === 1 && m.outcomes.succeeded === 0, "only the late failure counts")
    assert(m.errorRate === 1, "error rate is 1 with a lone failure")
    assert(m.latencyMs.count === 0, "no latency without an in-window created event")
})

await it("returns zeros and null latencies for an empty set", () => {
    const m = computeMetrics([])
    assert(m.runs === 0 && m.events === 0 && m.terminalRuns === 0, "all zero")
    assert(m.errorRate === 0, "no divide-by-zero")
    assert(m.latencyMs.avg === null && m.latencyMs.p50 === null && m.latencyMs.p95 === null, "null latency")
})

section("metrics: log + service + HTTP")

await it("MemActionEventLog.metrics is org-scoped", async () => {
    const log = new MemActionEventLog()
    await log.append({ orgId: "o1", idempotencyKey: "r1", type: "created", status: "pending", at: T0 })
    await log.append({ orgId: "o1", idempotencyKey: "r1", type: "transition", status: "succeeded", at: "2026-06-01T00:00:01.000Z" })
    await log.append({ orgId: "o2", idempotencyKey: "x", type: "created", status: "pending", at: T0 })
    const m = await log.metrics("o1")
    assert(m.runs === 1, "only org1 runs")
    assert(m.outcomes.succeeded === 1, "succeeded counted")
    assert(m.latencyMs.avg === 1000, "latency 1000ms")
})

await it("service.metrics merges the live usage snapshot", async () => {
    const store = new MemStore()
    const log = new MemActionEventLog()
    const usageStore = new MemUsageStore()
    const meter = new UsageMeter(usageStore, async () => "free")
    const sink = makeActionEventSink(log)
    const bus = {
        publish: async (ev: DomainEvent) => { await sink(ev); await meter.onEvent(ev) },
    } as unknown as EventBus
    const svc = new QuorvelCloudService(store, { bus, actionEventLog: log, limiter: meter })
    await svc.insertPending("o1", { idempotencyKey: "r1", scope: null, tool: "t" })
    await svc.markSucceeded("o1", "r1", { ok: true })
    const m = await svc.metrics("o1", {})
    assert(m.runs === 1, "one run")
    assert(m.outcomes.succeeded === 1, "one success")
    assert(m.usage.plan === "free", "usage plan embedded")
    assert(m.usage.used === 1, "usage counted the created action")
    assert(m.usage.limit === 1000, "free limit")
})

await it("HTTP: GET /v1/metrics returns aggregates + usage", async () => {
    const store = new MemStore()
    const log = new MemActionEventLog()
    const svc = new QuorvelCloudService(store, { bus: fakeBus(log), actionEventLog: log })
    const issued = await svc.issueApiKey({})
    const auth = { authorization: "Bearer " + issued.apiKey }
    const call = (method: string, path: string, body: unknown = null) =>
        handleRequest(svc, "admin", { method, path, query: {}, headers: auth, body })
    await call("POST", "/v1/actions", { idempotencyKey: "r1", tool: "t" })
    await call("POST", "/v1/actions/r1/succeeded", { result: {} })
    const res = await call("GET", "/v1/metrics")
    assert(res.status === 200, "metrics 200")
    const b = res.body as {
        runs: number
        outcomes: { succeeded: number }
        errorRate: number
        usage: { plan: string }
    }
    assert(b.runs === 1, "one run via HTTP")
    assert(b.outcomes.succeeded === 1, "succeeded via HTTP")
    assert(b.errorRate === 0, "no errors")
    assert(b.usage.plan === "free", "usage embedded in HTTP response")
})

section("metrics: plan retention")

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

await it("free plan clamps event history to its 7-day retention", async () => {
    const store = new MemStore()
    const log = new MemActionEventLog()
    await store.insertOrg({ id: "ret1", name: "o", plan: "free", createdAt: daysAgo(999) })
    const svc = new QuorvelCloudService(store, { actionEventLog: log })
    await log.append({ orgId: "ret1", idempotencyKey: "fresh", type: "created", status: "pending", at: daysAgo(2) })
    await log.append({ orgId: "ret1", idempotencyKey: "stale", type: "created", status: "pending", at: daysAgo(30) })
    const events = await svc.listEvents("ret1", {})
    assert(events.length === 1, "only the in-retention event is visible")
    assert(events[0].idempotencyKey === "fresh", "the 30-day-old event is clamped out")
})

await it("a higher plan retains older history", async () => {
    const store = new MemStore()
    const log = new MemActionEventLog()
    await store.insertOrg({ id: "ret2", name: "o", plan: "scale", createdAt: daysAgo(999) })
    const svc = new QuorvelCloudService(store, { actionEventLog: log })
    await log.append({ orgId: "ret2", idempotencyKey: "stale", type: "created", status: "pending", at: daysAgo(30) })
    const events = await svc.listEvents("ret2", {})
    assert(events.length === 1, "scale retention keeps the 30-day-old event")
})

await it("metrics respects the plan retention window", async () => {
    const store = new MemStore()
    const log = new MemActionEventLog()
    await store.insertOrg({ id: "ret3", name: "o", plan: "free", createdAt: daysAgo(999) })
    const svc = new QuorvelCloudService(store, { actionEventLog: log })
    await log.append({ orgId: "ret3", idempotencyKey: "stale", type: "created", status: "pending", at: daysAgo(30) })
    await log.append({ orgId: "ret3", idempotencyKey: "stale", type: "transition", status: "succeeded", at: daysAgo(30) })
    const m = await svc.metrics("ret3", {})
    assert(m.runs === 0, "the stale run is outside the free retention window")
})

summary()