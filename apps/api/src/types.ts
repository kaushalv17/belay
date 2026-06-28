// Core data model for the Quorvel Cloud API.
// The action shape mirrors @quorvel/core's ActionRecord EXACTLY so HostedLedger
// can consume API responses as ActionRecord with no translation.

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
	/** 'live' | 'test' */
	env?: string
	scopes?: string[]
	createdBy?: string | null
}

/** Public action shape returned to clients — mirrors @quorvel/core ActionRecord. */
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

/** Stored row: an ActionRecord plus server-side tenant + audit columns. */
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

/** Patch describing a single status transition (server-applied). */
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

/** Public, safe-to-return shape of an API key (never includes the hash). */
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

/** A single audit-log entry: who did what, when. */
export interface AuditEntry {
	id: string
	orgId: string
	actorId?: string | null
	action: string
	target?: string | null
	metadata?: unknown
	createdAt: string
}
