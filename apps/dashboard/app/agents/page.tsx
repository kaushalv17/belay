import Link from "next/link"
import { serverClient } from "../../lib/server-client"
import { groupByScope } from "../../lib/quorvel"

export const dynamic = "force-dynamic"

export default async function AgentsPage() {
	const client = serverClient()
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const [recent, m] = await Promise.all([
        client.listRecent(200),
        client.metrics({ since }),
    ])
	const grouped = groupByScope(recent)
	const scopes = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)

	return (
		<>
			<h1>Agents</h1>
			<p className="subtle">Recent activity grouped by agent scope. Click through for a full timeline.</p>

            <div className="usage-bar">
                <div className="stat">
                    <b>{m.runs}</b>
                    <span>runs &middot; last 30d</span>
                </div>
                <div className="stat">
                    <b>{(m.errorRate * 100).toFixed(1)}%</b>
                    <span>error rate</span>
                </div>
                <div className="stat">
                    <b>{Math.round(m.latencyMs.p50)} ms</b>
                    <span>p50 latency</span>
                </div>
                <div className="stat">
                    <b>{Math.round(m.latencyMs.p95)} ms</b>
                    <span>p95 latency</span>
                </div>
                <div className="stat">
                    <b>
                        {m.usage.used}
                        {Number.isFinite(m.usage.limit) ? ` / ${m.usage.limit}` : " / unlimited"}
                    </b>
                    <span>{m.usage.plan} plan &middot; {m.usage.period}</span>
                </div>
            </div>

			{scopes.length === 0 ? (
				<div className="empty">No activity yet.</div>
			) : (
				<div className="agent-grid">
					{scopes.map(([scope, actions]) => {
						const waiting = actions.filter((a) => a.status === "awaiting_approval").length
						return (
							<Link
								className="card agent-card"
								key={scope}
								href={`/agents/${encodeURIComponent(scope)}`}
							>
								<div className="count">{actions.length}</div>
								<div className="card-title">{scope}</div>
								<div className="card-meta">
									{waiting > 0 ? `${waiting} awaiting approval` : "all clear"}
								</div>
							</Link>
						)
					})}
				</div>
			)}
		</>
	)
}
