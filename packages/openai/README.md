# @belay/openai

**Phase 6 · Part 2 — the OpenAI tool-calls adapter.**

Wrap your OpenAI tool calls with Belay to get exactly-once execution, a durable
action ledger, budgets, rate limits, and human approval gates — without
rewriting your agent. Works with **both** OpenAI surfaces:

1. **OpenAI Agents SDK** (`@openai/agents`) → `withBelay` / `withBelayAll`
2. **Classic function calling** (Chat Completions / Responses) → `createToolRunner` / `guard`

> Requires the `belay` core (Phases 1–4) for the ledger + policy engine.

## Install

```bash
pnpm add @belay/openai belay
```

## 1) OpenAI Agents SDK

```ts
import { Agent, tool } from "@openai/agents"
import { PostgresLedger } from "belay"
import { withBelay } from "@belay/openai"
import { requireApprovalWhen } from "belay"

const ledger = new PostgresLedger(pool)

const refund = withBelay(ledger, tool({
  name: "refund",
  description: "Refund a charge",
  parameters: z.object({ chargeId: z.string(), amount: z.number() }),
  execute: ({ chargeId, amount }) => stripe.refunds.create({ charge: chargeId, amount }),
}), {
  scope: (a) => `user-${a.userId}`,
  cost: (a) => a.amount / 100,
  policies: [requireApprovalWhen((c) => c.cost > 100, "refund over $100")],
})

const agent = new Agent({ name: "Support", tools: [refund] })
```

The returned tool is a **drop-in replacement** — same name, description, and
parameters. When an action is parked for approval (or blocked by a policy), the
tool returns a structured marker so the model can explain the pause instead of
crashing the loop. The real action stays durably parked until you `approve()` it.

## 2) Classic function calling (Chat Completions / Responses)

```ts
import OpenAI from "openai"
import { PostgresLedger, rateLimit } from "belay"
import { createToolRunner } from "@belay/openai"

const runner = createToolRunner(ledger, { refund, sendEmail }, {
  scope: (a) => `user-${a.userId}`,
  policies: [rateLimit({ limit: 5, windowMs: 60_000 })],
})

const completion = await openai.chat.completions.create({ model, messages, tools })
const msg = completion.choices[0].message
if (msg.tool_calls) {
  const toolMessages = await runner.runToolCalls(msg.tool_calls)
  messages.push(msg, ...toolMessages) // ready to send back
}
```

For the Responses API, pass `{ format: "responses" }` and you get
`{ type: "function_call_output", call_id, output }` messages instead.

### Why this matters

LLMs notoriously emit the **same tool call multiple times**
([vercel/ai#7261](https://github.com/vercel/ai/issues/7261),
[OpenAI community](https://community.openai.com/t/ridiculous-number-of-redundant-tool-calls/1181410)).
The dispatcher derives an idempotency key from `tool + args + scope`, so a
duplicate returns the **stored** result instead of charging the card or sending
the email twice — each tool message is still returned (one per `tool_call.id`)
so the conversation stays valid.

## Approvals inbox

```ts
import { listPendingApprovals, approve, reject } from "@belay/openai"

const inbox = await listPendingApprovals(ledger)
await approve(ledger, inbox[0].idempotencyKey) // next tool call executes it, once
```

## API

| Export | Surface | What it does |
| --- | --- | --- |
| `withBelay(ledger, tool, binding?)` | Agents SDK | Wrap one tool's `execute` with Belay |
| `withBelayAll(ledger, tools, binding?)` | Agents SDK | Wrap an array of tools |
| `createToolRunner(ledger, handlers, options?)` | Function calling | Dispatch `tool_calls` → tool messages |
| `guard(ledger, name, handler, binding?)` | Manual | Wrap a single handler you dispatch yourself |
| `approve` / `reject` / `listPendingApprovals` | Both | Re-exported from core for convenience |

**Binding options:** `scope`, `cost`, `policies` (each static or a function of
`(args, ctx)`), plus `onApprovalRequired` / `onPolicyDenied` to customize the
marker the model sees.

## Develop

```bash
pnpm test       # 10 adapter scenarios against an in-memory ledger
pnpm typecheck  # tsc --noEmit
pnpm build      # emit dist/
```

MIT · part of [Belay](https://github.com/) — *it catches your AI agent when it falls.*
