// Thin Fastify adapter. It only translates HTTP <-> RawRequest/RawResponse and
// delegates ALL logic to handleRequest (router.ts), so what we unit-test is what
// serves traffic.
import Fastify from "fastify"
import { handleRequest, API_VERSION } from "./router"
import { FixedWindowRateLimiter } from "./rateLimit"
import { QuorvelCloudService, type ServiceDeps } from "./service"
import type { Store } from "./store"

export interface ServerOptions {
    adminSecret?: string
    dashboardSecret?: string
    deps?: ServiceDeps
}

export function buildServer(store: Store, opts: ServerOptions = {}) {
    const app = Fastify({ logger: false })

    // Capture the raw JSON body so webhook signatures can be verified.
    app.addContentTypeParser(
        "application/json",
        { parseAs: "string" },
        (req: any, body: any, done: any) => {
            ;(req as any).rawBody = body
            if (!body) return done(null, undefined)
            try {
                done(null, JSON.parse(body as string))
            } catch (err) {
                done(err as Error, undefined)
            }
        },
    )

    const svc = new QuorvelCloudService(store, opts.deps)
    const adminSecret = opts.adminSecret ?? process.env.QUORVEL_ADMIN_SECRET
    const dashboardSecret = opts.dashboardSecret ?? process.env.DASHBOARD_SERVICE_SECRET

    const rlMax = Number(process.env.QUORVEL_RATE_LIMIT_PER_MIN ?? 0)
    const limiter = rlMax > 0 ? new FixedWindowRateLimiter(rlMax) : undefined
    if (limiter) {
        app.addHook("onRequest", async (req: any, reply: any) => {
            const url: string = req.url ?? "/"
            if (!url.startsWith("/v1/")) return
            const auth = req.headers?.["authorization"]
            const org = req.headers?.["x-clerk-org-id"]
            const ip = req.ip ?? "anon"
            const key = String(auth || org || ip)
            const r = limiter.check(key)
            reply.header("x-ratelimit-limit", String(r.limit))
            reply.header("x-ratelimit-remaining", String(r.remaining))
            if (!r.allowed) {
                reply.code(429)
                return reply.send({ error: "rate limit exceeded", code: "rate_limited" })
            }
        })
    }

    app.all("/*", async (req: any, reply: any) => {
        const url: string = req.url ?? "/"
        const path = url.split("?")[0]
        const res = await handleRequest(svc, adminSecret, {
            method: req.method,
            path,
            query: req.query ?? {},
            body: req.body,
            headers: req.headers ?? {},
            rawBody: (req as any).rawBody,
        }, dashboardSecret)
        reply.header("x-api-version", API_VERSION)
        reply.code(res.status)
        return res.body ?? null
    })

    return app
}