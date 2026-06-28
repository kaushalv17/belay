# Quorvel Production Runbook

This is your single, ordered, do-it-once guide to take Quorvel from "one
hard-coded org" to a real multi-tenant SaaS. Follow the steps **in order**. Each
step says exactly what to do, where, and how to verify it.

> SECURITY RULE (applies everywhere): never paste a **live** API key or webhook
> secret into chat, code, or a git commit. They go only into Render / Vercel
> environment tabs. Test/sandbox values are fine to experiment with.

Legend: \u2705 = code already in this bundle. \u2699\ufe0f = manual action you do in a
vendor dashboard or terminal. \U0001f9ea = how to verify.

---

## 0. What's in this bundle (code already written)

**Cloud API (`apps/api/src`)**
- `types.ts` \u2705 org billing fields, API key env/scopes/createdBy, `ApiKeyPublic`, `CreateApiKeyInput`, `AuditEntry`.
- `schema.ts` \u2705 idempotent ALTERs for new columns + `audit_log` table + indexes.
- `store.ts` / `pgStore.ts` \u2705 key list/get/revoke/last-used, org<->paddle customer, audit insert/list.
- `service.ts` \u2705 `createApiKey` / `rotateApiKey` / `revokeApiKey` / `listApiKeys`, `me`, `listAuditLog`, `createBillingPortal`, `seedSampleData`, last-used tracking, audit helper.
- `router.ts` \u2705 routes: `GET /v1/me`, `GET|POST /v1/account/keys`, `POST /v1/account/keys/:id/rotate`, `DELETE|POST /v1/account/keys/:id`, `GET /v1/audit`, `POST /v1/billing/portal`, `POST /v1/onboarding/sample`.
- `paddle.ts` \u2705 captures `customer_id` on webhook, `createBillingPortal()`.
- `server.ts` + `rateLimit.ts` \u2705 optional per-caller rate limiter (off unless `QUORVEL_RATE_LIMIT_PER_MIN>0`).
- `email.ts` \u2705 Resend transactional templates (welcome / key-created / usage-alert / dunning / receipt).
- `observability.ts` \u2705 lazy Sentry + OpenTelemetry bootstrap.

**Dashboard (`apps/dashboard`)**
- `lib/quorvel.ts` \u2705 client methods: `me`, `listKeys`, `createKey`, `rotateKey`, `revokeKey`, `auditLog`, `billingPortal`, `seedSample`.
- `app/settings/keys` \u2705 self-serve key UI (create/rotate/revoke, live+test, last-used).
- `app/settings/billing` \u2705 plan + usage + Paddle portal + upgrade.
- `app/settings/members` \u2705 Clerk `<OrganizationProfile/>` (members, roles, invites).
- `app/onboarding` \u2705 guided first-key -> install SDK -> sample data.
- `components/` \u2705 `ApiKeysManager`, `ManageBillingButton`, `OnboardingFlow`.
- `app/layout.tsx` \u2705 nav links; `app/globals.css` \u2705 styles for the new pages.

**Repo scaffolds**
- `render.yaml` \u2705 always-on API blueprint.
- `openapi/quorvel.yaml` \u2705 API spec (feeds the docs site).
- `docs/` \u2705 Mintlify skeleton. `sdks/python/` \u2705 Python SDK skeleton. `cli/` \u2705 `qrv` CLI skeleton.
- `.github/workflows/ci.yml` + `.github/dependabot.yml` \u2705 CI + dep scanning.
- `infra/terraform/` \u2705 IaC skeleton. `apps/dashboard/public/.well-known/security.txt` \u2705.
- `apps/api/.env.production.example` + `apps/dashboard/.env.production.example` \u2705. `CHANGELOG.md` \u2705.

**Honest scope note:** code for Phase 1, Phase 2 (portal), and the Phase 3/4/7
guardrails (rate limit, audit, email, observability) is real and syntax-checked.
Phases 5/6/7/8 ship as **working skeletons + this runbook** because most of
that work is vendor configuration (Clerk, Paddle, Neon, Sentry, Vanta, etc.),
not code. `.tsx` files can't be compiled in this offline sandbox, so build them
once locally (Step 1.0) and fix any import nits before deploying.

