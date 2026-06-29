// Core data model for the Quorvel Cloud API.
export type ActionStatus =
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "awaiting_approval"
    | "approved"
    | "rejected"
    | "denied"

export interface Org {
    id: string
    name: string
    plan: string
    clerkOrgId?: string | null
    paddleCustomerId?: string | null
    trialEndsAt?: string | null
    createdAt: string
}

export interface ApiKeyRecord {
    id: string
    orgId: string
    keyHash: string
    keyPrefix: string
    name: string
    createdAt: string
    lastUsedAt?: string | null
    revokedAt?: string | null
    env?: string
    scopes?: string[]
    createdBy?: string | null
}

export interface ActionRecord {
    idempotencyKey: string
    scope: string | null
    tool: string
    args: unknown
    cost: number
    status: ActionStatus
    result?: unknown
    error?: string
    reason?: string
    attempts: number
    createdAt: string
}

export interface StoredAction extends ActionRecord {
    orgId: string
    updatedAt: string
}

export interface InsertPendingInput {
    idempotencyKey: string
    scope: string | null
    tool: string
    args?: unknown
    cost?: number
}

export interface InsertResult {
    inserted: boolean
    existing?: ActionRecord
}

export interface TransitionPatch {
    status: ActionStatus
    incrementAttempts?: boolean
    result?: unknown
    error?: string
    reason?: string
}

export interface StatsFilter {
    scope: string | null
    tool?: string
    since?: string | null
}

export interface Stats {
    count: number
    totalCost: number
}

export interface IssueKeyInput {
    orgName?: string
    plan?: string
}

export interface IssueKeyResult {
    orgId: string
    apiKey: string
    keyPrefix: string
}

export interface Membership {
    clerkUserId: string
    orgId: string
    role: string
    createdAt: string
}

export interface ProvisionOrgInput {
    clerkOrgId: string
    clerkUserId: string
    orgName?: string
    role?: string
}

export interface ProvisionOrgResult {
    orgId: string
    created: boolean
    apiKey?: string
    keyPrefix?: string
}

export interface ApiKeyPublic {
    id: string
    orgId: string
    name: string
    keyPrefix: string
    env: string
    scopes: string[]
    createdAt: string
    lastUsedAt?: string | null
    revokedAt?: string | null
    createdBy?: string | null
}

export interface CreateApiKeyInput {
    name?: string
    env?: string
    scopes?: string[]
    createdBy?: string | null
}

export interface AuditEntry {
    id: string
    orgId: string
    actorId?: string | null
    action: string
    target?: string | null
    metadata?: unknown
    createdAt: string
}

/** A persisted Idempotency-Key claim + its replayable response. */
export interface IdempotencyRecord {
    orgId: string
    idemKey: string
    fingerprint: string
    method: string
    path: string
    /** null while the first request is still in flight. */
    statusCode: number | null
    responseBody: unknown
    createdAt: string
}