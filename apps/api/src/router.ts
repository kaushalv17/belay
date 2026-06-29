// Framework-agnostic HTTP router. This is the SINGLE source of request handling:
// both the Fastify adapter (server.ts) and the HostedLedger round-trip tests
// call handleRequest, so the code under test is the code that runs.
import { ApiError, QuorvelCloudService } from "./service"
import type { ActionStatus } from "./types"

/** The public API contract version. All public routes live under `/v1`. */
export const API_VERSION = "1"

export interface RawRequest {
    method: string
    path: string
    query: Record<string, string | undefined>
    body: any
    headers: Record<string, string | undefined>
    rawBody?: string
}

export interface RawResponse {
    status: number
    body?: unknown
}

const notFound: RawResponse = { status: 404, body: { error: "not found", code: "not_found" } }

async function resolveDashboardOrg(
    svc: QuorvelCloudService,
    dashboardSecret: string | undefined,
    req: RawRequest,
): Promise<{ orgId: string }> {
    if (!dashboardSecret || req.headers["x-dashboard-secret"] !== dashboardSecret) {
        throw new ApiError("invalid dashboard secret", 401, "unauthorized")
    }
    return svc.authenticateDashboard(
        req.headers["x-clerk-org-id"],
        req.headers["x-clerk-user-id"],
        req.headers["x-clerk-org-name"],
    )
}

