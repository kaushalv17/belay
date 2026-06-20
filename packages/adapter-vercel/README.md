# @belay/adapter-vercel

> Wrap your [Vercel AI SDK](https://sdk.vercel.ai) tools with Belay's reliability layer — **idempotency, retries, budgets, and human approvals** — in one line.

Belay catches your AI agent when it falls. This adapter makes every tool call in your AI SDK agent:

- **Idempotent** — identical `(tool, args)` calls return the cached result instead of re-running side effects.
- **Resilient** — transient failures are retried with full-jitter exponential backoff.
- **Governed** — per-session budgets cap how many calls (or how much money) an agent can spend.
- **Safe** — sensitive tools can require a human approval before they execute.
- **Observable** — every lifecycle event streams into Belay Mission Control.

## Install

```bash
pnpm add @belay/adapter-vercel
# peers (you already have these in an AI SDK app)
pnpm add ai zod
```

## Usage

```ts
import { generateText, tool } from "ai"
import { openai } from "@ai-sdk/openai"
import { z } from "zod"
import { createBelay } from "@belay/adapter-vercel"

const belay = createBelay({
	budget: { maxCostCents: 500 },
	perTool: {
		refund: {
			requiresApproval: (a) => a.amountCents > 10_000, // approve big refunds
			costCents: 0,
			maxAttempts: 1, // never retry a refund
		},
	},
	onEvent: (e) => missionControl.publish(e), // live dashboard feed
})

const tools = belay.wrap({
	search: tool({
		description: "Search the catalog",
		parameters: z.object({ q: z.string() }),
		execute: async ({ q }) => catalog.search(q),
	}),
	refund: tool({
		description: "Issue a refund",
		parameters: z.object({ orderId: z.string(), amountCents: z.number() }),
		execute: async (a) => payments.refund(a),
	}),
})

await generateText({ model: openai("gpt-4o"), tools, prompt: "..." })
```

## Human-in-the-loop

Two approval modes:

- **`interrupt`** (default) — a gated tool throws `ApprovalRequiredError`. Catch it, surface the pending approval to a reviewer, and re-invoke the same call after `belay.approve(id)`. The idempotency key guarantees it resumes, not duplicates.
- **`wait`** — the call blocks until the approval is resolved (via your `waitForApproval` callback or store polling).

```ts
import { ApprovalRequiredError } from "@belay/adapter-vercel"

try {
	await tools.refund.execute({ orderId: "o_1", amountCents: 50_000 })
} catch (e) {
	if (e instanceof ApprovalRequiredError) {
		// show e.approvalId in your UI; later:
		await belay.approve(e.approvalId, "reviewer@acme.com")
		// re-run the exact same call -> now it executes
	}
}
```

## Bring your own store

The adapter depends only on the `ReliabilityStore` interface. The default is an in-process `InMemoryStore`; in production, back it with the Belay Postgres ledger so idempotency and approvals survive restarts and span your whole fleet.

## Errors

| Error | `code` | Meaning |
| --- | --- | --- |
| `ApprovalRequiredError` | `approval_required` | A gated tool is waiting on a human (interrupt mode). |
| `RejectedError` | `rejected` | A reviewer rejected the call. |
| `BudgetExceededError` | `budget_exceeded` | The session call/cost budget was hit. |
| `TimeoutError` | `timeout` | The tool exceeded its `timeoutMs`. |
| `NonRetryableError` | `non_retryable` | Throw this from `execute` to opt out of retries. |

## License

MIT
