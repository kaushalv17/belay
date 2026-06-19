

export class DuplicateInFlightError extends Error {
  readonly key: string
  constructor(key: string) {
    super(`Belay: an action with this idempotency key is already in flight (${key})`)
    this.name = "DuplicateInFlightError"
    this.key = key
  }
}

export class ApprovalRequiredError extends Error {
  readonly key: string
  readonly reason: string
  constructor(key: string, reason: string) {
    super(`Belay: action requires approval — ${reason} [${key}]`)
    this.name = "ApprovalRequiredError"
    this.key = key
    this.reason = reason
  }
}

export class PolicyDeniedError extends Error {
  readonly key: string
  readonly reason: string
  constructor(key: string, reason: string) {
    super(`Belay: action denied by policy — ${reason} [${key}]`)
    this.name = "PolicyDeniedError"
    this.key = key
    this.reason = reason
  }
}

export class ActionRejectedError extends Error {
  readonly key: string
  readonly reason: string | null
  constructor(key: string, reason: string | null) {
    super(`Belay: action was rejected${reason ? ` — ${reason}` : ""} [${key}]`)
    this.name = "ActionRejectedError"
    this.key = key
    this.reason = reason
  }
}
