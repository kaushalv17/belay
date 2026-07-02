// Contract tests for the dashboard's QuorvelClient. A fake fetch records every
// request and returns canned responses, so we verify URLs, methods, auth
// headers, bodies, and response/error parsing with zero network and zero deps.
import { assert, it, section, summary } from "./_assert"
import { QuorvelApiError, QuorvelClient, groupByScope, type ActionRecord, type FetchInit, type FetchResponse } from "../lib/quorvel"

interface Recorded {
	url: string
	init?: FetchInit
}

function fakeFetch(handler: (rec: Recorded) => { status: number; body?: unknown }) {
	const calls: Recorded[] = []
	const fetchImpl = async (url: string, init?: FetchInit): Promise<FetchResponse> => {
		const rec = { url, init }
		calls.push(rec)
		const { status, body } = handler(rec)
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
			text: async () => JSON.stringify(body ?? ""),
		}
	}
	return { fetchImpl, calls }
}

const action = (over: Partial<ActionRecord> = {}): ActionRecord => ({
	idempotencyKey: "k1",
	scope: "agent-a",
	tool: "refund",
	args: null,
	cost: 1,
	status: "awaiting_approval",
	attempts: 0,
	createdAt: "2026-01-01T00:00:00.000Z",
	...over,
})

console.log("belay-dashboard lib tests")

void (async () => {
	section("QuorvelClient")

	await it("sends Bearer auth + JSON content-type and strips trailing slash", async () => {
		const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: [] }))
		const client = new QuorvelClient({ baseUrl: "https://api.example.com/", apiKey: "qrv_live_x", fetchImpl })
		await client.listRecent()
		assert.equal(calls[0].url, "https://api.example.com/v1/actions?limit=50")
		assert.equal(calls[0].init?.headers?.["authorization"], "Bearer qrv_live_x")
		assert.equal(calls[0].init?.headers?.["content-type"], "application/json")
	})

	await it("approvalQueue requests awaiting_approval status", async () => {
		const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: [action()] }))
		const client = new QuorvelClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
		const rows = await client.approvalQueue()
		assert.match(calls[0].url, /status=awaiting_approval/)
		assert.equal(rows.length, 1)
		assert.equal(rows[0].tool, "refund")
	})

	await it("approve POSTs to /approved and tolerates 204", async () => {
		const { fetchImpl, calls } = fakeFetch(() => ({ status: 204 }))
		const client = new QuorvelClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
		await client.approve("k1")
		assert.equal(calls[0].url, "https://api.example.com/v1/actions/k1/approved")
		assert.equal(calls[0].init?.method, "POST")
	})

	await it("reject POSTs the reason body", async () => {
		const { fetchImpl, calls } = fakeFetch(() => ({ status: 204 }))
		const client = new QuorvelClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
		await client.reject("k1", "too risky")
		assert.match(calls[0].url, /\/v1\/actions\/k1\/rejected$/)
		assert.deepEqual(JSON.parse(calls[0].init!.body!), { reason: "too risky" })
	})

	await it("encodes action keys in the path", async () => {
		const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: action() }))
		const client = new QuorvelClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
		await client.getAction("a/b c")
		assert.equal(calls[0].url, "https://api.example.com/v1/actions/a%2Fb%20c")
	})

	await it("usage parses the snapshot", async () => {
		const snap = { plan: "pro", period: "2026-01", used: 10, limit: 100000, remaining: 99990 }
		const { fetchImpl } = fakeFetch(() => ({ status: 200, body: snap }))
		const client = new QuorvelClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
		assert.deepEqual(await client.usage(), snap)
	})

	await it("throws QuorvelApiError with code on non-2xx", async () => {
		const { fetchImpl } = fakeFetch(() => ({ status: 402, body: { error: "quota exceeded", code: "quota_exceeded" } }))
		const client = new QuorvelClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
		await assert.rejects(
			() => client.listRecent(),
			(e: unknown) => e instanceof QuorvelApiError && e.status === 402 && e.code === "quota_exceeded",
		)
	})

	section("groupByScope")

	await it("buckets actions by scope and defaults unscoped", () => {
		const grouped = groupByScope([
			action({ idempotencyKey: "1", scope: "agent-a" }),
			action({ idempotencyKey: "2", scope: "agent-a" }),
			action({ idempotencyKey: "3", scope: null }),
		])
		assert.equal(grouped.get("agent-a")!.length, 2)
		assert.equal(grouped.get("(unscoped)")!.length, 1)
	})

	section("QuorvelClient observability")

    await it("listEvents builds the /v1/events query from filters", async () => {
        const ev = { id: "1", idempotencyKey: "k1", type: "transition", status: "succeeded", attempt: 0, at: "2026-01-01T00:00:00.000Z" }
        const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: [ev] }))
        const client = new QuorvelClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
        const rows = await client.listEvents({ status: "succeeded", action: "k1", since: "2026-01-01T00:00:00.000Z" })
        assert.match(calls[0].url, /\/v1\/events\?/)
        assert.match(calls[0].url, /status=succeeded/)
        assert.match(calls[0].url, /action=k1/)
        assert.match(calls[0].url, /since=/)
        assert.equal(rows.length, 1)
        assert.equal(rows[0].status, "succeeded")
    })

    await it("listEvents omits the query string when no filters", async () => {
        const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: [] }))
        const client = new QuorvelClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
        await client.listEvents()
        assert.equal(calls[0].url, "https://api.example.com/v1/events")
    })

    await it("runTimeline encodes the key and returns action + events", async () => {
        const body = { action: action(), events: [] }
        const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body }))
        const client = new QuorvelClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
        const tl = await client.runTimeline("a/b c")
        assert.equal(calls[0].url, "https://api.example.com/v1/actions/a%2Fb%20c/events")
        assert.equal(tl.action.tool, "refund")
        assert.deepEqual(tl.events, [])
    })

    await it("metrics builds the window query and parses the result", async () => {
        const body = {
            since: "2026-01-01T00:00:00.000Z",
            until: null,
            runs: 3,
            events: 6,
            outcomes: { succeeded: 2, failed: 1, denied: 0, rejected: 0 },
            terminalRuns: 3,
            errorRate: 0.3333,
            latencyMs: { count: 3, avg: 1500, p50: 2000, p95: 2000 },
            usage: { plan: "pro", period: "2026-01", used: 3, limit: 100000, remaining: 99997 },
        }
        const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body }))
        const client = new QuorvelClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
        const m = await client.metrics({ since: "2026-01-01T00:00:00.000Z" })
        assert.match(calls[0].url, /\/v1\/metrics\?since=/)
        assert.equal(m.runs, 3)
        assert.equal(m.outcomes.succeeded, 2)
        assert.equal(m.usage.plan, "pro")
    })

    await it("metrics omits the query string when no window", async () => {
        const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { runs: 0 } }))
        const client = new QuorvelClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
        await client.metrics()
        assert.equal(calls[0].url, "https://api.example.com/v1/metrics")
    })

    	summary()
})()
