// Persistent dead-letter queue: capture of failed event deliveries + replay.
//   - a failing subscriber is isolated + dead-lettered (never 500s the caller)
//   - a healthy subscriber still runs; an all-success fan-out records nothing
//   - the queue's onDeadLetter fires once retries are exhausted
//   - the service lists/replays/discards, org-scoped; replay clears the row
//   - HTTP: GET /v1/dlq, POST /v1/dlq/:id/replay, and auth is required
import { assert, it, section, summary } from "./_assert"
import { buildServer } from "../src/server"
import { MemStore } from "../src/store"
import { QuorvelCloudService } from "../src/service"
import { InProcessBus } from "../src/bus"
import { InMemoryQueue } from "../src/queue"
import {
    MemDeadLetterStore,
    makeSink,
    resilient,
    type DeadLetterRecord,
    type NamedSubscriber,
} from "../src/deadLetters"
import type { DomainEvent } from "../src/events"

const RL = "QUORVEL_RATE_LIMIT_PER_MIN"
const RL_ANON = "QUORVEL_RATE_LIMIT_ANON_PER_MIN"

function evt(orgId: string, over: Partial<DomainEvent> = {}): DomainEvent {
    return {
        type: "action.created",
        orgId,
        idempotencyKey: "idem-1",
        tool: "refund.issue",
        scope: "sample-agent",
        cost: 1,
        status: "pending",
        at: new Date().toISOString(),
        ...over,
    }
}

let idSeq = 0
const nextId = () => `dlq_${++idSeq}`

const dlRec = (orgId: string, id: string, over: Partial<DeadLetterRecord> = {}): DeadLetterRecord => ({
    id,
    orgId,
    subscriber: "alerts",
    eventType: "action.created",
    payload: evt(orgId),
    attempts: 1,
    error: "boom",
    createdAt: new Date().toISOString(),
    ...over,
})

