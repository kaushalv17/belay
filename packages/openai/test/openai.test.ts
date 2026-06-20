// Phase 6 Part 2 — OpenAI adapter tests. Run with: pnpm test (tsx + sandbox belay).
import assert from "node:assert/strict"
import {
	InMemoryLedger,
	approve,
	budget,
	rateLimit,
	requireApprovalWhen,
} from "belay"
import { withBelay, withBelayAll } from "../src/agents"
import { createToolRunner, guard } from "../src/functions"

type Test = { name: string; fn: () => Promise<void> }
const tests: Test[] = []
const test = (name: string, fn: () => Promise<void>) => tests.push({ name, fn })

// 1. Agents SDK: same tool call N times → executes exactly once.
test("agents: exactly-once dedupe on repeated identical call", async () => {
	const ledger = new InMemoryLedger()
	let calls = 0
	const tool = withBelay(ledger, {
		name: "refund",
		execute: (a: { chargeId: string; amount: number }) => {
			calls++
			return { refunded: a.amount, id: "re_1" }
		},
	})
	const a = await tool.execute({ chargeId: "ch_1", amount: 50 })
	const b = await tool.execute({ chargeId: "ch_1", amount: 50 })
	const c = await tool.execute({ chargeId: "ch_1", amount: 50 })
	assert.equal(calls, 1, "underlying tool must run once")
	assert.deepEqual(a, { refunded: 50, id: "re_1" })
	assert.deepEqual(b, a)
	assert.deepEqual(c, a)
})

// 2. Agents SDK: approval gate parks the action, then approval lets it run once.
test("agents: approval gate parks then runs once after approve()", async () => {
	const ledger = new InMemoryLedger()
	let calls = 0
	const tool = withBelay(
		ledger,
		{ name: "refund", execute: (_a: any) => { calls++; return { ok: true } } },
		{
			scope: (a: { userId: string }) => `user-${a.userId}`,
			cost: (a: { amount: number }) => a.amount,
			policies: [requireApprovalWhen((c) => c.cost > 100, "large refund")],
		},
	)
	const pending: any = await tool.execute({ userId: "u1", amount: 500 })
	assert.equal(calls, 0, "must not execute while awaiting approval")
	assert.equal(pending._belay, "awaiting_approval")
	assert.ok(pending.idempotencyKey, "pending result carries idempotency key")

	await approve(ledger, pending.idempotencyKey)
	const done: any = await tool.execute({ userId: "u1", amount: 500 })
	assert.equal(calls, 1, "runs exactly once after approval")
	assert.deepEqual(done, { ok: true })
})

// 3. Function calling (Chat Completions): produces correct tool messages.
test("functions: chat tool-call dispatch returns role:tool messages", async () => {
	const ledger = new InMemoryLedger()
	const runner = createToolRunner(ledger, {
		refund: (a: { chargeId: string; amount: number }) => ({ refunded: a.amount }),
	})
	const toolCalls = [
		{ id: "call_1", type: "function", function: { name: "refund", arguments: JSON.stringify({ chargeId: "ch_1", amount: 25 }) } },
	]
	const msgs = await runner.runToolCalls(toolCalls)
	assert.equal(msgs.length, 1)
	assert.equal((msgs[0] as any).role, "tool")
	assert.equal((msgs[0] as any).tool_call_id, "call_1")
	assert.deepEqual(JSON.parse((msgs[0] as any).content), { refunded: 25 })
})

// 4. The documented bug: model emits the SAME tool call twice → dedupe.
test("functions: duplicate tool call across turns executes once", async () => {
	const ledger = new InMemoryLedger()
	let calls = 0
	const runner = createToolRunner(ledger, {
		sendEmail: (a: { to: string }) => { calls++; return { sent: true, to: a.to } },
	})
	const mk = (id: string) => [{ id, type: "function", function: { name: "sendEmail", arguments: JSON.stringify({ to: "a@b.com" }) } }]
	const first = await runner.runToolCalls(mk("call_1"))
	const second = await runner.runToolCalls(mk("call_2")) // same args, different id
	assert.equal(calls, 1, "email sent exactly once despite duplicate call")
	assert.deepEqual(JSON.parse((first[0] as any).content), { sent: true, to: "a@b.com" })
	assert.deepEqual(JSON.parse((second[0] as any).content), { sent: true, to: "a@b.com" })
})

