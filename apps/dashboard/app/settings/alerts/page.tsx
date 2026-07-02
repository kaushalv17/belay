import { serverClient } from "../../../lib/server-client"
import type { AlertRuleRecord } from "../../../lib/quorvel"
import { createAlertRuleAction, toggleAlertRuleAction, deleteAlertRuleAction } from "./actions"

export const dynamic = "force-dynamic"

const TRIGGER_LABELS: Record<string, string> = {
    awaiting_approval: "Awaiting approval",
    denied: "Policy denied",
    failed: "Action failed",
}

export default async function AlertsPage() {
    const rules = await serverClient().listAlertRules()

    return (
        <>
            <h1>Alert rules</h1>
            <p className="subtle">
                Route alerts to specific channels per trigger. With no rules, every alert fans out to all
                configured channels.
            </p>

            <div className="card">
                <h2>New rule</h2>
                <form action={createAlertRuleAction} className="alert-form">
                    <input name="name" placeholder="Rule name" required />
                    <select name="trigger" defaultValue="awaiting_approval">
                        <option value="awaiting_approval">Awaiting approval</option>
                        <option value="denied">Policy denied</option>
                        <option value="failed">Action failed</option>
                    </select>
                    <input name="scope" placeholder="Scope (optional, e.g. agent-billing)" />
                    <input name="channels" placeholder="Channels (comma-separated: slack, webhook, email)" />
                    <button type="submit">Create rule</button>
                </form>
            </div>

            {rules.length === 0 ? (
                <div className="empty">No alert rules yet - alerts fan out to every configured channel.</div>
            ) : (
                <div className="alert-list">
                    {rules.map((rule: AlertRuleRecord) => (
                        <div className="card alert-rule" key={rule.id}>
                            <div className="alert-rule-main">
                                <div className="card-title">{rule.name}</div>
                                <div className="card-meta">
                                    {TRIGGER_LABELS[rule.trigger] ?? rule.trigger}
                                    {rule.scope ? ` - ${rule.scope}` : " - all scopes"}
                                </div>
                                <div className="alert-channels">
                                    {rule.channels.length > 0 ? (
                                        rule.channels.map((c) => (
                                            <span className="badge" key={c}>
                                                {c}
                                            </span>
                                        ))
                                    ) : (
                                        <span className="subtle">no channels</span>
                                    )}
                                </div>
                            </div>
                            <div className="alert-rule-actions">
                                <span className={rule.enabled ? "badge badge-on" : "badge badge-off"}>
                                    {rule.enabled ? "enabled" : "disabled"}
                                </span>
                                <form action={toggleAlertRuleAction}>
                                    <input type="hidden" name="id" value={rule.id} />
                                    <input type="hidden" name="enabled" value={rule.enabled ? "false" : "true"} />
                                    <button type="submit">{rule.enabled ? "Disable" : "Enable"}</button>
                                </form>
                                <form action={deleteAlertRuleAction}>
                                    <input type="hidden" name="id" value={rule.id} />
                                    <button type="submit" className="danger">
                                        Delete
                                    </button>
                                </form>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </>
    )
}