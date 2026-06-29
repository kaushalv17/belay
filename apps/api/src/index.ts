// Package entrypoint + process bootstrap.
// Re-exports the public surface (so @quorvel/cloud-api can be imported as a
// library by the dashboard''s contract tests) and, when run directly, starts the
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

    // --- Graceful shutdown ---
    // Platforms (Render, etc.) send SIGTERM on deploy/restart, then SIGKILL after
    // a grace window (~30s on Render). Stop accepting new connections, let
    // in-flight requests finish (app.close drains them), then close the DB pool.
    let shuttingDown = false
    const shutdown = async (signal: string) => {
        if (shuttingDown) return
        shuttingDown = true
        console.log(`[shutdown] received ${signal}, draining in-flight requests...`)
        const hardTimeout = setTimeout(() => {
            console.error("[shutdown] drain timed out after 10s, forcing exit")
            process.exit(1)
        }, 10_000)
        hardTimeout.unref()
        try {
            await app.close()
            if (pool) await pool.end()
            clearTimeout(hardTimeout)
            console.log("[shutdown] clean exit")
            process.exit(0)
        } catch (e) {
            console.error("[shutdown] error during shutdown", e)
            process.exit(1)
        }
    }
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
        process.on(sig, () => void shutdown(sig))
    }
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