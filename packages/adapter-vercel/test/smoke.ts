// Runtime smoke test. No `ai`/`zod` needed — tools are matched structurally.
// Run:  tsx test/smoke.ts
import assert from "node:assert"
import { ApprovalRequiredError, createBelay } from "../src/index.js"

async function main() {
	// 1) Retry: a flaky tool fails twice (transient), succeeds on attempt 3.
	let calls = 0
	const flaky = {
		description: "flaky adder",
		execute: async (args: { x: number }) => {
			calls++
			if (calls < 3) {
				const e: any = new Error("transient")
				e.code = "ECONNRESET"
				throw e
			}
			return { sum: args.x + 1, calls }
		},
	}
	const belay = createBelay({ retry: { baseDelayMs: 1, maxDelayMs: 2 } })
	const tools = belay.wrap({ flaky })
	const r1 = await tools.flaky.execute!({ x: 1 })
	assert.equal(r1.sum, 2)
	assert.equal(calls, 3, "should retry twice then succeed")

	// 2) Idempotent replay: same args -> cached result, execute NOT called again.
	const r2 = await tools.flaky.execute!({ x: 1 })
	assert.equal(r2.calls, 3)
	assert.equal(calls, 3, "cache hit should not re-execute")

	// 3) Approval gate (interrupt mode): first call throws, approve, re-run runs.
	let approvalId = ""
	const belay2 = createBelay({
		perTool: { danger: { requiresApproval: true } },
		onEvent: (e) => {
			if (e.type === "approval_required") approvalId = e.approvalId!
		},
	})
	let dangerRan = 0
	const t2 = belay2.wrap({
		danger: { execute: async () => { dangerRan++; return "boom" } },
	})
	await assert.rejects(
		() => Promise.resolve(t2.danger.execute!({})),
		(e: unknown) => e instanceof ApprovalRequiredError,
	)
	assert.ok(approvalId, "approval id captured via onEvent")
	assert.equal(dangerRan, 0, "must not execute before approval")
	const pending = await belay2.listPendingApprovals()
	assert.equal(pending.length, 1)
	await belay2.approve(approvalId, "blue")
	const ok = await t2.danger.execute!({})
	assert.equal(ok, "boom")
	assert.equal(dangerRan, 1, "executes exactly once after approval")

	// 4) Budget: maxCalls caps successful calls across the toolset.
	const belay3 = createBelay({ budget: { maxCalls: 1 } })
	const t3 = belay3.wrap({
		a: { execute: async (x: { i: number }) => x.i },
	})
	await t3.a.execute!({ i: 1 })
	let budgetHit = false
	try {
		await t3.a.execute!({ i: 2 })
	} catch (e: any) {
		budgetHit = e?.code === "budget_exceeded"
	}
	assert.ok(budgetHit, "second distinct call should exceed maxCalls budget")

	console.log("SMOKE OK: retry + idempotent replay + approval gate + budget")
}

main().catch((e) => {
	console.error("SMOKE FAILED", e)
	process.exit(1)
})
