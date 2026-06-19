# Belay 🧗

> It catches your AI agent when it falls.

Belay is a tiny, framework-agnostic toolkit you wrap around your AI agent's risky actions so those actions happen **exactly once**, get **logged & replayable**, can be **paused for human approval**, and **never blow a budget** — without rebuilding your app around a heavy orchestrator.

## Why

Agents that take real actions (charging cards, sending email, writing to a DB) tend to fire those actions twice, lose them on a crash, or run wild. Belay sits around individual tool calls and makes them safe.

## Packages

| Package | What it is | Status |
| --- | --- | --- |
| `packages/core` | The SDK: idempotency, durable ledger, retries, approvals, budgets | 🚧 building |
| `apps/api` | Hosted ingest API (later) | planned |
| `apps/dashboard` | Trace / replay dashboard (later) | planned |

## Develop

```bash
pnpm install
pnpm test
```

## License

MIT
