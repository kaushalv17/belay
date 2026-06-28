# Changelog

All notable changes to Quorvel are documented here. This project follows
[Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **Multi-tenancy (Phase 1):** per-org scoping, Clerk auth/orgs/roles, self-serve
  API key management (create / rotate / revoke, live + test keys), guided
  onboarding, billing bound to orgs.
- **Billing depth (Phase 2):** Paddle hosted customer portal, plan + usage view.
- **Reliability (Phase 3/7):** optional per-caller rate limiter.
- **Observability (Phase 4):** audit log + audit API/UI hook, Sentry/OTel bootstrap.
- **Docs/trust (Phase 6):** OpenAPI spec, Mintlify docs skeleton, transactional
  email (Resend) templates, security.txt.
- **Ops (Phase 8):** GitHub Actions CI, Dependabot, Terraform skeleton, Python
  SDK + CLI skeletons, render.yaml blueprint.
