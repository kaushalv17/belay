// Usage-limit notifier: a bus subscriber that emails once when an org first
// crosses the near-limit threshold (>=80% of its plan quota) and again when it
// first goes over the plan limit. Deduped per org, per billing period, per
// level so a busy org is not emailed on every tracked action.
import type { Subscriber } from "./bus"
import type { DomainEvent } from "./events"
import type { UsageSnapshot } from "./billing"
import type { Alert, AlertTransport } from "./alerts"

export type UsageLevel = "near" | "over"

// Records at most one notification per (org, period, level).
export interface NotifyStateStore {
  // Returns true only the FIRST time a given (org, period, level) is seen, so
  // the caller sends exactly once per threshold per billing period.
  markIfFirst(
    orgId: string,
    period: string,
    level: UsageLevel,
  ): Promise<boolean>
}

// In-memory dedupe. Sufficient for a single instance; a Pg-backed store can be
// dropped in later behind the same interface for restart-durable dedupe.
export class MemNotifyStateStore implements NotifyStateStore {
  private readonly seen = new Set<string>()
  async markIfFirst(
    orgId: string,
    period: string,
    level: UsageLevel,
  ): Promise<boolean> {
    const key = `${orgId}:${period}:${level}`
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }
}

export interface UsageNotifierDeps {
  usage: (orgId: string) => Promise<UsageSnapshot>
  transports: AlertTransport[]
  state: NotifyStateStore
}

export class UsageNotifier {
  constructor(private readonly deps: UsageNotifierDeps) {}

  handle: Subscriber = async (e: DomainEvent): Promise<void> => {
    if (e.type !== "action.created") return
    const snap = await this.deps.usage(e.orgId)
    const level: UsageLevel | null = snap.over
      ? "over"
      : snap.nearLimit
        ? "near"
        : null
    if (!level) return
    const first = await this.deps.state.markIfFirst(e.orgId, snap.period, level)
    if (!first) return
    const alert = buildUsageAlert(snap, level, e)
    for (const t of this.deps.transports) await t.send(alert)
  }
}

export function buildUsageAlert(
  snap: UsageSnapshot,
  level: UsageLevel,
  event: DomainEvent,
): Alert {
  const used = snap.used.toLocaleString()
  const limit = snap.limit.toLocaleString()
  if (level === "over") {
    const lead =
      snap.overage > 0
        ? `You are ${snap.overage.toLocaleString()} action(s) over your ${snap.plan} plan limit`
        : `You have reached your ${snap.plan} plan limit`
    return {
      level: "critical",
      title: `[Quorvel] Over plan limit (${snap.plan})`,
      body:
        `${lead} for ${snap.period}.\n\n` +
        `Used ${used} of ${limit} actions.\n\n` +
        `Free plans are blocked at the limit. Paid plans keep running and any overage is reported, not charged automatically.`,
      event,
    }
  }
  const pct = Math.round(snap.percentUsed * 100)
  return {
    level: "warning",
    title: `[Quorvel] Approaching plan limit (${snap.plan})`,
    body:
      `You have used ${pct}% of your ${snap.plan} plan quota for ${snap.period}.\n\n` +
      `Used ${used} of ${limit} actions (${snap.remaining.toLocaleString()} remaining).`,
    event,
  }
}