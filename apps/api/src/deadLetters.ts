// Dead-letter queue (DLQ): persistent capture of events whose delivery to a
// subscriber failed, plus the seams to list/replay them. Kept in its own module
// so the core Store (store.ts/pgStore.ts) stays untouched; the DLQ store is
// injected into the service via ServiceDeps instead.
//
// Why per-subscriber (not per-event): each subscriber (usage-meter, alerts) is
// captured independently, so a failed *alert* is dead-lettered without losing
// the *meter* run -- and replay re-runs ONLY the failed subscriber, so it can't
// double-count usage in a healthy one.
import type { DomainEvent } from "./events"
import type { Subscriber } from "./bus"

/** A persisted delivery failure: one (event, subscriber) pair, replayable. */
export interface DeadLetterRecord {
    id: string
    orgId: string
    /** The named subscriber that failed, or "*" for a whole-event queue failure. */
    subscriber: string
    eventType: string
    /** The original DomainEvent, replayed verbatim. */
    payload: unknown
    attempts: number
    error: string
    createdAt: string
}

export interface DeadLetterStore {
    recordDeadLetter(rec: DeadLetterRecord): Promise<void>
    listDeadLetters(orgId: string, limit?: number): Promise<DeadLetterRecord[]>
    getDeadLetter(orgId: string, id: string): Promise<DeadLetterRecord | undefined>
    deleteDeadLetter(orgId: string, id: string): Promise<boolean>
}

/** Additive, idempotent migration (run from migrate.ts, like idempotency_keys). */
export const DEAD_LETTERS_SQL = `create table if not exists dead_letters (
    id text primary key,
    org_id text not null,
    subscriber text not null,
    event_type text not null,
    payload jsonb not null,
    attempts int not null default 0,
    error text not null default '',
    created_at timestamptz not null default now()
);
create index if not exists dead_letters_org_created_idx
    on dead_letters (org_id, created_at desc);`

export class MemDeadLetterStore implements DeadLetterStore {
    private readonly rows = new Map<string, DeadLetterRecord>()

    async recordDeadLetter(rec: DeadLetterRecord): Promise<void> {
        this.rows.set(rec.id, { ...rec })
    }
    async listDeadLetters(orgId: string, limit = 100): Promise<DeadLetterRecord[]> {
        return [...this.rows.values()]
            .filter((r) => r.orgId === orgId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, limit)
    }
    async getDeadLetter(orgId: string, id: string): Promise<DeadLetterRecord | undefined> {
        const r = this.rows.get(id)
        return r && r.orgId === orgId ? r : undefined
    }
    async deleteDeadLetter(orgId: string, id: string): Promise<boolean> {
        const r = this.rows.get(id)
        if (!r || r.orgId !== orgId) return false
        this.rows.delete(id)
        return true
    }
}

/** Minimal query surface shared by pg.Pool and billing's SqlPool. */
export interface SqlQueryable {
    query(text: string, params?: any[]): Promise<{ rows: any[] }>
}

function mapDeadLetter(row: Record<string, unknown>): DeadLetterRecord {
    return {
        id: row.id as string,
        orgId: row.org_id as string,
        subscriber: row.subscriber as string,
        eventType: row.event_type as string,
        payload: row.payload ?? null,
        attempts: Number(row.attempts ?? 0),
        error: (row.error as string) ?? "",
        createdAt:
            row.created_at instanceof Date
                ? row.created_at.toISOString()
                : String(row.created_at),
    }
}

export class PgDeadLetterStore implements DeadLetterStore {
    constructor(private readonly pool: SqlQueryable) {}

    async recordDeadLetter(rec: DeadLetterRecord): Promise<void> {
        await this.pool.query(
            `insert into dead_letters (id, org_id, subscriber, event_type, payload, attempts, error, created_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8)
             on conflict (id) do nothing`,
            [
                rec.id,
                rec.orgId,
                rec.subscriber,
                rec.eventType,
                JSON.stringify(rec.payload ?? null),
                rec.attempts,
                rec.error,
                rec.createdAt,
            ],
        )
    }
    async listDeadLetters(orgId: string, limit = 100): Promise<DeadLetterRecord[]> {
        const { rows } = await this.pool.query(
            `select id, org_id, subscriber, event_type, payload, attempts, error, created_at
             from dead_letters where org_id=$1 order by created_at desc limit $2`,
            [orgId, limit],
        )
        return rows.map(mapDeadLetter)
    }
    async getDeadLetter(orgId: string, id: string): Promise<DeadLetterRecord | undefined> {
        const { rows } = await this.pool.query(
            `select id, org_id, subscriber, event_type, payload, attempts, error, created_at
             from dead_letters where org_id=$1 and id=$2`,
            [orgId, id],
        )
        return rows.length ? mapDeadLetter(rows[0]) : undefined
    }
    async deleteDeadLetter(orgId: string, id: string): Promise<boolean> {
        const { rows } = await this.pool.query(
            `delete from dead_letters where org_id=$1 and id=$2 returning id`,
            [orgId, id],
        )
        return rows.length > 0
    }
}

// --- Resilient delivery helpers (pure, unit-testable) ---

export interface NamedSubscriber {
    name: string
    handle: Subscriber
}

export interface DeadLetterInput {
    event: DomainEvent
    subscriber: string
    error: string
    attempts: number
}

export type DeadLetterSink = (input: DeadLetterInput) => Promise<void>

/** Build a sink that persists a delivery failure, never throwing back into delivery. */
export function makeSink(store: DeadLetterStore, nextId: () => string): DeadLetterSink {
    return async ({ event, subscriber, error, attempts }) => {
        try {
            await store.recordDeadLetter({
                id: nextId(),
                orgId: event.orgId,
                subscriber,
                eventType: event.type,
                payload: event,
                attempts,
                error,
                createdAt: new Date().toISOString(),
            })
        } catch {
            // Dead-lettering must never break event delivery.
        }
    }
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Wrap each named subscriber so a throw is isolated + dead-lettered instead of
 * propagating (which, on the in-process bus, would 500 the originating request).
 */
export function resilient(named: NamedSubscriber[], sink: DeadLetterSink): Subscriber[] {
    return named.map(
        (n): Subscriber =>
            async (e: DomainEvent) => {
                try {
                    await n.handle(e)
                } catch (err) {
                    await sink({ event: e, subscriber: n.name, error: errMessage(err), attempts: 1 })
                }
            },
    )
}