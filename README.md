# Quorvel

> It catches your AI agent when it falls.

Quorvel is a framework-agnostic reliability layer for AI agents. Wrap your
agent's risky actions and they happen **exactly once**, get **logged and
replayable**, can be **paused for human approval**, and **never blow a budget** -
without rebuilding your app around a heavy orchestrator.

## Two products, one idea

- **SDK** - drop-in wrappers for OpenAI, LangChain/LangGraph, MCP, and the
  Vercel AI SDK that add idempotency, retries, budgets, and approval gates
  around your tool calls.
- **Cloud** - a hosted API + multi-tenant dashboard that tracks every action,
  enforces per-plan usage, and manages approvals at
  [app.quorvel.tech](https://app.quorvel.tech).

## Packages

| Package | What it is |
| --- | --- |
| `@quorvel/core` | The engine: idempotency, durable ledger, retries, policies, approvals |
| `@quorvel/openai` | OpenAI Agents SDK + function-calling adapter |
| `@quorvel/langchain` | LangChain JS + LangGraph adapter |
| `@quorvel/mcp` | Model Context Protocol adapter |
| `@quorvel/adapter-vercel` | Vercel AI SDK adapter |
| `apps/api` | Hosted Cloud API (`api.quorvel.tech`) |
| `apps/dashboard` | Trace / approval / usage dashboard (`app.quorvel.tech`) |

## Docs

Full docs live in [`docs/`](./docs) (Mintlify) - quickstart, integrations, CLI,
and the OpenAPI-backed API reference.

## Develop

```bash
pnpm install
pnpm -r build
pnpm -r test
```

## License

MIT