console.log("belay-cloud-api dead-letter tests")
void (async () => {
    section("MemDeadLetterStore")

    await it("records, lists newest-first, gets and deletes (org-scoped)", async () => {
        const s = new MemDeadLetterStore()
        await s.recordDeadLetter(dlRec("o1", "a", { createdAt: "2026-01-01T00:00:00.000Z" }))
        await s.recordDeadLetter(dlRec("o1", "b", { createdAt: "2026-01-02T00:00:00.000Z" }))
        await s.recordDeadLetter(dlRec("o2", "c", { createdAt: "2026-01-03T00:00:00.000Z" }))
        const list = await s.listDeadLetters("o1")
        assert.equal(list.length, 2)
        assert.equal(list[0].id, "b")
        assert.ok(await s.getDeadLetter("o1", "a"))
        assert.equal(await s.getDeadLetter("o2", "a"), undefined)
        assert.equal(await s.deleteDeadLetter("o1", "a"), true)
        assert.equal(await s.deleteDeadLetter("o1", "a"), false)
        assert.equal((await s.listDeadLetters("o1")).length, 1)
    })

    section("resilient delivery (in-process)")

    await it("isolates a failing subscriber and dead-letters it without throwing", async () => {
        const store = new MemDeadLetterStore()
        let meterRan = 0
        const named: NamedSubscriber[] = [
            { name: "usage-meter", handle: async () => { meterRan++ } },
            { name: "alerts", handle: async () => { throw new Error("slack down") } },
        ]
        const bus = new InProcessBus(resilient(named, makeSink(store, nextId)))
        await bus.publish(evt("o1"))
        assert.equal(meterRan, 1)
        const dl = await store.listDeadLetters("o1")
        assert.equal(dl.length, 1)
        assert.equal(dl[0].subscriber, "alerts")
        assert.ok(dl[0].error.includes("slack down"))
        assert.equal((dl[0].payload as DomainEvent).orgId, "o1")
    })

    await it("records nothing when every subscriber succeeds", async () => {
        const store = new MemDeadLetterStore()
        const named: NamedSubscriber[] = [
            { name: "usage-meter", handle: async () => {} },
            { name: "alerts", handle: async () => {} },
        ]
        const bus = new InProcessBus(resilient(named, makeSink(store, nextId)))
        await bus.publish(evt("o1"))
        assert.equal((await store.listDeadLetters("o1")).length, 0)
    })

    section("InMemoryQueue onDeadLetter")

    await it("fires after a job exhausts its retries", async () => {
        const captured: Array<{ attempts: number; error: string }> = []
        const queue = new InMemoryQueue<DomainEvent>(
            { attempts: 2, backoffMs: 1 },
            (dl) => captured.push({ attempts: dl.attempts, error: dl.error }),
        )
        queue.process(async () => { throw new Error("always fails") })
        await queue.enqueue(evt("o1"))
        await queue.drain()
        assert.equal(captured.length, 1)
        assert.equal(captured[0].attempts, 2)
        assert.ok(captured[0].error.includes("always fails"))
        assert.equal(queue.deadLetters().length, 1)
    })

    section("service DLQ (list / replay / discard)")

    await it("replay re-runs only the failed subscriber, then clears the row", async () => {
        const store = new MemStore()
        const dlq = new MemDeadLetterStore()
        let alertsCalls = 0
        const replay = async (rec: DeadLetterRecord) => {
            if (rec.subscriber !== "alerts") throw new Error("unexpected subscriber")
            alertsCalls++
        }
        const svc = new QuorvelCloudService(store, { deadLetters: dlq, deadLetterReplay: replay })
        const { orgId } = await svc.issueApiKey({})
        await dlq.recordDeadLetter(dlRec(orgId, "x1"))
        assert.equal((await svc.listDeadLetters(orgId)).length, 1)
        const res = await svc.replayDeadLetter(orgId, "x1")
        assert.equal(res.replayed, true)
        assert.equal(alertsCalls, 1)
        assert.equal((await svc.listDeadLetters(orgId)).length, 0)
    })

    await it("replay of a missing id is 404; discard removes without replaying", async () => {
        const store = new MemStore()
        const dlq = new MemDeadLetterStore()
        const svc = new QuorvelCloudService(store, { deadLetters: dlq, deadLetterReplay: async () => {} })
        const { orgId } = await svc.issueApiKey({})
        let code = 0
        try { await svc.replayDeadLetter(orgId, "nope") } catch (e: any) { code = e.statusCode }
        assert.equal(code, 404)
        await dlq.recordDeadLetter(dlRec(orgId, "d1"))
        const res = await svc.discardDeadLetter(orgId, "d1")
        assert.equal(res.discarded, true)
        assert.equal((await svc.listDeadLetters(orgId)).length, 0)
    })

    await it("a failed replay leaves the row in place for another try", async () => {
        const store = new MemStore()
        const dlq = new MemDeadLetterStore()
        const svc = new QuorvelCloudService(store, {
            deadLetters: dlq,
            deadLetterReplay: async () => { throw new Error("still down") },
        })
        const { orgId } = await svc.issueApiKey({})
        await dlq.recordDeadLetter(dlRec(orgId, "r1"))
        let threw = false
        try { await svc.replayDeadLetter(orgId, "r1") } catch { threw = true }
        assert.equal(threw, true)
        assert.equal((await svc.listDeadLetters(orgId)).length, 1)
    })

    section("server (HTTP DLQ)")

    await it("GET /v1/dlq lists, POST /v1/dlq/:id/replay clears the row", async () => {
        process.env[RL] = "0"
        process.env[RL_ANON] = "0"
        const store = new MemStore()
        const dlq = new MemDeadLetterStore()
        const svc = new QuorvelCloudService(store, { deadLetters: dlq, deadLetterReplay: async () => {} })
        const { apiKey, orgId } = await svc.issueApiKey({})
        const app = buildServer(store, { deps: { deadLetters: dlq, deadLetterReplay: async () => {} } })
        await app.ready()
        const headers = { authorization: `Bearer ${apiKey}` }
        try {
            const empty = await app.inject({ method: "GET", url: "/v1/dlq", headers })
            assert.equal(empty.statusCode, 200)
            assert.equal(JSON.parse(empty.body).length, 0)
            await dlq.recordDeadLetter(dlRec(orgId, "h1"))
            const listed = await app.inject({ method: "GET", url: "/v1/dlq", headers })
            const body = JSON.parse(listed.body)
            assert.equal(body.length, 1)
            assert.equal(body[0].id, "h1")
            const replayed = await app.inject({ method: "POST", url: "/v1/dlq/h1/replay", headers })
            assert.equal(replayed.statusCode, 200)
            assert.equal(JSON.parse(replayed.body).replayed, true)
            const after = await app.inject({ method: "GET", url: "/v1/dlq", headers })
            assert.equal(JSON.parse(after.body).length, 0)
        } finally {
            await app.close()
        }
    })

    await it("requires auth: GET /v1/dlq without a key is 401", async () => {
        process.env[RL] = "0"
        process.env[RL_ANON] = "0"
        const store = new MemStore()
        const dlq = new MemDeadLetterStore()
        const app = buildServer(store, { deps: { deadLetters: dlq, deadLetterReplay: async () => {} } })
        await app.ready()
        try {
            const r = await app.inject({ method: "GET", url: "/v1/dlq" })
            assert.equal(r.statusCode, 401)
        } finally {
            await app.close()
        }
    })

    summary()
})()