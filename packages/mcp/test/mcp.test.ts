/**
 * @belay/mcp test suite. Run with: node ../../node_modules/.bin/tsx test/mcp.test.ts
 * (Sandbox: belay + @modelcontextprotocol/sdk are mocked under node_modules.)
 *
 * NOTE: the real MCP `McpServer` exposes no public way to introspect or invoke
 * a registered tool without a connected client/transport. So the adapter's
 * contract — “it calls server.registerTool(name, config, GUARDED_handler)” — is
 * verified with a capturing spy server, plus a real-McpServer smoke check that
 * the proxy/registration path returns a handle without throwing. This keeps the
 * suite SDK-version-independent and identical in sandbox and on a real machine.
 */
import assert from "node:assert/strict"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
	InMemoryLedger,
	approve,
	budget,
	rateLimit,
	requireApprovalWhen,
	denyWhen,
} from "belay"
import {
	guard,
	withBelay,
	withBelayAll,
	registerBelayTool,
	withBelayServer,
} from "../src/index.ts"

let passed = 0
let failed = 0
async function test(name: string, fn: () => Promise<void> | void) {
	try {
		await fn()
		passed++
		console.log(`  \u2713 ${name}`)
	} catch (err) {
		failed++
		console.error(`  \u2717 ${name}`)
		console.error(`    ${(err as Error)?.stack ?? err}`)
	}
}

/** Pull the structured marker / payload out of a CallToolResult. */
const marker = (r: CallToolResult): any => {
	if (r.structuredContent) return r.structuredContent
	const text = r.content?.find((c) => c.type === "text")?.text
	try {
		return text ? JSON.parse(text) : undefined
	} catch {
		return text
	}
}

/** Make a plain MCP CallToolResult from a structured value. */
const ok = (value: Record<string, unknown>): CallToolResult => ({
	content: [{ type: "text", text: JSON.stringify(value) }],
	structuredContent: value,
})

/**
 * A minimal server that captures the (name, config, handler) it is asked to
 * register — exactly the McpServer surface the adapter touches — so tests can
 * invoke the registered (guarded) handler directly.
 */
class SpyServer {
	registered = new Map<string, { config: any; handler: (args: any, extra?: any) => any }>()
	registerTool(name: string, config: any, handler: (args: any, extra?: any) => any) {
		this.registered.set(name, { config, handler })
		return { name }
	}
	/** A non-registerTool member, to prove proxy pass-through. */
	sentinel() {
		return "pong"
	}
}

