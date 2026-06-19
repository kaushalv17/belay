# belay

> It catches your AI agent when it falls.

The core Belay SDK. Phase 1 adds the durable ledger; right now it ships the
deterministic **idempotency key** — the foundation of exactly-once tool calls.

## Install (once published)

```bash
npm install belay
```

## Usage

```ts
import { idempotencyKey } from "belay"

const key = idempotencyKey({
  tool: "refund",
  args: { amount: 1000, currency: "usd", chargeId: "ch_123" },
  scope: "user-42",
})

// Same tool + same args + same scope => same key, every time.
// Use this key to dedupe: if you've already run this key, return the stored result.
```

## Develop

```bash
pnpm install
pnpm test       # run the test suite
pnpm build      # emit dist/ (esm + cjs + d.ts)
```

## License

MIT
