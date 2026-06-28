"use client"

import { useState, useTransition } from "react"
import type { ApiKeyPublic } from "@/lib/quorvel"
import {
	createKeyAction,
	rotateKeyAction,
	revokeKeyAction,
} from "@/app/settings/keys/actions"

function fmt(iso?: string | null): string {
	if (!iso) return "never"
	return new Date(iso).toLocaleString()
}

export function ApiKeysManager({ initialKeys }: { initialKeys: ApiKeyPublic[] }) {
	const [keys, setKeys] = useState<ApiKeyPublic[]>(initialKeys)
	const [name, setName] = useState("")
	const [env, setEnv] = useState("live")
	const [secret, setSecret] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [pending, startTransition] = useTransition()

	function upsert(key: ApiKeyPublic) {
		setKeys((prev) => [key, ...prev.filter((k) => k.id !== key.id)])
	}

	function markRevoked(id: string) {
		setKeys((prev) =>
			prev.map((k) =>
				k.id === id ? { ...k, revokedAt: new Date().toISOString() } : k,
			),
		)
	}

	function onCreate() {
		setError(null)
		startTransition(async () => {
			try {
				const res = await createKeyAction({ name, env })
				setSecret(res.apiKey)
				upsert(res.key)
				setName("")
			} catch (e) {
				setError((e as Error).message)
			}
		})
	}

	function onRotate(id: string) {
		setError(null)
		startTransition(async () => {
			try {
				const res = await rotateKeyAction(id)
				markRevoked(id)
				setSecret(res.apiKey)
				upsert(res.key)
			} catch (e) {
				setError((e as Error).message)
			}
		})
	}

	function onRevoke(id: string) {
		setError(null)
		startTransition(async () => {
			try {
				await revokeKeyAction(id)
				markRevoked(id)
			} catch (e) {
				setError((e as Error).message)
			}
		})
	}

	return (
		<div className="keys">
			<div className="keys-create card">
				<h3>Create a new key</h3>
				<div className="keys-form">
					<input
						type="text"
						placeholder="Key name (e.g. production-worker)"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
					<select value={env} onChange={(e) => setEnv(e.target.value)}>
						<option value="live">live</option>
						<option value="test">test (sandbox)</option>
					</select>
					<button className="upgrade" onClick={onCreate} disabled={pending}>
						{pending ? "Working\u2026" : "Create key"}
					</button>
				</div>
				{error ? <p className="upgrade-err">{error}</p> : null}
			</div>

			{secret ? (
				<div className="keys-secret card">
					<h3>Copy your new key now</h3>
					<p className="subtle">
						This is the only time the full secret is shown. Store it in your
						secrets manager or environment &mdash; never commit it.
					</p>
					<code className="keys-secret-value">{secret}</code>
					<div className="keys-secret-actions">
						<button
							className="btn"
							onClick={() => navigator.clipboard?.writeText(secret)}
						>
							Copy
						</button>
						<button className="btn ghost" onClick={() => setSecret(null)}>
							Done
						</button>
					</div>
				</div>
			) : null}

			<table className="keys-table">
				<thead>
					<tr>
						<th>Name</th>
						<th>Prefix</th>
						<th>Env</th>
						<th>Scopes</th>
						<th>Last used</th>
						<th>Status</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{keys.length === 0 ? (
						<tr>
							<td colSpan={7} className="subtle">
								No keys yet. Create your first one above.
							</td>
						</tr>
					) : (
						keys.map((k) => {
							const revoked = Boolean(k.revokedAt)
							return (
								<tr key={k.id} className={revoked ? "revoked" : ""}>
									<td>{k.name}</td>
									<td>
										<code>{k.keyPrefix}&hellip;</code>
									</td>
									<td>{k.env}</td>
									<td>{(k.scopes ?? []).join(", ")}</td>
									<td>{fmt(k.lastUsedAt)}</td>
									<td>{revoked ? "revoked" : "active"}</td>
									<td className="keys-row-actions">
										{!revoked ? (
											<>
												<button
													className="btn"
													onClick={() => onRotate(k.id)}
													disabled={pending}
												>
													Rotate
												</button>
												<button
													className="btn ghost"
													onClick={() => onRevoke(k.id)}
													disabled={pending}
												>
													Revoke
												</button>
											</>
										) : null}
									</td>
								</tr>
							)
						})
					)}
				</tbody>
			</table>
		</div>
	)
}