await (async () => {
	console.log("@belay/mcp\n")

	// 1. withBelay preserves the MCP tool contract (name/config) and returns a
	//    valid CallToolResult unchanged on the happy path.
	await test("withBelay preserves name, config, and CallToolResult", async () => {
		const ledger = new InMemoryLedger()
		const guarded = withBelay(ledger, {
			name: "double",
			config: { description: "Doubles a number", inputSchema: { kind: "zod-ish" } },
			handler: async ({ x }: any) => ok({ doubled: x * 2 }),
		})
		assert.equal(guarded.name, "double")
		assert.equal(guarded.config?.description, "Doubles a number")
		assert.deepEqual(guarded.config?.inputSchema, { kind: "zod-ish" })
		const out = await guarded.handler({ x: 21 })
		assert.equal(out.isError ?? false, false)
		assert.deepEqual(marker(out), { doubled: 42 })
	})

	// 2. Exactly-once: identical calls execute the underlying handler once and
	//    replay the same CallToolResult.
	await test("exactly-once dedupe across identical invocations", async () => {
		const ledger = new InMemoryLedger()
		let calls = 0
		const handler = guard(ledger, "charge", async ({ id }: any) => {
			calls++
			return ok({ charged: id, n: calls })
		})
		const a = await handler({ id: "order-1" })
		const b = await handler({ id: "order-1" })
		assert.equal(calls, 1, "underlying tool must run exactly once")
		assert.deepEqual(marker(a), marker(b), "second call replays the first result")
	})

	// 3. Approval gate parks the action (as a non-error structured result), then
	//    runs exactly once after approve(). Uses the worst-case mock where
	//    ApprovalRequiredError exposes NO key, proving the listPendingApprovals
	//    fallback resolves it.
	await test("approval gate parks then runs once after approve()", async () => {
		const ledger = new InMemoryLedger()
		let sideEffects = 0
		const handler = guard(
			ledger,
			"refund",
			async ({ amount }: any) => {
				sideEffects++
				return ok({ refunded: amount })
			},
			{
				cost: (a: any) => a.amount,
				policies: [requireApprovalWhen((c: any) => c.cost > 100, "refund over $100")],
			},
		)
		const pending = await handler({ amount: 500 })
		assert.equal(pending.isError ?? false, false, "pending is informational, not an error")
		const pm = marker(pending)
		assert.equal(pm._belay, "awaiting_approval")
		assert.equal(pm.status, "pending_approval")
		assert.ok(pm.idempotencyKey, "pending result must carry an idempotency key")
		assert.equal(sideEffects, 0, "must not run before approval")
		await approve(ledger, pm.idempotencyKey)
		const done = await handler({ amount: 500 })
		assert.deepEqual(marker(done), { refunded: 500 })
		assert.equal(sideEffects, 1, "runs exactly once after approval")
	})

	// 4. registerBelayTool is a drop-in for server.registerTool: it returns the
	//    SDK handle and registers a GUARDED handler (verified by invoking the
	//    captured handler). No SDK-private introspection is used.
	await test("registerBelayTool registers a guarded tool", async () => {
		const ledger = new InMemoryLedger()
		const spy = new SpyServer()
		let runs = 0
		const handle = registerBelayTool(
			spy as any,
			ledger,
			"get_weather",
			{ description: "Weather", inputSchema: {} },
			async ({ city }: any) => {
				runs++
				return ok({ temp: 72, city })
			},
		)
		assert.ok(handle, "returns the SDK RegisteredTool handle")
		const captured = spy.registered.get("get_weather")
		assert.ok(captured, "tool was registered under its name")
		assert.equal(captured!.config.description, "Weather")
		const res = await captured!.handler({ city: "NYC" })
		assert.deepEqual(marker(res), { temp: 72, city: "NYC" })
		// guard is active on the registered handler
		await captured!.handler({ city: "NYC" })
		assert.equal(runs, 1, "registered handler is Belay-guarded (exactly-once)")

		// Smoke: the same call path works against a real McpServer without throwing.
		const server = new McpServer({ name: "test", version: "0.0.0" })
		const realHandle = registerBelayTool(
			server,
			ledger,
			"noop",
			{ description: "", inputSchema: {} },
			async () => ok({ ok: true }),
		)
		assert.ok(realHandle, "registerBelayTool returns a handle from a real McpServer")
	})

	// 5. withBelayServer guards EVERY registerTool call on a server while passing
	//    other members straight through. Behavior verified via a spy; proxy
	//    integrity verified against a real McpServer.
	await test("withBelayServer guards every registered tool", async () => {
		const ledger = new InMemoryLedger()

		// (a) Proxy works against a real McpServer: registerTool returns a handle.
		const realServer = withBelayServer(new McpServer({ name: "test", version: "0.0.0" }), ledger)
		const handle = realServer.registerTool("real_tool", { description: "", inputSchema: {} }, async () => ok({ ok: true }))
		assert.ok(handle, "registerTool through the proxy returns a handle")

		// (b) Guarding + pass-through verified via a capturing spy server.
		const spy = new SpyServer()
		const server = withBelayServer(spy as any, ledger)
		let aRuns = 0
		server.registerTool("a", { description: "" } as any, (async () => {
			aRuns++
			return ok({ a: aRuns })
		}) as any)
		server.registerTool("b", { description: "" } as any, (async () => ok({ b: 2 })) as any)
		assert.deepEqual([...spy.registered.keys()], ["a", "b"], "all tools registered")
		assert.equal((server as any).sentinel(), "pong", "non-registerTool members pass through the proxy")

		const aHandler = spy.registered.get("a")!.handler
		await aHandler({})
		await aHandler({})
		assert.equal(aRuns, 1, "server-wide guard enforces exactly-once")
		assert.deepEqual(marker(await spy.registered.get("b")!.handler({})), { b: 2 })
	})

	// 6. The duplicate-tool-call problem: same call across two turns runs once.
	await test("guard dedupes a repeated tool call across turns", async () => {
		const ledger = new InMemoryLedger()
		let runs = 0
		const send = guard(ledger, "send_email", async ({ to }: any) => {
			runs++
			return ok({ sent: to, runs })
		})
		const first = await send({ to: "a@b.com" })
		const second = await send({ to: "a@b.com" })
		assert.equal(runs, 1, "identical call must execute exactly once")
		assert.deepEqual(marker(first), marker(second), "replayed result is identical")
	})

	// 7. Budget policy denies once the cap is exceeded (as an isError result).
	await test("budget policy denies once the cap is exceeded", async () => {
		const ledger = new InMemoryLedger()
		const buy = guard(ledger, "buy", async ({ item }: any) => ok({ bought: item }), {
			cost: () => 60,
			scope: "team-1",
			policies: [budget({ limit: 100, windowMs: 60_000 })],
		})
		const first = await buy({ item: "a" })
		const denied = await buy({ item: "b" })
		assert.deepEqual(marker(first), { bought: "a" })
		assert.equal(denied.isError, true, "denied result is flagged isError")
		assert.equal(marker(denied)._belay, "denied")
		assert.equal(marker(denied).status, "blocked")
	})

	// 8. Rate limit denies beyond N calls in the window.
	await test("rate limit denies beyond the allowed count", async () => {
		const ledger = new InMemoryLedger()
		const ping = guard(ledger, "ping", async ({ n }: any) => ok({ pong: n }), {
			scope: "u-1",
			policies: [rateLimit({ limit: 2, windowMs: 60_000 })],
		})
		assert.deepEqual(marker(await ping({ n: 1 })), { pong: 1 })
		assert.deepEqual(marker(await ping({ n: 2 })), { pong: 2 })
		const third = await ping({ n: 3 })
		assert.equal(third.isError, true)
		assert.equal(marker(third)._belay, "denied", "third call exceeds the rate limit")
	})

	// 9. CallToolResult passthrough: a handler that returns isError + structured
	//    content is stored and replayed faithfully (errors are first-class).
	await test("guard preserves isError and structuredContent on replay", async () => {
		const ledger = new InMemoryLedger()
		let calls = 0
		const faily = guard(ledger, "faily", async () => {
			calls++
			return { content: [{ type: "text", text: "boom" }], structuredContent: { code: 500 }, isError: true }
		})
		const a = await faily({})
		const b = await faily({})
		assert.equal(calls, 1, "failed-but-returned result is cached like any success")
		assert.equal(a.isError, true)
		assert.deepEqual(a.structuredContent, { code: 500 })
		assert.equal(a.content[0].text, "boom")
		assert.deepEqual(a, b)
	})

	// 10. withBelayAll wraps every definition; guard() handles a raw handler with
	//     denyWhen, returning a denied CallToolResult.
	await test("withBelayAll wraps all tools and guard() handles denyWhen", async () => {
		const ledger = new InMemoryLedger()
		const [g1, g2] = withBelayAll(ledger, [
			{ name: "t1", handler: async () => ok({ a: 1 }) },
			{ name: "t2", handler: async () => ok({ b: 2 }) },
		])
		assert.deepEqual([g1.name, g2.name], ["t1", "t2"])
		assert.deepEqual(marker(await g1.handler({})), { a: 1 })

		const transfer = guard(ledger, "transfer", async ({ amount }: any) => ok({ moved: amount }), {
			policies: [denyWhen((c: any) => c.args.amount > 1000, "amount too large")],
		})
		assert.deepEqual(marker(await transfer({ amount: 10 })), { moved: 10 })
		const blocked = await transfer({ amount: 5000 })
		assert.equal(blocked.isError, true)
		assert.equal(marker(blocked)._belay, "denied")
	})

	console.log(`\n${passed}/${passed + failed} passed`)
	if (failed > 0) process.exit(1)
})()
