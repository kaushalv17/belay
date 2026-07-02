// Phase 4-D - HTTP CRUD for alert rules + plan-feature gating. End-to-end
// through handleRequest with a MemStore + MemAlertRuleStore, authenticating
// with a real issued key.
import { assert, it, section, summary } from "./_assert"
import { handleRequest, type RawRequest } from "../src/router"
import { QuorvelCloudService } from "../src/service"
import { MemStore } from "../src/store"
import { MemAlertRuleStore } from "../src/alertRules"

const ADMIN = "admin-secret"

function newSvc() {
    return new QuorvelCloudService(new MemStore(), { alertRuleStore: new MemAlertRuleStore() })
}

async function call(svc: QuorvelCloudService, req: Partial<RawRequest>) {
    return handleRequest(svc, ADMIN, {
        method: req.method ?? "GET",
        path: req.path ?? "/",
        query: req.query ?? {},
        body: req.body,
        headers: req.headers ?? {},
    })
}

async function authFor(svc: QuorvelCloudService) {
    const { apiKey } = await svc.issueApiKey({})
    return { authorization: `Bearer ${apiKey}` }
}

async function authForPlan(svc: QuorvelCloudService, plan: string) {
    const { apiKey } = await svc.issueApiKey({ plan })
    return { authorization: `Bearer ${apiKey}` }
}

function mkRule(name: string) {
    return { name, trigger: "failed", channels: ["slack"] }
}

console.log("belay-cloud-api alert-rules HTTP tests")

await (async () => {
    section("alert-rules CRUD over HTTP")

    await it("requires auth", async () => {
        const svc = newSvc()
        assert.equal((await call(svc, { method: "GET", path: "/v1/alert-rules", headers: {} })).status, 401)
    })

    await it("POST creates a rule (201) and GET lists it", async () => {
        const svc = newSvc()
        const auth = await authFor(svc)
        const created = await call(svc, {
            method: "POST",
            path: "/v1/alert-rules",
            headers: auth,
            body: { name: "approvals", trigger: "awaiting_approval", channels: ["slack"] },
        })
        assert.equal(created.status, 201)
        assert.equal((created.body as any).name, "approvals")
        assert.ok((created.body as any).id)
        const list = await call(svc, { method: "GET", path: "/v1/alert-rules", headers: auth })
        assert.equal(list.status, 200)
        assert.equal((list.body as any[]).length, 1)
    })

    await it("rejects an invalid trigger with 400", async () => {
        const svc = newSvc()
        const auth = await authFor(svc)
        const res = await call(svc, {
            method: "POST",
            path: "/v1/alert-rules",
            headers: auth,
            body: { name: "bad", trigger: "explode", channels: ["slack"] },
        })
        assert.equal(res.status, 400)
    })

    await it("POST /:id updates only the provided fields", async () => {
        const svc = newSvc()
        const auth = await authFor(svc)
        const created = await call(svc, {
            method: "POST",
            path: "/v1/alert-rules",
            headers: auth,
            body: { name: "n", trigger: "failed", channels: ["slack"] },
        })
        const id = (created.body as any).id as string
        const upd = await call(svc, {
            method: "POST",
            path: `/v1/alert-rules/${id}`,
            headers: auth,
            body: { enabled: false, channels: ["email"] },
        })
        assert.equal(upd.status, 200)
        assert.equal((upd.body as any).enabled, false)
        assert.deepEqual((upd.body as any).channels, ["email"])
        assert.equal((upd.body as any).trigger, "failed")
    })

    await it("DELETE /:id removes a rule; a second delete is 404", async () => {
        const svc = newSvc()
        const auth = await authFor(svc)
        const created = await call(svc, {
            method: "POST",
            path: "/v1/alert-rules",
            headers: auth,
            body: { name: "n", trigger: "denied", channels: ["slack"] },
        })
        const id = (created.body as any).id as string
        assert.equal((await call(svc, { method: "DELETE", path: `/v1/alert-rules/${id}`, headers: auth })).status, 200)
        assert.equal((await call(svc, { method: "DELETE", path: `/v1/alert-rules/${id}`, headers: auth })).status, 404)
        assert.equal(((await call(svc, { method: "GET", path: "/v1/alert-rules", headers: auth })).body as any[]).length, 0)
    })

    await it("rules are tenant-isolated", async () => {
        const svc = newSvc()
        const a = await authFor(svc)
        const b = await authFor(svc)
        await call(svc, {
            method: "POST",
            path: "/v1/alert-rules",
            headers: a,
            body: { name: "mine", trigger: "failed", channels: ["slack"] },
        })
        assert.equal(((await call(svc, { method: "GET", path: "/v1/alert-rules", headers: b })).body as any[]).length, 0)
    })

    section("plan-feature gating")

    await it("enforces the free-plan alert-rule cap (max 1)", async () => {
        const svc = newSvc()
        const auth = await authFor(svc)
        const first = await call(svc, { method: "POST", path: "/v1/alert-rules", headers: auth, body: mkRule("one") })
        assert.equal(first.status, 201)
        const second = await call(svc, { method: "POST", path: "/v1/alert-rules", headers: auth, body: mkRule("two") })
        assert.equal(second.status, 403)
        // the denied rule never landed - still exactly one
        assert.equal(((await call(svc, { method: "GET", path: "/v1/alert-rules", headers: auth })).body as any[]).length, 1)
    })

    await it("a higher plan lifts the cap (pro allows several)", async () => {
        const svc = newSvc()
        const auth = await authForPlan(svc, "pro")
        for (const n of ["a", "b", "c"]) {
            const res = await call(svc, { method: "POST", path: "/v1/alert-rules", headers: auth, body: mkRule(n) })
            assert.equal(res.status, 201)
        }
        assert.equal(((await call(svc, { method: "GET", path: "/v1/alert-rules", headers: auth })).body as any[]).length, 3)
    })

    summary()
})()