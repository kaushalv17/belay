// Phase 0 — idempotency
export { idempotencyKey, canonicalize } from "./idempotency.js"
export type { IdempotencyKeyInput } from "./idempotency.js"

// Phase 1 + 2 — exactly-once run, approvals
export {
  run,
  approve,
  reject,
  listPendingApprovals,
} from "./run.js"
export type { RunOptions } from "./run.js"

// Errors
export {
  DuplicateInFlightError,
  ApprovalRequiredError,
  PolicyDeniedError,
  ActionRejectedError,
} from "./errors.js"

// Ledger
export { InMemoryLedger } from "./ledger.js"
export type {
  LedgerStore,
  ActionRecord,
  ActionStatus,
  InsertPendingInput,
  InsertResult,
  StatsFilter,
  Stats,
} from "./ledger.js"

// Phase 2 — policy engine
export {
  evaluatePolicies,
  requireApprovalWhen,
  denyWhen,
  budget,
  rateLimit,
} from "./policy.js"
export type {
  Policy,
  PolicyDecision,
  ActionContext,
  BudgetOptions,
  RateLimitOptions,
} from "./policy.js"

// Durable backend
export { PostgresLedger } from "./postgres.js"
