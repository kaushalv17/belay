// Durable Postgres-backed Store. Mirrors @quorvel/core's PostgresLedger SQL
// (atomic ON CONFLICT insert, attempts++ on running, stats exclusions), with an
// extra org_id tenant dimension on every query. Not exercised in the sandbox
// (no DB); verified on the machine.
import { Pool } from "pg"
import { toRecord } from "./store"
import type { Store } from "./store"
import type {
	ActionRecord,
	ActionStatus,
	ApiKeyRecord,
	AuditEntry,
	Membership,
	InsertPendingInput,
	InsertResult,
	Org,
	Stats,
	StatsFilter,
	StoredAction,
	TransitionPatch,
} from "./types"

const ACTION_COLS = `org_id, idempotency_key, scope, tool, args, cost, status, result, error, reason, attempts, created_at, updated_at`

function mapRow(row: Record<string, unknown>): StoredAction {
	const rec: StoredAction = {
		orgId: row.org_id as string,
		idempotencyKey: row.idempotency_key as string,
		scope: (row.scope as string | null) ?? null,
		tool: row.tool as string,
		args: row.args ?? null,
		cost: Number(row.cost ?? 0),
		status: row.status as ActionStatus,
		attempts: Number(row.attempts ?? 0),
		createdAt: toIso(row.created_at),
		updatedAt: toIso(row.updated_at),
	}
	if (row.result != null) rec.result = row.result
	if (row.error != null) rec.error = row.error as string
	if (row.reason != null) rec.reason = row.reason as string
	return rec
}

function toIso(v: unknown): string {
	return v instanceof Date ? v.toISOString() : String(v)
}

function mapMembership(row: Record<string, unknown>): Membership {
	return {
		clerkUserId: row.clerk_user_id as string,
		orgId: row.org_id as string,
		role: row.role as string,
		createdAt: toIso(row.created_at),
	}
}

function mapApiKey(row: Record<string, unknown>): ApiKeyRecord {
	return {
		id: row.id as string,
		orgId: row.org_id as string,
		keyHash: row.key_hash as string,
		keyPrefix: row.key_prefix as string,
		name: row.name as string,
		env: (row.key_env as string | null) ?? "live",
		scopes:
			typeof row.scopes === "string" && row.scopes
				? (row.scopes as string).split(",")
				: ["actions:read", "actions:write"],
		createdBy: (row.created_by as string | null) ?? null,
		createdAt: toIso(row.created_at),
		lastUsedAt: row.last_used_at ? toIso(row.last_used_at) : null,
		revokedAt: row.revoked_at ? toIso(row.revoked_at) : null,
	}
}

export class PgStore implements Store {
	constructor(readonly pool: Pool) {}

	async insertOrg(org: Org): Promise<void> {
		await this.pool.query(
			`insert into orgs (id, name, plan, clerk_org_id, created_at) values ($1,$2,$3,$4,$5) on conflict (id) do nothing`,
			[org.id, org.name, org.plan, org.clerkOrgId ?? null, org.createdAt],
		)
	}

	async getOrg(orgId: string): Promise<Org | undefined> {
		const { rows } = await this.pool.query(
			`select id, name, plan, clerk_org_id, paddle_customer_id, created_at from orgs where id=$1`,
			[orgId],
		)
		if (!rows.length) return undefined
		const r = rows[0]
		return {
			id: r.id,
			name: r.name,
			plan: r.plan,
			clerkOrgId: r.clerk_org_id ?? null,
			paddleCustomerId: r.paddle_customer_id ?? null,
			createdAt: toIso(r.created_at),
		}
	}

