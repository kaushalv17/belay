import Link from "next/link"
import { serverClient } from "../../../lib/server-client"
import { StatusBadge } from "../../../components/StatusBadge"

export const dynamic = "force-dynamic"

function fmt(iso: string): string {
	return new Date(iso).toLocaleString()
}

export default async function AgentTimelinePage({
	params,
}: {
	params: { scope: string }
}) {
	const scope = decodeURIComponent(params.scope)
	const recent = await serverClient().listRecent(200)
	const actions = recent.filter((a) => (a.scope ?? "(unscoped)") === scope)

	return (
		<>
			<p className="subtle">
				<Link href="/agents">← Agents</Link>
			</p>
			<h1>{scope}</h1>
			<p className="subtle">{actions.length} recent actions</p>

			{actions.length === 0 ? (
				<div className="empty">No actions recorded for this agent.</div>
			) : (
				<div className="timeline">
					{actions.map((a) => (
						<div className="event" key={a.idempotencyKey}>
							<div>
								<Link className="card-title" href={`/agents/${encodeURIComponent(scope)}/${encodeURIComponent(a.idempotencyKey)}`}>{a.tool}</Link>{" "}
								<StatusBadge status={a.status} />
							</div>
							<div className="when">
								{fmt(a.createdAt)} · cost {a.cost} · attempts {a.attempts} · {a.idempotencyKey}
							</div>
							{a.reason ? <div className="card-reason">“{a.reason}”</div> : null}
							{a.error ? <div className="card-reason">error: {a.error}</div> : null}
						</div>
					))}
				</div>
			)}
		</>
	)
}
