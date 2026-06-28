"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { provisionAction, seedSampleAction } from "@/app/onboarding/actions"

// Guided post-signup flow (Phase 1 / Step 5): provision org -> create first key
// -> install SDK -> see a first tracked action (via sample data).
export function OnboardingFlow({ hasActions }: { hasActions: boolean }) {
	const [apiKey, setApiKey] = useState<string | null>(null)
	const [seeded, setSeeded] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [pending, startTransition] = useTransition()

	function onProvision() {
		setError(null)
		startTransition(async () => {
			try {
				const res = await provisionAction()
				if (res.apiKey) setApiKey(res.apiKey)
				else
					setError(
						"Org already set up \u2014 manage keys in Settings \u2192 API keys.",
					)
			} catch (e) {
				setError((e as Error).message)
			}
		})
	}

	function onSeed() {
		setError(null)
		startTransition(async () => {
			try {
				await seedSampleAction()
				setSeeded(true)
			} catch (e) {
				setError((e as Error).message)
			}
		})
	}

	const install =
		'npm install @quorvel/sdk\n\nimport { Quorvel } from "@quorvel/sdk"\nconst qrv = new Quorvel({ apiKey: process.env.QUORVEL_API_KEY })'

	return (
		<ol className="onboarding">
			<li className="card">
				<h3>1. Create your first API key</h3>
				<p className="subtle">
					Provision this organization and mint a key to authenticate the SDK.
				</p>
				<button className="upgrade" onClick={onProvision} disabled={pending}>
					{pending ? "Working\u2026" : "Create first key"}
				</button>
				{apiKey ? (
					<div className="keys-secret">
						<p className="subtle">
							Copy this now &mdash; it won&apos;t be shown again:
						</p>
						<code className="keys-secret-value">{apiKey}</code>
						<button
							className="btn"
							onClick={() => navigator.clipboard?.writeText(apiKey)}
						>
							Copy
						</button>
					</div>
				) : null}
			</li>

			<li className="card">
				<h3>2. Install the SDK</h3>
				<pre className="code-block">
					<code>{install}</code>
				</pre>
			</li>

			<li className="card">
				<h3>3. See your first tracked action</h3>
				<p className="subtle">
					Track an action from your code, or seed a few samples to explore the
					dashboard right away.
				</p>
				<button className="btn" onClick={onSeed} disabled={pending}>
					{pending ? "Working\u2026" : "Seed sample data"}
				</button>
				{seeded || hasActions ? (
					<p className="subtle">
						You have tracked actions. <Link href="/">Open the dashboard &rarr;</Link>
					</p>
				) : null}
			</li>

			{error ? <p className="upgrade-err">{error}</p> : null}
		</ol>
	)
}
