// Round-trip tests for Idempotency-Key replay on write endpoints.
//   same key + same body      => handler runs ONCE, second call replays the stored 2xx
//   same key + different body  => 422 idempotency_key_reuse
import { assert, it, section, summary } from "./_assert"
import { handleRequest, type RawRequest } from "../src/router"
import { MemStore } from "../src/store"
import { QuorvelCloudService } from "../src/service"

function req(over: Partial<RawRequest> = {}): RawRequest {
    return { method: "GET", path: "/", query: {}, body: undefined, headers: {}, ...over }
}

console.log("belay-cloud-api idempotency tests")
void (async () => {
    section("router (Idempotency-Key replay)")

    await it("same key + same body runs once and replays the stored 2xx", async () => {
        const store = new MemStore()
        const svc = new QuorvelCloudService(store)
        const { orgId, apiKey } = await svc.issueApiKey({})
        const headers = { authorization: `Bearer ${apiKey}`, "idempotency-key": "idem-1" }
        const body = { name: "ci-key" }
        const path = "/v1/account/keys"

        const first = await handleRequest(svc, undefined, req({ method: "POST", path, headers, body }))
        const second = await handleRequest(svc, undefined, req({ method: "POST", path, headers, body }))

        assert.equal(first.status, 201)
        assert.equal(second.status, 201)
        // Replayed, not re-run: identical response (same generated key id + plaintext).
        assert.deepEqual(second.body, first.body)
        // Ran once: only the org default key + the single key we created (not two).
        const keys = await svc.listApiKeys(orgId)
        assert.equal(keys.length, 2)
    })

    await it("same key + a different body => 422 idempotency_key_reuse", async () => {
        const store = new MemStore()
        const svc = new QuorvelCloudService(store)
        const { apiKey } = await svc.issueApiKey({})
        const headers = { authorization: `Bearer ${apiKey}`, "idempotency-key": "idem-2" }
        const path = "/v1/account/keys"

        const first = await handleRequest(svc, undefined, req({ method: "POST", path, headers, body: { name: "a" } }))
        const second = await handleRequest(svc, undefined, req({ method: "POST", path, headers, body: { name: "b" } }))

        assert.equal(first.status, 201)
        assert.equal(second.status, 422)
        assert.equal((second.body as { code: string }).code, "idempotency_key_reuse")
    })

    summary()
})()