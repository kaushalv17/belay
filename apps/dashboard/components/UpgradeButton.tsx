"use client"

import { useCallback, useState } from "react"
import { startCheckout } from "../app/actions"

// Public client-side token (safe to ship in the browser). Falls back to the
// known live token so the dashboard works without extra env config, but can be
// overridden per-environment via NEXT_PUBLIC_PADDLE_CLIENT_TOKEN.
const PADDLE_CLIENT_TOKEN =
	process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? "live_2f6c5a2fc2044c85ff7a5fdc010"

const PADDLE_JS_SRC = "https://cdn.paddle.com/paddle/v2/paddle.js"

declare global {
	interface Window {
		Paddle?: any
	}
}

// Load + initialize Paddle.js exactly once, returning the ready Paddle global.
let paddleReady: Promise<any> | null = null
function ensurePaddle(): Promise<any> {
	if (typeof window === "undefined") {
		return Promise.reject(new Error("Paddle is only available in the browser"))
	}
	if (paddleReady) return paddleReady
	paddleReady = new Promise<any>((resolve, reject) => {
		const init = () => {
			try {
				window.Paddle.Initialize({
					token: PADDLE_CLIENT_TOKEN,
					eventCallback: (event: any) => {
						// After a successful payment the Paddle webhook flips the org
						// plan server-side; give it a moment, then refresh the page so
						// the usage bar shows the new plan.
						if (event?.name === "checkout.completed") {
							setTimeout(() => window.location.reload(), 2500)
						}
					},
				})
				resolve(window.Paddle)
			} catch (err) {
				reject(err)
			}
		}
		if (window.Paddle) {
			init()
			return
		}
		const existing = document.getElementById("paddle-js") as HTMLScriptElement | null
		if (existing) {
			existing.addEventListener("load", init)
			existing.addEventListener("error", () =>
				reject(new Error("Failed to load Paddle.js")),
			)
			return
		}
		const script = document.createElement("script")
		script.id = "paddle-js"
		script.src = PADDLE_JS_SRC
		script.async = true
		script.onload = init
		script.onerror = () => reject(new Error("Failed to load Paddle.js"))
		document.head.appendChild(script)
	})
	return paddleReady
}

export function UpgradeButton({
	plan,
	label,
}: {
	plan: "pro" | "scale"
	label: string
}) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const onClick = useCallback(async () => {
		setBusy(true)
		setError(null)
		try {
			const Paddle = await ensurePaddle()
			const { transactionId } = await startCheckout(plan)
			if (!transactionId) throw new Error("No transaction returned")
			Paddle.Checkout.open({ transactionId })
		} catch (err) {
			setError(err instanceof Error ? err.message : "Checkout failed")
		} finally {
			setBusy(false)
		}
	}, [plan])

	return (
		<>
			<button className="upgrade" type="button" onClick={onClick} disabled={busy}>
				{busy ? "Opening\u2026" : label}
			</button>
			{error ? <span className="upgrade-err">{error}</span> : null}
		</>
	)
}
