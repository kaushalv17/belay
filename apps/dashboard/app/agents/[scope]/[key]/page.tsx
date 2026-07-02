import Link from "next/link"
import { notFound } from "next/navigation"
import { serverClient } from "../../../../lib/server-client"
import { StatusBadge } from "../../../../components/StatusBadge"
import { QuorvelApiError, type RunTimeline } from "../../../../lib/quorvel"

export const dynamic = "force-dynamic"

function fmt(iso: string): string {
    return new Date(iso).toLocaleString()
}

export default async function RunTimelinePage({
    params,
}: {
    params: { scope: string; key: string }
}) {
    const scope = decodeURIComponent(params.scope)
    const key = decodeURIComponent(params.key)

    let timeline: RunTimeline
    try {
        timeline = await serverClient().runTimeline(key)
    } catch (e) {
        if (e instanceof QuorvelApiError && e.status === 404) notFound()
        throw e
    }

    const { action, events } = timeline

    return (
        <>
            <p className="subtle">
                <Link href={`/agents/${encodeURIComponent(scope)}`}>&larr; {scope}</Link>
            </p>
            <h1>{action.tool}</h1>
            <p className="subtle">
                <StatusBadge status={action.status} /> &middot; cost {action.cost} &middot;
                attempts {action.attempts} &middot; <code>{action.idempotencyKey}</code>
            </p>

            <div className="card">
                <div className="card-title">Request</div>
                <pre className="code-block">{JSON.stringify(action.args, null, 2)}</pre>
                {action.result !== undefined ? (
                    <>
                        <div className="card-title">Result</div>
                        <pre className="code-block">
                            {JSON.stringify(action.result, null, 2)}
                        </pre>
                    </>
                ) : null}
                {action.reason ? <div className="card-reason">{action.reason}</div> : null}
                {action.error ? (
                    <div className="card-reason">error: {action.error}</div>
                ) : null}
            </div>

            <h1>Event trail</h1>
            {events.length === 0 ? (
                <div className="empty">No events recorded for this run yet.</div>
            ) : (
                <div className="timeline">
                    {events.map((ev) => (
                        <div className="event" key={ev.id}>
                            <div>
                                <span className="card-title">{ev.type}</span>{" "}
                                <StatusBadge status={ev.status} />
                            </div>
                            <div className="when">
                                {fmt(ev.at)} &middot; attempt {ev.attempt}
                            </div>
                            {ev.reason ? (
                                <div className="card-reason">{ev.reason}</div>
                            ) : null}
                            {ev.error ? (
                                <div className="card-reason">error: {ev.error}</div>
                            ) : null}
                        </div>
                    ))}
                </div>
            )}
        </>
    )
}