---

## STEP 1 \u2014 Integrate this bundle locally

### 1.0 Extract + install
\u2699\ufe0f From your repo root (the folder with `pnpm-workspace.yaml`):
```bash
# back up first
git add -A && git commit -m "checkpoint before phase 1-8 bundle" || true

# extract the bundle over your repo (it mirrors the same paths)
unzip -o quorvel-prod.zip -d .

pnpm install
```
\U0001f9ea `pnpm -r build` compiles the API. Then `cd apps/dashboard && pnpm build`
compiles the dashboard (this is where any `.tsx` nits surface; fix imports if so).

### 1.1 Run the API tests
```bash
pnpm --filter @quorvel/cloud-api test
```
\U0001f9ea All existing tests pass. The rate limiter is OFF by default so the
3-arg `handleRequest` tests are unaffected.

---

## STEP 2 \u2014 Auth, orgs, roles (Clerk)  [Phase 1]

> Step 2 of your build plan (clerk_org_id column, memberships, backfill) is
> already DONE in Neon. This wires the app to it.

### 2.1 Clerk dashboard \u2699\ufe0f
1. Create a Clerk app (or open the existing one) at dashboard.clerk.com.
2. **User & Authentication -> Email, Password, Google, GitHub** \u2014 enable email+password and the two OAuth providers.
3. **Organizations -> Enable Organizations.** Turn on "Allow users to create organizations". Set roles: owner, admin, member.
4. Copy `Publishable key` and `Secret key`.

### 2.2 Dashboard env \u2699\ufe0f
Fill `apps/dashboard/.env.local` from `.env.production.example` with the Clerk
keys, `QUORVEL_API_URL=http://localhost:8080`, and a shared
`DASHBOARD_SERVICE_SECRET` (generate once):
```bash
node -e "console.log('qrv_dash_' + require('crypto').randomBytes(32).toString('hex'))"
```
Put the SAME value in the API's env (Step 4.2).

\U0001f9ea Run both apps locally; sign up, then use the OrganizationSwitcher to
create an org. You should land on `/onboarding`.

---

## STEP 3 \u2014 Per-org scoping  [Phase 1]  (already integrated)

This bundle assumes Step 3 (the dashboard service-auth + `/v1/orgs/provision`
branch) is already in your tree from the earlier Step 3 drop-in. If you skipped
it, re-extract that part. \U0001f9ea Calling any `/v1/*` route from the dashboard
resolves the caller's org from the Clerk session, never a static key.

---

## STEP 4 \u2014 Self-serve API keys  [Phase 1]

### 4.1 Migrate the DB \u2699\ufe0f
The new columns/table are idempotent ALTERs in `schema.ts`, applied by the
migrate step on boot. To apply now against Neon:
```bash
cd apps/api
DATABASE_URL="<neon DIRECT url>" node scripts/migrate.mjs   # or: pnpm migrate
```
\U0001f9ea In Neon SQL editor: `api_keys` has `key_env`, `scopes`, `created_by`,
`last_used_at`, `revoked_at`; `orgs` has `paddle_customer_id`, `trial_ends_at`;
an `audit_log` table exists.

### 4.2 API env \u2699\ufe0f
Set `DASHBOARD_SERVICE_SECRET` (same as dashboard) and `QUORVEL_ADMIN_SECRET`.

### 4.3 Verify the key UI \U0001f9ea
In the dashboard: **Settings -> API keys**. Create a `live` key and a `test`
key; the secret shows once. Rotate one (old revokes, new secret shows). Revoke
one. Make an SDK call with a key and confirm `last used` updates.

---

## STEP 5 \u2014 Onboarding  [Phase 1]

The `/onboarding` page is live: **create first key -> install SDK -> see first
tracked action** (with a "Seed sample data" button for empty states).
\u2699\ufe0f Set Clerk `AFTER_SIGN_UP_URL=/onboarding` (done via env in 2.2).
\U0001f9ea A brand-new org sees empty states, can seed samples, and the samples
appear in Approvals + activity.

