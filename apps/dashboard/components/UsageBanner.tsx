import type { UsageSnapshot } from "../lib/quorvel"

// Warns an org when it is near or over its plan quota. Renders nothing when
// there's plenty of headroom or the plan is unlimited (near/over stay false).
export function UsageBanner({ usage }: { usage: UsageSnapshot }) {
  if (!usage.nearLimit && !usage.over) return null
  const pct = Math.round(usage.percentUsed * 100)
  const tone = usage.over ? "usage-banner-over" : "usage-banner-near"
  return (
    <div className={`usage-banner ${tone}`} role="status">
      {usage.over ? (
        <span>
          <b>You&apos;ve hit your {usage.plan} quota.</b> New actions are blocked
          until usage resets ({usage.period}) or you upgrade your plan.
        </span>
      ) : (
        <span>
          <b>
            You&apos;re at {pct}% of your {usage.plan} quota.
          </b>{" "}
          {usage.remaining.toLocaleString()} actions left this period ({usage.period}).
        </span>
      )}
    </div>
  )
}