	async insertApiKey(rec: ApiKeyRecord): Promise<void> {
		await this.pool.query(
			`insert into api_keys (id, org_id, key_hash, key_prefix, name, key_env, scopes, created_by, created_at, last_used_at, revoked_at)
			      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
			[
				rec.id,
				rec.orgId,
				rec.keyHash,
				rec.keyPrefix,
				rec.name,
				rec.env ?? "live",
				(rec.scopes ?? ["actions:read", "actions:write"]).join(","),
				rec.createdBy ?? null,
				rec.createdAt,
				rec.lastUsedAt ?? null,
				rec.revokedAt ?? null,
			],
		)
	}

	async setOrgPlan(orgId: string, plan: string): Promise<void> {
		await this.pool.query("update orgs set plan=$2 where id=$1", [orgId, plan])
	}

	async getApiKeyByHash(hash: string): Promise<ApiKeyRecord | undefined> {
		const { rows } = await this.pool.query(
			`select id, org_id, key_hash, key_prefix, name, key_env, scopes, created_by, created_at, last_used_at, revoked_at from api_keys where key_hash=$1`,
			[hash],
		)
		return rows.length ? mapApiKey(rows[0]) : undefined
	}

	async getAction(orgId: string, key: string): Promise<StoredAction | undefined> {
		const { rows } = await this.pool.query(
			`select ${ACTION_COLS} from belay_actions where org_id=$1 and idempotency_key=$2`,
			[orgId, key],
		)
		return rows.length ? mapRow(rows[0]) : undefined
	}

	async insertPending(orgId: string, input: InsertPendingInput): Promise<InsertResult> {
		const { rows } = await this.pool.query(
			`insert into belay_actions (org_id, idempotency_key, scope, tool, args, cost, status)
			      values ($1,$2,$3,$4,$5,$6,'pending')
			 on conflict (org_id, idempotency_key) do nothing
			   returning idempotency_key`,
			[orgId, input.idempotencyKey, input.scope, input.tool, JSON.stringify(input.args ?? null), input.cost ?? 0],
		)
		if (rows.length > 0) return { inserted: true }
		const row = await this.getAction(orgId, input.idempotencyKey)
		return { inserted: false, existing: row ? toRecord(row) : undefined }
	}

	async applyTransition(orgId: string, key: string, patch: TransitionPatch): Promise<void> {
		const sets: string[] = ["status=$3", "updated_at=now()"]
		const params: unknown[] = [orgId, key, patch.status]
		if (patch.incrementAttempts) sets.push("attempts=attempts+1")
		if (patch.result !== undefined) {
			params.push(JSON.stringify(patch.result ?? null))
			sets.push(`result=$${params.length}`)
		}
		if (patch.error !== undefined) {
			params.push(patch.error)
			sets.push(`error=$${params.length}`)
		}
		if (patch.reason !== undefined) {
			params.push(patch.reason)
			sets.push(`reason=$${params.length}`)
		}
		await this.pool.query(
			`update belay_actions set ${sets.join(", ")} where org_id=$1 and idempotency_key=$2`,
			params,
		)
	}

	async listByStatus(orgId: string, status: ActionStatus, limit?: number): Promise<ActionRecord[]> {
		const { rows } = await this.pool.query(
			`select ${ACTION_COLS} from belay_actions where org_id=$1 and status=$2 order by created_at asc limit $3`,
			[orgId, status, limit ?? 1000],
		)
		return rows.map((r: Record<string, unknown>) => toRecord(mapRow(r)))
	}

	async listRecent(orgId: string, limit?: number): Promise<ActionRecord[]> {
		const { rows } = await this.pool.query(
			`select ${ACTION_COLS} from belay_actions where org_id=$1 order by created_at desc limit $2`,
			[orgId, limit ?? 100],
		)
		return rows.map((r: Record<string, unknown>) => toRecord(mapRow(r)))
	}

	async stats(orgId: string, filter: StatsFilter): Promise<Stats> {
		const { rows } = await this.pool.query(
			`select count(*)::int as count, coalesce(sum(cost),0)::float8 as total_cost
			   from belay_actions
			  where org_id=$1
			    and scope is not distinct from $2
			    and ($3::text is null or tool=$3)
			    and ($4::timestamptz is null or created_at >= $4)
			    and status not in ('failed','denied','rejected')`,
			[orgId, filter.scope, filter.tool ?? null, filter.since ?? null],
		)
		return { count: Number(rows[0].count), totalCost: Number(rows[0].total_cost) }
	}

	async linkClerkOrg(orgId: string, clerkOrgId: string): Promise<void> {
		await this.pool.query(`update orgs set clerk_org_id=$2 where id=$1`, [
			orgId,
			clerkOrgId,
		])
	}

	async getOrgByClerkId(clerkOrgId: string): Promise<Org | undefined> {
		const { rows } = await this.pool.query(
			`select id, name, plan, clerk_org_id, created_at from orgs where clerk_org_id=$1`,
			[clerkOrgId],
		)
		if (!rows.length) return undefined
		const r = rows[0]
		return {
			id: r.id,
			name: r.name,
			plan: r.plan,
			clerkOrgId: r.clerk_org_id ?? null,
			createdAt: toIso(r.created_at),
		}
	}

	async upsertMembership(m: Membership): Promise<void> {
		await this.pool.query(
			`insert into memberships (clerk_user_id, org_id, role, created_at)
			      values ($1,$2,$3,$4)
			 on conflict (clerk_user_id, org_id) do update set role=excluded.role`,
			[m.clerkUserId, m.orgId, m.role, m.createdAt],
		)
	}

	async getMembership(clerkUserId: string, orgId: string): Promise<Membership | undefined> {
		const { rows } = await this.pool.query(
			`select clerk_user_id, org_id, role, created_at from memberships where clerk_user_id=$1 and org_id=$2`,
			[clerkUserId, orgId],
		)
		return rows.length ? mapMembership(rows[0]) : undefined
	}

	async listMembershipsByUser(clerkUserId: string): Promise<Membership[]> {
		const { rows } = await this.pool.query(
			`select clerk_user_id, org_id, role, created_at from memberships where clerk_user_id=$1`,
			[clerkUserId],
		)
		return rows.map((r: Record<string, unknown>) => mapMembership(r))
	}

	async listMembershipsByOrg(orgId: string): Promise<Membership[]> {
		const { rows } = await this.pool.query(
			`select clerk_user_id, org_id, role, created_at from memberships where org_id=$1`,
			[orgId],
		)
		return rows.map((r: Record<string, unknown>) => mapMembership(r))
	}

	async setOrgPaddleCustomer(orgId: string, customerId: string): Promise<void> {
		await this.pool.query(`update orgs set paddle_customer_id=$2 where id=$1`, [
			orgId,
			customerId,
		])
	}

	async getOrgByPaddleCustomer(customerId: string): Promise<Org | undefined> {
		const { rows } = await this.pool.query(
			`select id, name, plan, clerk_org_id, paddle_customer_id, created_at from orgs where paddle_customer_id=$1`,
			[customerId],
		)
		if (!rows.length) return undefined
		const r = rows[0]
		return {
			id: r.id,
			name: r.name,
			plan: r.plan,
			clerkOrgId: r.clerk_org_id ?? null,
			paddleCustomerId: r.paddle_customer_id ?? null,
			createdAt: toIso(r.created_at),
		}
	}

	async listApiKeys(orgId: string): Promise<ApiKeyRecord[]> {
		const { rows } = await this.pool.query(
			`select id, org_id, key_hash, key_prefix, name, key_env, scopes, created_by, created_at, last_used_at, revoked_at from api_keys where org_id=$1 order by created_at desc`,
			[orgId],
		)
		return rows.map((r: Record<string, unknown>) => mapApiKey(r))
	}

	async getApiKeyById(orgId: string, id: string): Promise<ApiKeyRecord | undefined> {
		const { rows } = await this.pool.query(
			`select id, org_id, key_hash, key_prefix, name, key_env, scopes, created_by, created_at, last_used_at, revoked_at from api_keys where org_id=$1 and id=$2`,
			[orgId, id],
		)
		return rows.length ? mapApiKey(rows[0]) : undefined
	}

	async revokeApiKey(orgId: string, id: string): Promise<boolean> {
		const { rows } = await this.pool.query(
			`update api_keys set revoked_at=now() where org_id=$1 and id=$2 and revoked_at is null returning id`,
			[orgId, id],
		)
		return rows.length > 0
	}

	async touchApiKeyLastUsed(keyHash: string): Promise<void> {
		await this.pool.query(`update api_keys set last_used_at=now() where key_hash=$1`, [
			keyHash,
		])
	}

	async insertAuditLog(entry: AuditEntry): Promise<void> {
		await this.pool.query(
			`insert into audit_log (id, org_id, actor_id, action, target, metadata, created_at)
			      values ($1,$2,$3,$4,$5,$6,$7)`,
			[
				entry.id,
				entry.orgId,
				entry.actorId ?? null,
				entry.action,
				entry.target ?? null,
				JSON.stringify(entry.metadata ?? null),
				entry.createdAt,
			],
		)
	}

	async listAuditLog(orgId: string, limit = 100): Promise<AuditEntry[]> {
		const { rows } = await this.pool.query(
			`select id, org_id, actor_id, action, target, metadata, created_at from audit_log where org_id=$1 order by created_at desc limit $2`,
			[orgId, limit],
		)
		return rows.map((r: Record<string, unknown>) => ({
			id: r.id as string,
			orgId: r.org_id as string,
			actorId: (r.actor_id as string | null) ?? null,
			action: r.action as string,
			target: (r.target as string | null) ?? null,
			metadata: r.metadata ?? null,
			createdAt: toIso(r.created_at),
		}))
	}
}
