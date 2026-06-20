# @belay/langchain

Belay reliability adapter for **LangChain JS** and **LangGraph**.

Wrap your existing tools and every invocation gains:

- **Exactly-once execution** — idempotency keyed on `tool + scope + args`, so a model that emits the same tool call twice still only causes one side effect.
- **A durable action ledger** — in-memory for dev (`InMemoryLedger`), Postgres for prod (`PostgresLedger`).
- **Policy enforcement** — budgets, rate limits, hard denies, and human-in-the-loop approval gates.

It's a drop-in: the wrapped tool keeps its `name`, `description`, and `schema`, so it works unchanged with `bindTools`, a prebuilt `ToolNode`, or `createReactAgent`.

## Install

```bash
pnpm add @belay/langchain belay @langchain/core @langchain/langgraph
```

`@langchain/core` and `@langchain/langgraph` are optional peer dependencies — install whichever your app already uses.

## Two ways to use it

### 1. Wrap tools (`withBelay` / `withBelayAll`)

Best when you hand tools to LangGraph's prebuilt `ToolNode` or `createReactAgent`.

```ts
import { tool } from "@langchain/core/tools"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import { PostgresLedger, requireApprovalWhen } from "belay"
import { withBelay } from "@belay/langchain"

const ledger = new PostgresLedger(process.env.DATABASE_URL!)

const refund = withBelay(
  ledger,
  tool(async ({ chargeId, amount }) => stripe.refunds.create({ charge: chargeId, amount }), {
    name: "refund",
    description: "Refund a charge",
    schema: refundSchema,
  }),
  {
    scope: (a) => `customer-${a.chargeId}`,
    cost: (a) => a.amount / 100,
    policies: [requireApprovalWhen((c) => c.cost > 100, "refund over $100")],
  },
)

const toolNode = new ToolNode([refund]) // drop-in, nothing else changes
```

When a policy parks an action, the model receives a structured `awaiting_approval`
result (instead of an exception) so your graph keeps running. Resolve it later:

```ts
import { listPendingApprovals, approve } from "@belay/langchain"

for (const p of await listPendingApprovals(ledger)) {
  await approve(ledger, p.idempotencyKey)
}
```

### 2. Guard the loop (`createToolRunner` / `guard`)

Best when you dispatch tool calls yourself. Turns an AIMessage's `tool_calls`
into ready-to-append `ToolMessage`s, with dedupe and policy built in.

```ts
import { createToolRunner } from "@belay/langchain"
import { rateLimit } from "belay"

const runner = createToolRunner(ledger, [search, sendEmail], {
  scope: (a) => `user-${a.userId}`,
  policies: [rateLimit({ limit: 5, windowMs: 60_000 })],
})

const toolMessages = await runner.runFromMessage(aiMessage)
const nextState = { messages: [...state.messages, ...toolMessages] }
```

For a single hand-routed handler, use `guard`:

```ts
import { guard } from "@belay/langchain"

const transfer = guard(ledger, "transfer", doTransfer, {
  policies: [denyWhen((c) => c.args.amount > 10_000, "over limit")],
})
const result = await transfer({ amount: 250 })
```

## Binding options

| Option | Type | Purpose |
| --- | --- | --- |
| `scope` | `string \| (args, ctx) => string` | Idempotency + budget/limit scope (e.g. per user). Default `"global"`. |
| `cost` | `number \| (args, ctx) => number` | Cost charged against budgets. Default `0`. |
| `policies` | `Policy[] \| (args, ctx) => Policy[]` | `budget`, `rateLimit`, `requireApprovalWhen`, `denyWhen`. |
| `onApprovalRequired` | `(info) => unknown` | Custom result when an action is parked. |
| `onPolicyDenied` | `(info) => unknown` | Custom result when an action is denied. |

Policy precedence is **deny > require_approval > allow**.

## API

- `withBelay(ledger, tool, binding?)` / `withBelayAll(ledger, tools, binding?)`
- `createToolRunner(ledger, tools, options?)` → `{ runToolCall, runToolCalls, runFromMessage }`
- `guard(ledger, name, handler, binding?)`
- Re-exported from `belay`: `approve`, `reject`, `listPendingApprovals`

## License

MIT
