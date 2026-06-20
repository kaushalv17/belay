# @belay/mcp

Reliability adapter for the **Model Context Protocol** ([`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)).

MCP is becoming the universal way to expose tools to LLMs (Claude, IDEs, agents). But an MCP server tool is just a side effect waiting to happen twice: a model retries, a client reconnects, a stream replays — and your `charge_card` runs again. `@belay/mcp` wraps your MCP tool handlers so every `tools/call` is:

- **Exactly-once** — identical calls (same tool + scope + args) execute the handler once and replay the stored `CallToolResult`.
- **Durable** — every action is recorded in a Belay ledger (in-memory for dev, Postgres for prod).
- **Policy-gated** — budgets, rate limits, and conditional `denyWhen` rules.
- **Human-approvable** — risky actions are parked as `awaiting_approval` and resume after `approve()`.

Parked and denied actions come back as **valid `CallToolResult`s** (a structured marker in both a `text` block and `structuredContent`, with `isError` set appropriately) — never thrown — so MCP clients and agent loops keep working and can explain the pause.

## Install

```bash
pnpm add @belay/mcp @modelcontextprotocol/sdk
```

## Guard an entire server (one line)

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { withBelayServer, InMemoryLedger, rateLimit, requireApprovalWhen } from "@belay/mcp"

const ledger = new InMemoryLedger()
const server = withBelayServer(new McpServer({ name: "billing", version: "1.0.0" }), ledger, {
  scope: (a) => `user-${a.userId}`,
  cost: (a) => a.amountUsd ?? 0,
  policies: [
    rateLimit({ limit: 100, windowMs: 60_000 }),
    requireApprovalWhen((c) => c.cost > 100, "charge over $100 needs a human"),
  ],
})

// Register tools exactly as you normally would — each is now guarded.
server.registerTool("charge_card", { description, inputSchema }, handler)
```

## Guard a single tool

```ts
import { registerBelayTool, InMemoryLedger } from "@belay/mcp"

registerBelayTool(server, ledger, "charge_card", { description, inputSchema }, handler, {
  scope: (a) => `user-${a.userId}`,
})
```

or wrap the handler yourself with `guard()`:

```ts
import { guard } from "@belay/mcp"
server.registerTool("charge_card", config, guard(ledger, "charge_card", handler, binding))
```

## Human-in-the-loop

```ts
import { listPendingApprovals, approve } from "@belay/mcp"

const pending = await listPendingApprovals(ledger)
await approve(ledger, pending[0].idempotencyKey)
// the next identical tools/call now executes exactly once
```

A parked call returns:

```json
{
  "content": [{ "type": "text", "text": "{\"_belay\":\"awaiting_approval\",...}" }],
  "structuredContent": { "_belay": "awaiting_approval", "status": "pending_approval", "idempotencyKey": "…" },
  "isError": false
}
```

## API

| Export | Purpose |
| --- | --- |
| `withBelayServer(server, ledger, binding?)` | Proxy an `McpServer` so every `registerTool` is guarded. |
| `registerBelayTool(server, ledger, name, config, handler, binding?)` | Register one guarded tool (drop-in for `server.registerTool`). |
| `withBelay(ledger, { name, config, handler }, binding?)` | Wrap a portable tool definition. |
| `withBelayAll(ledger, defs, binding?)` | Wrap an array of definitions. |
| `guard(ledger, name, handler, binding?)` | Wrap a raw `(args, extra) => CallToolResult` handler. |
| `approve` / `reject` / `listPendingApprovals` | Manage the durable approvals inbox. |
| `budget` / `rateLimit` / `requireApprovalWhen` / `denyWhen` | Policies. |
| `InMemoryLedger` | Dev ledger (use `PostgresLedger` from `belay` in prod). |

### `BelayBinding`

| Field | Type | Default |
| --- | --- | --- |
| `scope` | `string \| (args, ctx) => string` | `"global"` |
| `cost` | `number \| (args, ctx) => number` | `0` |
| `policies` | `Policy[] \| (args, ctx) => Policy[]` | `[]` |
| `onApprovalRequired` | `(info) => CallToolResult` | structured `awaiting_approval` |
| `onPolicyDenied` | `(info) => CallToolResult` | structured `denied` (isError) |

## How exactly-once works

The idempotency key is `sha256(tool | scope | stableStringify(args)).slice(0, 32)`. The first call records `running` → `succeeded` with the `CallToolResult`; any later call with the same key replays the stored result without re-running the handler. A handler that returns `isError: true` is cached like any other result (a deterministic failure stays deterministic).

## License

MIT
