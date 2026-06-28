// Package entrypoint + process bootstrap.
// Re-exports the public surface (so @quorvel/cloud-api can be imported as a
// library by the dashboard's contract tests) and, when run directly, starts the
// Fastify server with the full production wiring.
import { fileURLToPath } from "node:url"
import path from "node:path"
import { Pool } from "pg"
import { migrate } from "./migrate"
import { buildServer } from "./server"
import { MemStore, type Store } from "./store"
import { PgStore } from "./pgStore"
import { buildDeps } from "./wiring"
import type { SqlPool } from "./billing"

export * from "./types"
export * from "./store"
export * from "./service"
export * from "./router"
export * from "./events"
export * from "./bus"
export * from "./queue"
export * from "./alerts"
export * from "./billing"
export { buildServer } from "./server"
export { buildDeps } from "./wiring"

export async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL
	let store: Store
	let pool: Pool | undefined
	if (databaseUrl) {
		pool = new Pool({ connectionString: databaseUrl })
		await migrate(pool)
		store = new PgStore(pool)
	} else {
		store = new MemStore()
	}
	const { deps } = buildDeps(store, { pool: pool as unknown as SqlPool | undefined })
	const app = buildServer(store, { adminSecret: process.env.QUORVEL_ADMIN_SECRET, deps })
	const port = Number(process.env.PORT ?? 8080)
	await app.listen({ port, host: "0.0.0.0" })
	console.log(`belay-cloud-api listening on :${port}`)
}

const isMain = (() => {
	try {
		if (typeof process === "undefined" || !process.argv[1]) return false
		return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
	} catch {
		return false
	}
})()
if (isMain) {
	main().catch((e) => {
		console.error(e)
		process.exit(1)
	})
}
