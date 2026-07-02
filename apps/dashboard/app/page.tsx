import Link from "next/link"
import { serverClient } from "../lib/server-client"
import { StatusBadge } from "../components/StatusBadge"
import { approveAction, rejectAction } from "./actions"
import { UpgradeButton } from "../components/UpgradeButton"
import { UsageBanner } from "../components/UsageBanner"

// Always render fresh — this is a live operational queue.
export const dynamic = "force-dynamic"

function fmt(iso: string): string {
	return new Date(iso).toLocaleString()
}

export default async function ApprovalsPage() {
	const client = serverClient()
	const [queue, usage] = await Promise.all([client.approvalQueue(100), client.usage()])

	return (
		<>
			<h1>Approvals</h1>
			<p className="subtle">Actions your agents paused for human review, newest first.</p>

            <UsageBanner usage={usage} />

			<div className="usage-bar">
				<div className="stat">
					<b>{queue.length}</b>
					<span>awaiting approval</span>
				</div>
				<div className="stat">
					<b>{usage.plan}</b>
					<span>plan</span>
				</div>
				<div className="stat">
					<b>
						{usage.used.toLocaleString()}
						{usage.limit === Infinity ? "" : ` / ${usage.limit.toLocaleString()}`}
					</b>
					<span>actions this period ({usage.period})</span>
				</div>
				{usage.plan !== "scale" ? (
					<div className="stat upgrade-cell">
						<span className="upgrade-label">
							{usage.plan === "free" ? "Upgrade your plan" : "Need more headroom?"}
						</span>
						<div className="upgrade-actions">
							{usage.plan === "free" ? (
								<UpgradeButton plan="pro" label="Upgrade to Pro" />
							) : null}
							<UpgradeButton plan="scale" label="Upgrade to Scale" />
						</div>
					</div>
				) : null}
			</div>

			{queue.length === 0 ? (
				<div className="empty">Nothing waiting. Your agents are all clear. ✨</div>
			) : (
				queue.map((a) => (
					<div className="card" key={a.idempotencyKey}>
						<div className="card-head">
							<div>
								<span className="card-title">{a.tool}</span>{" "}
								<StatusBadge status={a.status} />
							</div>
							<div className="card-meta">{fmt(a.createdAt)}</div>
						</div>
						<div className="card-meta">
							agent:{" "}
							<Link href={`/agents/${encodeURIComponent(a.scope ?? "(unscoped)")}`}>
								{a.scope ?? "(unscoped)"}
							</Link>{" · "}cost {a.cost} · key {a.idempotencyKey}
						</div>
						{a.reason ? <div className="card-reason">“{a.reason}”</div> : null}
						<div className="row-actions">
							<form action={approveAction}>
								<input type="hidden" name="key" value={a.idempotencyKey} />
								<button className="approve" type="submit">
									Approve
								</button>
							</form>
							<form action={rejectAction}>
								<input type="hidden" name="key" value={a.idempotencyKey} />
								<input type="text" name="reason" placeholder="reason (optional)" />
								<button className="reject" type="submit">
									Reject
								</button>
							</form>
						</div>
					</div>
				))
			)}
		</>
	)
}