---

## STEP 6 \u2014 Bind billing to orgs  [Phase 1 + Phase 2]

### 6.1 Paddle catalog \u2699\ufe0f
In Paddle: create Pro and Scale **prices**; copy price IDs into
`PADDLE_PRICE_PRO` / `PADDLE_PRICE_SCALE`.

### 6.2 Webhook \u2699\ufe0f
Paddle -> Developer Tools -> Notifications: add a destination pointing at
`https://api.quorvel.tech/v1/webhooks/paddle`; subscribe to subscription +
transaction events; copy the **webhook secret** into `PADDLE_WEBHOOK_SECRET`.
The handler already captures `customer_id` and `custom_data.org_id`, mapping the
subscription to the org and storing the Paddle customer id.

### 6.3 Customer billing portal \u2699\ufe0f / \u2705
The **Settings -> Billing -> Manage billing** button opens Paddle's hosted
portal (update card, invoices, cancel). It requires the org to have completed a
checkout (so a `paddle_customer_id` exists).
\U0001f9ea Do a sandbox checkout; confirm the org's plan flips after the webhook,
and the portal opens.

### 6.4 Entitlement enforcement
The API already meters usage and returns `402` past plan limits; the dashboard
shows the usage bar. \u2699\ufe0f Confirm `PLANS` limits match your pricing.

### 6.5 Trials, dunning, save-flow (lifecycle)
\u2699\ufe0f In Paddle: enable a 14-day Pro trial on the price; turn on dunning
(failed-payment retries). Wire `email.ts` `dunning()` to the
`subscription.payment_failed` webhook, and `receipt()` to `transaction.completed`.

---

## STEP 7 \u2014 Get off Render free  [Phase 3.1]

\u2699\ufe0f Render -> Blueprints -> apply `render.yaml` (or upgrade the existing
service to the **Starter** always-on plan). Fill every `sync:false` env var in
the Render dashboard. Set `QUORVEL_RATE_LIMIT_PER_MIN=120`.
\U0001f9ea Hit `/health` twice with no ~50s cold start. Burst >120 req/min from one
key returns `429` with `x-ratelimit-*` headers.

---

## STEP 8 \u2014 Data layer hardening  [Phase 3]

\u2699\ufe0f Use the Neon **pooled** connection string (`-pooler`) for `DATABASE_URL`
(the app) and the **direct** string for migrations only. Enable Neon automated
backups / PITR; once a quarter do a restore drill into a branch and run the
tests against it. Add read replicas only when read load justifies it.

---

## STEP 9 \u2014 Durable execution + queue  [Phase 3]

\u2699\ufe0f Provision Redis (Upstash/Render) and set `REDIS_URL` so BullMQ is used
instead of the in-process bus. Then implement, in the worker:
- retries with exponential backoff + max attempts,
- a **dead-letter queue** for poison events + a `replay` action,
- concurrency + rate/throttle controls, scheduled/delayed jobs, cron,
- circuit breakers around Paddle/DB.
\U0001f9ea Kill Redis mid-run; jobs resume; a permanently failing job lands in the
DLQ and can be replayed.

---

## STEP 10 \u2014 Observability & product features  [Phase 4]

- **Audit log** \u2705 backend + `GET /v1/audit`. \u2699\ufe0f Add a `/settings/audit`
  page using `client.auditLog()` (same pattern as the keys page).
- **Run history / timeline / live tail / metrics** \u2699\ufe0f build on the existing
  actions list; add filters, a per-action timeline view, and a streaming logs
  endpoint (SSE).
- **Sentry/OTel** \u2705 bootstrap. \u2699\ufe0f `pnpm --filter @quorvel/cloud-api add
  @sentry/node @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node`,
  set `SENTRY_DSN` / `OTEL_EXPORTER_OTLP_ENDPOINT`, and call `initObservability()`
  at the top of `apps/api/src/index.ts`.
