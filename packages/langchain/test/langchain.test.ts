/**
 * @belay/langchain test suite. Run with: node ../../node_modules/.bin/tsx test/langchain.test.ts
 * (Sandbox: belay + @langchain/* are mocked under node_modules.)
 */
import assert from "node:assert/strict"
import { tool } from "@langchain/core/tools"
import { ToolMessage, AIMessage } from "@langchain/core/messages"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import {
	InMemoryLedger,
	approve,
	budget,
	rateLimit,
	requireApprovalWhen,
	denyWhen,
} from "belay"
import {
	withBelay,
	withBelayAll,
	createToolRunner,
	guard,
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

const parse = (m: ToolMessage) => {
	const c = (m as any).content
	try {
		return typeof c === "string" ? JSON.parse(c) : c
	} catch {
		return c
	}
}

const aiWith = (calls: any[]) => new AIMessage({ content: "", tool_calls: calls })

await (async () => {
	console.log("@belay/langchain\n")

	// 1. withBelay preserves the LangChain tool contract (name/description/schema).
	await test("withBelay preserves name, description, and schema", async () => {
		const ledger = new InMemoryLedger()
		const base = tool(async ({ x }: any) => ({ doubled: x * 2 }), {
			name: "double",
			description: "Doubles a number",
			schema: { kind: "zod-ish" },
		})
		const guarded = withBelay(ledger, base)
		assert.equal(guarded.name, "double")
		assert.equal(guarded.description, "Doubles a number")
		assert.deepEqual(guarded.schema, { kind: "zod-ish" })
		const out = await guarded.func!({ x: 21 })
		assert.deepEqual(out, { doubled: 42 })
	})

	// 2. Exactly-once: identical calls execute the underlying tool once.
	await test("exactly-once dedupe across identical invocations", async () => {
		const ledger = new InMemoryLedger()
		let calls = 0
		const base = tool(
			async ({ id }: any) => {
				calls++
				return { charged: id, n: calls }
			},
			{ name: "charge", description: "Charge", schema: {} },
		)
		const guarded = withBelay(ledger, base)
		const a = await guarded.func!({ id: "order-1" })
		const b = await guarded.func!({ id: "order-1" })
		assert.equal(calls, 1, "underlying tool must run exactly once")
		assert.deepEqual(a, b, "second call replays the first result")
	})

	// 3. Approval gate parks the action, then runs exactly once after approve().
	//    Uses the worst-case mock where ApprovalRequiredError exposes NO key,
	//    proving the listPendingApprovals fallback resolves it.
	await test("approval gate parks then runs once after approve()", async () => {
		const ledger = new InMemoryLedger()
		let sideEffects = 0
		const base = tool(
			async ({ amount }: any) => {
				sideEffects++
				return { refunded: amount }
			},
			{ name: "refund", description: "Refund", schema: {} },
		)
		const guarded = withBelay(ledger, base, {
			policies: [requireApprovalWhen((c: any) => c.cost > 100, "refund over $100")],
			cost: (a: any) => a.amount,
		})
		const pending: any = await guarded.func!({ amount: 500 })
		assert.equal(pending._belay, "awaiting_approval")
		assert.equal(pending.status, "pending_approval")
		assert.ok(pending.idempotencyKey, "pending result must carry an idempotency key")
		assert.equal(sideEffects, 0, "must not run before approval")
		await approve(ledger, pending.idempotencyKey)
		const done: any = await guarded.func!({ amount: 500 })
		assert.deepEqual(done, { refunded: 500 })
		assert.equal(sideEffects, 1, "runs exactly once after approval")
	})

	// 4. Drop-in: a guarded tool works unchanged inside a LangGraph ToolNode,
	//    producing a proper ToolMessage with the right tool_call_id.
	await test("guarded tool is a drop-in for LangGraph ToolNode", async () => {
		const ledger = new InMemoryLedger()
		const base = tool(async ({ city }: any) => ({ temp: 72, city }), {
			name: "get_weather",
			description: "Weather",
			schema: {},
		})
		const node = new ToolNode([withBelay(ledger, base)])
		const { messages } = await node.invoke({
			messages: [aiWith([{ name: "get_weather", args: { city: "NYC" }, id: "call_1", type: "tool_call" }])],
		})
		assert.equal(messages.length, 1)
		assert.ok(messages[0] instanceof ToolMessage, "ToolNode must emit a ToolMessage")
		assert.equal(messages[0].tool_call_id, "call_1")
		assert.deepEqual(parse(messages[0]), { temp: 72, city: "NYC" })
	})

	// 5. createToolRunner dispatches tool_calls -> ToolMessage[] preserving ids/order.
	await test("createToolRunner dispatches tool calls to ToolMessages", async () => {
		const ledger = new InMemoryLedger()
		const search = tool(async ({ q }: any) => ({ hits: [q] }), { name: "search", description: "", schema: {} })
		const add = tool(async ({ a, b }: any) => ({ sum: a + b }), { name: "add", description: "", schema: {} })
		const runner = createToolRunner(ledger, [search, add])
		const msgs = await runner.runFromMessage(
			aiWith([
				{ name: "search", args: { q: "belay" }, id: "c1", type: "tool_call" },
				{ name: "add", args: { a: 2, b: 3 }, id: "c2", type: "tool_call" },
			]),
		)
		assert.equal(msgs.length, 2)
		assert.ok(msgs.every((m) => m instanceof ToolMessage))
		assert.deepEqual([msgs[0].tool_call_id, msgs[1].tool_call_id], ["c1", "c2"])
		assert.deepEqual(parse(msgs[0]), { hits: ["belay"] })
		assert.deepEqual(parse(msgs[1]), { sum: 5 })
	})

	// 6. The duplicate-tool-call problem: same call across two turns executes once.
	await test("createToolRunner dedupes a repeated tool call across turns", async () => {
		const ledger = new InMemoryLedger()
		let runs = 0
		const send = tool(
			async ({ to }: any) => {
				runs++
				return { sent: to, runs }
			},
			{ name: "send_email", description: "", schema: {} },
		)
		const runner = createToolRunner(ledger, [send])
		const first = await runner.runToolCall({ name: "send_email", args: { to: "a@b.com" }, id: "c1" })
		const second = await runner.runToolCall({ name: "send_email", args: { to: "a@b.com" }, id: "c2" })
		assert.equal(runs, 1, "identical call must execute exactly once")
		assert.deepEqual(parse(first), parse(second), "replayed result is identical")
	})

	// 7. Budget policy denies once the cap is exceeded (as a ToolMessage payload).
	await test("budget policy denies once the cap is exceeded", async () => {
		const ledger = new InMemoryLedger()
		const buy = tool(async ({ item }: any) => ({ bought: item }), { name: "buy", description: "", schema: {} })
		const runner = createToolRunner(ledger, [buy], {
			cost: () => 60,
			scope: "team-1",
			policies: [budget({ limit: 100, windowMs: 60_000 })],
		})
		const ok = parse(await runner.runToolCall({ name: "buy", args: { item: "a" }, id: "c1" }))
		const denied = parse(await runner.runToolCall({ name: "buy", args: { item: "b" }, id: "c2" }))
		assert.deepEqual(ok, { bought: "a" })
		assert.equal(denied._belay, "denied")
		assert.equal(denied.status, "blocked")
	})

	// 8. Rate limit denies beyond N calls in the window.
	await test("rate limit denies beyond the allowed count", async () => {
		const ledger = new InMemoryLedger()
		const ping = tool(async ({ n }: any) => ({ pong: n }), { name: "ping", description: "", schema: {} })
		const runner = createToolRunner(ledger, [ping], {
			scope: "u-1",
			policies: [rateLimit({ limit: 2, windowMs: 60_000 })],
		})
		const r1 = parse(await runner.runToolCall({ name: "ping", args: { n: 1 }, id: "c1" }))
		const r2 = parse(await runner.runToolCall({ name: "ping", args: { n: 2 }, id: "c2" }))
		const r3 = parse(await runner.runToolCall({ name: "ping", args: { n: 3 }, id: "c3" }))
		assert.deepEqual(r1, { pong: 1 })
		assert.deepEqual(r2, { pong: 2 })
		assert.equal(r3._belay, "denied", "third call exceeds the rate limit")
	})

	// 9. Unknown tool yields a structured error ToolMessage (graph keeps moving).
	await test("unknown tool returns a structured error ToolMessage", async () => {
		const ledger = new InMemoryLedger()
		const runner = createToolRunner(ledger, [] as any)
		const msg = await runner.runToolCall({ name: "ghost", args: {}, id: "c1" })
		assert.ok(msg instanceof ToolMessage)
		assert.equal(msg.tool_call_id, "c1")
		assert.equal(parse(msg)._belay, "error")
	})

	// 10. withBelayAll wraps every tool; guard() handles a raw handler with denyWhen.
	await test("withBelayAll wraps all tools and guard() handles raw handlers", async () => {
		const ledger = new InMemoryLedger()
		const t1 = tool(async () => ({ a: 1 }), { name: "t1", description: "", schema: {} })
		const t2 = tool(async () => ({ b: 2 }), { name: "t2", description: "", schema: {} })
		const [g1, g2] = withBelayAll(ledger, [t1, t2])
		assert.deepEqual([g1.name, g2.name], ["t1", "t2"])
		assert.deepEqual(await g1.func!({}), { a: 1 })

		const transfer = guard(
			ledger,
			"transfer",
			async ({ amount }: any) => ({ moved: amount }),
			{ policies: [denyWhen((c: any) => c.args.amount > 1000, "amount too large")] },
		)
		const okMove: any = await transfer({ amount: 10 })
		assert.deepEqual(okMove, { moved: 10 })
		const blocked: any = await transfer({ amount: 5000 })
		assert.equal(blocked._belay, "denied")
	})

	console.log(`\n${passed}/${passed + failed} passed`)
	if (failed > 0) process.exit(1)
})()
