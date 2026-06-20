import type { ActionRecord, ApprovalRecord } from "./types.js"

// Dependency-inversion port. The adapter only knows this interface; the real
// Belay Postgres ledger, a Redis store, or the in-memory default all satisfy it.
export interface ReliabilityStore {
	getAction(key: string): Promise<ActionRecord | undefined>
	putAction(rec: ActionRecord): Promise<void>
	/** Aggregate of succeeded actions, used for budget enforcement. */
	stats(): Promise<{ calls: number; costCents: number }>
	createApproval(rec: ApprovalRecord): Promise<void>
	getApproval(approvalId: string): Promise<ApprovalRecord | undefined>
	listPendingApprovals(): Promise<ApprovalRecord[]>
	resolveApproval(
		approvalId: string,
		decision: "approved" | "rejected",
		by?: string,
	): Promise<ApprovalRecord>
}

// Zero-config default. Great for tests, single-process agents, and demos.
export class InMemoryStore implements ReliabilityStore {
	private actions = new Map<string, ActionRecord>()
	private approvals = new Map<string, ApprovalRecord>()

	async getAction(key: string): Promise<ActionRecord | undefined> {
		return this.actions.get(key)
	}

	async putAction(rec: ActionRecord): Promise<void> {
		this.actions.set(rec.key, rec)
	}

	async stats(): Promise<{ calls: number; costCents: number }> {
		let calls = 0
		let costCents = 0
		for (const a of this.actions.values()) {
			if (a.status === "succeeded") {
				calls++
				costCents += a.costCents
			}
		}
		return { calls, costCents }
	}

	async createApproval(rec: ApprovalRecord): Promise<void> {
		this.approvals.set(rec.approvalId, rec)
	}

	async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
		return this.approvals.get(approvalId)
	}

	async listPendingApprovals(): Promise<ApprovalRecord[]> {
		return [...this.approvals.values()].filter((a) => a.status === "pending")
	}

	async resolveApproval(
		approvalId: string,
		decision: "approved" | "rejected",
		by?: string,
	): Promise<ApprovalRecord> {
		const a = this.approvals.get(approvalId)
		if (!a) throw new Error(`Unknown approval ${approvalId}`)
		a.status = decision
		a.decidedAt = Date.now()
		a.decidedBy = by
		this.approvals.set(approvalId, a)
		return a
	}
}