- **Alerting** \u2699\ufe0f wire the existing `alerts` module to Slack/PagerDuty/email.

---

## STEP 11 \u2014 SDK maturity & DX  [Phase 5]

- **Python SDK** \u2705 skeleton in `sdks/python`. \u2699\ufe0f add retries + parity tests, publish to PyPI.
- **CLI `qrv`** \u2705 skeleton in `cli`. \u2699\ufe0f implement `login` (device-code), `deploy`, `tail` streaming.
- **API versioning + Idempotency-Key** \u2699\ufe0f enforce `Idempotency-Key` on writes; keep `/v1` stable, branch `/v2` for breaking changes.
- **Outbound webhooks** \u2699\ufe0f signed + auto-retried deliveries with a delivery log + replay (new table + worker).
- **More adapters** \u2699\ufe0f Express, Cloudflare Workers, Lambda, Hono/Fastify.
- **Release hygiene** \u2705 `CHANGELOG.md`. \u2699\ufe0f add Changesets + a CI publish job.

---

## STEP 12 \u2014 Docs, support, trust  [Phase 6]

- **Docs site** \u2705 `docs/` Mintlify skeleton wired to `openapi/quorvel.yaml`.
  \u2699\ufe0f `npx mint dev` locally; deploy to `docs.quorvel.tech`.
- **Status page** \u2699\ufe0f BetterStack/Instatus at `status.quorvel.tech`, monitors on `/health`.
- **Transactional email** \u2705 templates. \u2699\ufe0f verify your domain in Resend, set `RESEND_API_KEY`, wire sends to the relevant webhooks/events.
- **Support** \u2699\ufe0f Discord + support@ routing + in-app help.

---

## STEP 13 \u2014 Security & compliance  [Phase 7]

- **security.txt** \u2705. **Dependabot** \u2705. **Rate limiting** \u2705.
- \u2699\ufe0f SOC 2 via Vanta/Drata; encryption at rest (Neon default) + TLS; secrets manager; key rotation policy.
- \u2699\ufe0f SSO/SAML + SCIM via Clerk's enterprise features; RBAC audit-log export.
- \u2699\ufe0f GDPR: build customer-triggered **data export** + **account/data deletion** endpoints (use the audit log + a delete job); add a cookie-consent banner on the marketing site.
- \u2699\ufe0f Annual pen test; write a DR runbook with tested restores (Step 8 drill).

---

## STEP 14 \u2014 Ops & growth  [Phase 8]

- **CI** \u2705 `.github/workflows/ci.yml`. \u2699\ufe0f add Playwright e2e + a staging environment + required status checks.
- **IaC** \u2705 `infra/terraform` skeleton. \u2699\ufe0f fill providers; manage staging + prod.
- \u2699\ufe0f Product analytics (PostHog), feature flags, log aggregation; track time-to-first-tracked-action ("aha" metric) and nudge.
- \u2699\ufe0f GTM: SEO, blog, comparison pages, lifecycle email, referral, annual/enterprise pricing.

---

## Appendix A \u2014 If Paddle rejects you
Fall back to **Lemon Squeezy** (also a Merchant of Record, lighter onboarding for
individuals). The billing seam (`paddle.ts` -> `BillingStore` interface) is
provider-agnostic enough that swapping the MoR is a contained change: implement
the same `createCheckout` / `createBillingPortal` / webhook-verify surface.

## Appendix B \u2014 Secret generation
```bash
# dashboard service secret / admin secret
node -e "console.log('qrv_dash_' + require('crypto').randomBytes(32).toString('hex'))"
```
Live keys + webhook secrets live ONLY in Render/Vercel env tabs.

## Appendix C \u2014 Critical path (don't boil the ocean)
1. Steps 2-6 (Phase 1 multi-tenant + billing binding).
2. Step 7 (always-on API).
3. Steps 6.3-6.5 + Step 10 (billing depth + observability).
4. Step 12 (docs).
5. Steps 11/13/14 (SDK breadth, compliance, growth) as you scale.
