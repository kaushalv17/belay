"use client"

import { useState, useTransition } from "react"
import { openPortalAction } from "@/app/settings/billing/actions"

// Sends the user to Paddle's hosted billing portal (update card, invoices,
// cancel). The URL is generated server-side per request.
export function ManageBillingButton() {
	const [pending, startTransition] = useTransition()
	const [error, setError] = useState<string | null>(null)

	function onClick() {
		setError(null)
		startTransition(async () => {
			try {
				const { url } = await openPortalAction()
				window.location.href = url
			} catch (e) {
				setError((e as Error).message)
			}
		})
	}

	return (
		<div className="manage-billing">
			<button className="btn" onClick={onClick} disabled={pending}>
				{pending ? "Opening\u2026" : "Manage billing"}
			</button>
			{error ? <p className="upgrade-err">{error}</p> : null}
		</div>
	)
}
