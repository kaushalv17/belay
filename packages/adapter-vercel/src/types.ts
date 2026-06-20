// Core type surface for the Belay Vercel AI SDK adapter.
// Intentionally framework-agnostic: tools are matched structurally so the
// adapter never needs a hard dependency on the `ai` package at runtime.

export type ActionStatus =
	| "pending"
	| "running"
	| "succeeded"
	| "failed"
	| "awaiting_approval"
	| "rejected"

export interface ActionRecord {
	key: string
	tool: string
	args: unknown
	status: ActionStatus
	attempts: number
	result?: unknown
	error?: { message: string; code?: string }
	costCents: number
	createdAt: number
	updatedAt: number
	approvalId?: string
}

export interface ApprovalRecord {
	approvalId: string
	key: string
	tool: string
	args: unknown
	requestedAt: number
	status: "pending" | "approved" | "rejected"
	decidedAt?: number
	decidedBy?: string
}

export type ExecuteFn<A = any, R = any> = (
	args: A,
	options?: any,
) => Promise<R> | R

// Structural shape of a Vercel AI SDK tool (the output of `tool({...})`).
export interface VercelLikeTool {
	description?: string
	parameters?: unknown
	execute?: ExecuteFn
	[k: string]: unknown
}

export type LifecycleEventType =
	| "start"
	| "cache_hit"
	| "retry"
	| "success"
	| "error"
	| "approval_required"
	| "approval_resolved"
	| "budget_exceeded"

export interface LifecycleEvent {
	type: LifecycleEventType
	key: string
	tool: string
	attempt?: number
	delayMs?: number
	error?: unknown
	result?: unknown
	approvalId?: string
	decision?: "approved" | "rejected"
	at: number
}

export type Hook = (event: LifecycleEvent) => void | Promise<void>