export async function handleRequest(
    svc: QuorvelCloudService,
    adminSecret: string | undefined,
    req: RawRequest,
    dashboardSecret?: string,
): Promise<RawResponse> {
    try {
        if (req.method === "GET" && req.path === "/health") {
            return { status: 200, body: { ok: true, service: "belay-cloud-api", version: API_VERSION } }
        }

        if (req.method === "POST" && req.path === "/v1/keys") {
            if (!adminSecret || req.headers["x-admin-secret"] !== adminSecret) {
                return { status: 401, body: { error: "admin secret required", code: "unauthorized" } }
            }
            return { status: 201, body: await svc.issueApiKey(req.body ?? {}) }
        }

        if (req.method === "POST" && req.path === "/v1/webhooks/paddle") {
            return {
                status: 200,
                body: await svc.handlePaddleWebhook(
                    req.rawBody ?? "",
                    req.headers["paddle-signature"],
                ),
            }
        }

        if (req.method === "POST" && req.path === "/v1/orgs/provision") {
            if (!dashboardSecret || req.headers["x-dashboard-secret"] !== dashboardSecret) {
                return { status: 401, body: { error: "dashboard secret required", code: "unauthorized" } }
            }
            const body = req.body ?? {}
            return {
                status: 200,
                body: await svc.provisionOrg({
                    ...body,
                    clerkOrgId: req.headers["x-clerk-org-id"] ?? body.clerkOrgId,
                    clerkUserId: req.headers["x-clerk-user-id"] ?? body.clerkUserId,
                    orgName: req.headers["x-clerk-org-name"] ?? body.orgName,
                }),
            }
        }

        const { orgId } =
            req.headers["x-dashboard-secret"] !== undefined
                ? await resolveDashboardOrg(svc, dashboardSecret, req)
                : await svc.authenticate(req.headers["authorization"])

        const actorId = req.headers["x-clerk-user-id"]

        const runOrgScoped = async (): Promise<RawResponse> => {
            if (req.path === "/v1/billing/checkout" && req.method === "POST") {
                return { status: 200, body: await svc.createCheckout(orgId, req.body ?? {}) }
            }

            if (req.path === "/v1/usage" && req.method === "GET") {
                return { status: 200, body: await svc.usage(orgId) }
            }

            if (req.path === "/v1/me" && req.method === "GET") {
                return { status: 200, body: await svc.me(orgId) }
            }

            if (req.path === "/v1/account/keys") {
                if (req.method === "GET") {
                    return { status: 200, body: await svc.listApiKeys(orgId) }
                }
                if (req.method === "POST") {
                    const b = req.body ?? {}
                    return {
                        status: 201,
                        body: await svc.createApiKey(orgId, {
                            name: b.name,
                            env: b.env,
                            scopes: b.scopes,
                            createdBy: actorId,
                        }),
                    }
                }
            }

            const keyMatch = req.path.match(/^\/v1\/account\/keys\/([^/]+)(\/rotate)?$/)
            if (keyMatch) {
                const id = decodeURIComponent(keyMatch[1])
                if (keyMatch[2] === "/rotate" && req.method === "POST") {
                    return { status: 201, body: await svc.rotateApiKey(orgId, id, actorId) }
                }
                if (!keyMatch[2] && (req.method === "DELETE" || req.method === "POST")) {
                    return { status: 200, body: await svc.revokeApiKey(orgId, id, actorId) }
                }
            }

            if (req.path === "/v1/audit" && req.method === "GET") {
                const limit = req.query.limit != null ? Number(req.query.limit) : undefined
                return { status: 200, body: await svc.listAuditLog(orgId, limit) }
            }

            // Dead-letter queue: operator visibility + manual replay/discard.
            if (req.path === "/v1/dlq" && req.method === "GET") {
                const limit = req.query.limit != null ? Number(req.query.limit) : undefined
                return { status: 200, body: await svc.listDeadLetters(orgId, limit) }
            }

            const dlqMatch = req.path.match(/^\/v1\/dlq\/([^/]+)(\/replay)?$/)
            if (dlqMatch) {
                const id = decodeURIComponent(dlqMatch[1])
                if (dlqMatch[2] === "/replay") {
                    if (req.method === "POST") {
                        return { status: 200, body: await svc.replayDeadLetter(orgId, id) }
                    }
                } else {
                    if (req.method === "GET") {
                        return { status: 200, body: await svc.getDeadLetter(orgId, id) }
                    }
                    if (req.method === "DELETE") {
                        return { status: 200, body: await svc.discardDeadLetter(orgId, id) }
                    }
                }
            }

            if (req.path === "/v1/billing/portal" && req.method === "POST") {
                return { status: 200, body: await svc.createBillingPortal(orgId) }
            }

            if (req.path === "/v1/onboarding/sample" && req.method === "POST") {
                return { status: 200, body: await svc.seedSampleData(orgId) }
            }

            if (req.path === "/v1/actions" && req.method === "POST") {
                return { status: 200, body: await svc.insertPending(orgId, req.body ?? {}) }
            }

            if (req.path === "/v1/actions" && req.method === "GET") {
                const status = req.query.status as ActionStatus | undefined
                const limit = req.query.limit != null ? Number(req.query.limit) : undefined
                const rows = status
                    ? await svc.listByStatus(orgId, status, limit)
                    : await svc.listRecent(orgId, limit)
                return { status: 200, body: rows }
            }

            if (req.path === "/v1/stats" && req.method === "POST") {
                const b = req.body ?? {}
                return {
                    status: 200,
                    body: await svc.stats(orgId, {
                        scope: b.scope ?? null,
                        tool: b.tool,
                        since: b.since ?? null,
                    }),
                }
            }

            const m = req.path.match(/^\/v1\/actions\/([^/]+)(\/[a-z-]+)?$/)
            if (m) {
                const key = decodeURIComponent(m[1])
                const sub = m[2]
                const body = req.body ?? {}
                if (!sub && req.method === "GET") {
                    const action = await svc.getAction(orgId, key)
                    return action ? { status: 200, body: action } : notFound
                }
                if (req.method === "POST") {
                    switch (sub) {
                        case "/running":
                            await svc.markRunning(orgId, key)
                            return { status: 204 }
                        case "/succeeded":
                            await svc.markSucceeded(orgId, key, body.result)
                            return { status: 204 }
                        case "/failed":
                            await svc.markFailed(orgId, key, body.error)
                            return { status: 204 }
                        case "/awaiting-approval":
                            await svc.markAwaitingApproval(orgId, key, body.reason)
                            return { status: 204 }
                        case "/approved":
                            await svc.markApproved(orgId, key)
                            return { status: 204 }
                        case "/rejected":
                            await svc.markRejected(orgId, key, body.reason)
                            return { status: 204 }
                        case "/denied":
                            await svc.markDenied(orgId, key, body.reason)
                            return { status: 204 }
                    }
                }
            }

            return notFound
        }

        const idemKey = req.headers["idempotency-key"]
        if (idemKey && (req.method === "POST" || req.method === "DELETE")) {
            return await svc.withIdempotency(
                orgId,
                idemKey,
                { method: req.method, path: req.path, body: req.body ?? null },
                runOrgScoped,
            )
        }

        return runOrgScoped()
    } catch (e) {
        if (e instanceof ApiError) {
            return { status: e.statusCode, body: { error: e.message, code: e.code } }
        }
        const msg = e instanceof Error ? e.message : "internal error"
        return { status: 500, body: { error: msg, code: "internal" } }
    }
}