// 5. Responses API format option.
test("functions: responses format emits function_call_output", async () => {
	const ledger = new InMemoryLedger()
	const runner = createToolRunner(ledger, { ping: (_a: any) => "pong" }, { format: "responses" })
	const msgs = await runner.runToolCalls([{ call_id: "fc_1", name: "ping", arguments: "{}", type: "function_call" }])
	assert.equal((msgs[0] as any).type, "function_call_output")
	assert.equal((msgs[0] as any).call_id, "fc_1")
	assert.equal((msgs[0] as any).output, "pong")
})

// 6. Budget policy blocks a runaway loop.
test("functions: budget cap denies once limit exceeded", async () => {
	const ledger = new InMemoryLedger()
	let calls = 0
	const runner = createToolRunner(
		ledger,
		{ charge: (a: { amount: number }) => { calls++; return { charged: a.amount } } },
		{ scope: () => "user-1", cost: (a: { amount: number }) => a.amount, policies: [budget({ limit: 100 })] },
	)
	// Distinct args so each is a separate action (identical args would dedupe).
	const mk = (amount: number, id: string) => [{ id, type: "function", function: { name: "charge", arguments: JSON.stringify({ amount }) } }]
	const m1 = await runner.runToolCalls(mk(60, "c1"))
	const m2 = await runner.runToolCalls(mk(70, "c2")) // 60 already spent + 70 > 100 → denied
	assert.deepEqual(JSON.parse((m1[0] as any).content), { charged: 60 })
	const denied = JSON.parse((m2[0] as any).content)
	assert.equal(denied._belay, "denied")
	assert.equal(calls, 1, "second charge blocked by budget")
})

// 7. Rate limit policy.
test("functions: rate limit denies beyond N calls", async () => {
	const ledger = new InMemoryLedger()
	let calls = 0
	const runner = createToolRunner(
		ledger,
		{ poke: (a: { n: number }) => { calls++; return { n: a.n } } },
		{ scope: () => "user-1", policies: [rateLimit({ limit: 2, windowMs: 60_000 })] },
	)
	const mk = (n: number) => [{ id: `r${n}`, type: "function", function: { name: "poke", arguments: JSON.stringify({ n }) } }]
	await runner.runToolCalls(mk(1))
	await runner.runToolCalls(mk(2))
	const third = await runner.runToolCalls(mk(3))
	assert.equal(calls, 2, "third call blocked by rate limit")
	assert.equal(JSON.parse((third[0] as any).content)._belay, "denied")
})

// 8. Unknown tool returns a structured error message, not a throw.
test("functions: unknown tool returns structured error message", async () => {
	const ledger = new InMemoryLedger()
	const runner = createToolRunner(ledger, {})
	const msgs = await runner.runToolCalls([{ id: "x", type: "function", function: { name: "nope", arguments: "{}" } }])
	assert.equal(JSON.parse((msgs[0] as any).content)._belay, "error")
})

// 9. guard(): single-handler wrapper dedupes too.
test("guard: single handler wrapper is exactly-once", async () => {
	const ledger = new InMemoryLedger()
	let calls = 0
	const safeRefund = guard(ledger, "refund", (a: { id: string }) => { calls++; return { id: a.id } }, { scope: () => "u1" })
	await safeRefund({ id: "ch_9" })
	await safeRefund({ id: "ch_9" })
	assert.equal(calls, 1)
})

// 10. withBelayAll wraps multiple tools.
test("agents: withBelayAll wraps every tool", async () => {
	const ledger = new InMemoryLedger()
	let a = 0, b = 0
	const [t1, t2] = withBelayAll(ledger, [
		{ name: "alpha", execute: (_a: any) => { a++; return "a" } },
		{ name: "beta", execute: (_a: any) => { b++; return "b" } },
	])
	await t1.execute({})
	await t1.execute({})
	await t2.execute({})
	assert.equal(a, 1)
	assert.equal(b, 1)
})

// runner
const run = async () => {
	let passed = 0
	const failures: string[] = []
	for (const t of tests) {
		try {
			await t.fn()
			console.log(`✓ ${t.name}`)
			passed++
		} catch (e) {
			console.error(`✗ ${t.name}\n   ${(e as Error).message}`)
			failures.push(t.name)
		}
	}
	console.log(`\n${passed}/${tests.length} passed`)
	if (failures.length) {
		console.error(`FAILED: ${failures.join(", ")}`)
		process.exit(1)
	}
}
run()
