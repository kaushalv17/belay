import { section, it, summary, assert } from "./_assert"
import {
  UsageNotifier,
  MemNotifyStateStore,
  buildUsageAlert,
} from "../src/usageNotifier"
import type { UsageSnapshot } from "../src/billing"
import type { Alert, AlertTransport } from "../src/alerts"
import type { DomainEvent } from "../src/events"

function snap(patch: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    plan: "free",
    period: "2026-06",
    used: 0,
    limit: 1000,
    remaining: 1000,
    percentUsed: 0,
    nearLimit: false,
    over: false,
    overage: 0,
    ...patch,
  }
}

function capture(): { transport: AlertTransport; sent: Alert[] } {
  const sent: Alert[] = []
  const transport: AlertTransport = {
    name: "capture",
    async send(a: Alert): Promise<void> {
      sent.push(a)
    },
  }
  return { transport, sent }
}

const created = (orgId: string): DomainEvent =>
  ({ type: "action.created", orgId }) as unknown as DomainEvent

section("UsageNotifier")

await it("fires a near-limit warning at >=80% and only once", async () => {
  const { transport, sent } = capture()
  const notifier = new UsageNotifier({
    usage: async () =>
      snap({ used: 800, remaining: 200, percentUsed: 0.8, nearLimit: true }),
    transports: [transport],
    state: new MemNotifyStateStore(),
  })
  await notifier.handle(created("org1"))
  await notifier.handle(created("org1"))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].level, "warning")
  assert.match(sent[0].title, /Approaching plan limit/)
})

await it("fires an over-limit alert with the overage count", async () => {
  const { transport, sent } = capture()
  const notifier = new UsageNotifier({
    usage: async () =>
      snap({
        plan: "pro",
        used: 100001,
        limit: 100000,
        remaining: 0,
        percentUsed: 1,
        nearLimit: true,
        over: true,
        overage: 1,
      }),
    transports: [transport],
    state: new MemNotifyStateStore(),
  })
  await notifier.handle(created("org1"))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].level, "critical")
  assert.match(sent[0].title, /Over plan limit/)
  assert.match(sent[0].body, /1 action/)
})

await it("sends near once, then over once, as usage climbs", async () => {
  const { transport, sent } = capture()
  let current: UsageSnapshot = snap({
    used: 800,
    remaining: 200,
    percentUsed: 0.8,
    nearLimit: true,
  })
  const notifier = new UsageNotifier({
    usage: async () => current,
    transports: [transport],
    state: new MemNotifyStateStore(),
  })
  await notifier.handle(created("org1")) // near
  await notifier.handle(created("org1")) // dedup near
  current = snap({
    used: 1000,
    limit: 1000,
    remaining: 0,
    percentUsed: 1,
    nearLimit: true,
    over: true,
    overage: 0,
  })
  await notifier.handle(created("org1")) // over
  await notifier.handle(created("org1")) // dedup over
  assert.equal(sent.length, 2)
  assert.equal(sent[0].level, "warning")
  assert.equal(sent[1].level, "critical")
  assert.match(sent[1].body, /reached your free plan limit/)
})

await it("resets in a new billing period", async () => {
  const { transport, sent } = capture()
  let period = "2026-06"
  const notifier = new UsageNotifier({
    usage: async () =>
      snap({ period, used: 800, remaining: 200, percentUsed: 0.8, nearLimit: true }),
    transports: [transport],
    state: new MemNotifyStateStore(),
  })
  await notifier.handle(created("org1"))
  await notifier.handle(created("org1")) // dedup same period
  period = "2026-07"
  await notifier.handle(created("org1")) // new period fires again
  assert.equal(sent.length, 2)
})

await it("stays silent for unlimited plans and under 80%", async () => {
  const { transport, sent } = capture()
  const unlimited = new UsageNotifier({
    usage: async () =>
      snap({
        plan: "scale",
        used: 5,
        limit: Infinity,
        remaining: Infinity,
        percentUsed: 0,
      }),
    transports: [transport],
    state: new MemNotifyStateStore(),
  })
  await unlimited.handle(created("org1"))
  const under = new UsageNotifier({
    usage: async () => snap({ used: 500, remaining: 500, percentUsed: 0.5 }),
    transports: [transport],
    state: new MemNotifyStateStore(),
  })
  await under.handle(created("org1"))
  assert.equal(sent.length, 0)
})

await it("ignores events that are not action.created", async () => {
  const { transport, sent } = capture()
  const notifier = new UsageNotifier({
    usage: async () =>
      snap({ used: 900, remaining: 100, percentUsed: 0.9, nearLimit: true }),
    transports: [transport],
    state: new MemNotifyStateStore(),
  })
  await notifier.handle({
    type: "action.transition",
    orgId: "org1",
  } as unknown as DomainEvent)
  assert.equal(sent.length, 0)
})

await it("buildUsageAlert wording differs for near vs over", () => {
  const near = buildUsageAlert(
    snap({ used: 800, remaining: 200, percentUsed: 0.8, nearLimit: true }),
    "near",
    created("o"),
  )
  assert.equal(near.level, "warning")
  assert.match(near.body, /80%/)
  const over = buildUsageAlert(
    snap({
      plan: "pro",
      used: 100005,
      limit: 100000,
      remaining: 0,
      percentUsed: 1,
      nearLimit: true,
      over: true,
      overage: 5,
    }),
    "over",
    created("o"),
  )
  assert.equal(over.level, "critical")
  assert.match(over.body, /5 action/)
})

summary()