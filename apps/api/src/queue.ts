// Job queue seam. The in-memory implementation is the default (synchronous-ish,
// fully tested); BullMQ/Redis slots in behind the same interface for production
// ingest hardening (Part 7) without touching callers.

export interface RetryOptions {
    attempts: number
    backoffMs: number
}

export const DEFAULT_RETRY: RetryOptions = { attempts: 5, backoffMs: 200 }

export type JobHandler<T> = (payload: T) => Promise<void>

export interface DeadLetter<T> {
    payload: T
    attempts: number
    error: string
}

/** Notified when a job exhausts its retries. Must not throw. */
export type DeadLetterHandler<T> = (dl: DeadLetter<T>) => void

export interface JobQueue<T> {
    enqueue(payload: T): Promise<void>
    process(handler: JobHandler<T>): void
    drain(): Promise<void>
    deadLetters(): DeadLetter<T>[]
    close(): Promise<void>
}

const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => setTimeout(resolve, ms))

export class InMemoryQueue<T> implements JobQueue<T> {
    private handler: JobHandler<T> | null = null
    private pending: T[] = []
    private tail: Promise<void> = Promise.resolve()
    private dead: DeadLetter<T>[] = []

    constructor(
        private readonly retry: RetryOptions = DEFAULT_RETRY,
        private readonly onDead?: DeadLetterHandler<T>,
    ) {}

    async enqueue(payload: T): Promise<void> {
        if (!this.handler) {
            this.pending.push(payload)
            return
        }
        this.schedule(payload)
    }

    process(handler: JobHandler<T>): void {
        this.handler = handler
        const buffered = this.pending
        this.pending = []
        for (const p of buffered) this.schedule(p)
    }

    private schedule(payload: T): void {
        this.tail = this.tail.then(() => this.run(payload))
    }

    private async run(payload: T): Promise<void> {
        const handler = this.handler
        if (!handler) return
        let lastErr = ""
        for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
            try {
                await handler(payload)
                return
            } catch (e) {
                lastErr = e instanceof Error ? e.message : String(e)
                if (attempt < this.retry.attempts) await sleep(this.retry.backoffMs * attempt)
            }
        }
        const dl: DeadLetter<T> = { payload, attempts: this.retry.attempts, error: lastErr }
        this.dead.push(dl)
        this.notifyDead(dl)
    }

    private notifyDead(dl: DeadLetter<T>): void {
        if (!this.onDead) return
        try {
            this.onDead(dl)
        } catch {
            // A failing dead-letter sink must not break the queue.
        }
    }

    async drain(): Promise<void> {
        let current: Promise<void>
        do {
            current = this.tail
            await current
        } while (current !== this.tail)
    }

    deadLetters(): DeadLetter<T>[] {
        return this.dead
    }

    async close(): Promise<void> {
        /* nothing to release for the in-memory queue */
    }
}

// Production queue backed by BullMQ + Redis. Not exercised in the sandbox (no
// Redis); the InMemoryQueue covers the behavioral contract.
export class BullMQQueue<T> implements JobQueue<T> {
    private queue: any
    private worker: any
    private connection: any
    private readonly dead: DeadLetter<T>[] = []

    constructor(
        private readonly redisUrl: string,
        private readonly queueName: string,
        private readonly retry: RetryOptions = DEFAULT_RETRY,
        private readonly onDead?: DeadLetterHandler<T>,
    ) {}

    private async connect(): Promise<any> {
        if (this.connection) return this.connection
        const IORedis = (await import("ioredis" as any)).default
        this.connection = new IORedis(this.redisUrl, { maxRetriesPerRequest: null })
        return this.connection
    }

    private async ensureQueue(): Promise<any> {
        if (this.queue) return this.queue
        const { Queue } = await import("bullmq")
        this.queue = new Queue(this.queueName, { connection: await this.connect() })
        return this.queue
    }

    async enqueue(payload: T): Promise<void> {
        const q = await this.ensureQueue()
        await q.add("job", payload, {
            attempts: this.retry.attempts,
            backoff: { type: "fixed", delay: this.retry.backoffMs },
            removeOnComplete: true,
        })
    }

    process(handler: JobHandler<T>): void {
        void (async () => {
            const { Worker } = await import("bullmq")
            this.worker = new Worker(
                this.queueName,
                async (job: { data: any }) => {
                    await handler(job.data as T)
                },
                { connection: await this.connect() },
            )
            this.worker.on("failed", (job: any, err: any) => {
                if (!job || (job.attemptsMade ?? 0) < this.retry.attempts) return
                const dl: DeadLetter<T> = {
                    payload: job.data as T,
                    attempts: job.attemptsMade ?? this.retry.attempts,
                    error: err instanceof Error ? err.message : String(err),
                }
                this.dead.push(dl)
                try {
                    this.onDead?.(dl)
                } catch {
                    /* sink must not break the worker */
                }
            })
        })()
    }

    async drain(): Promise<void> {
        /* Redis-backed delivery; nothing to await in-process */
    }

    deadLetters(): DeadLetter<T>[] {
        return this.dead
    }

    async close(): Promise<void> {
        if (this.worker) await this.worker.close()
        if (this.queue) await this.queue.close()
        if (this.connection?.quit) await this.connection.quit()
    }
}

export function createQueue<T>(
    opts: {
        redisUrl?: string
        queueName?: string
        retry?: RetryOptions
        onDeadLetter?: DeadLetterHandler<T>
    } = {},
): JobQueue<T> {
    const queueName = opts.queueName ?? "belay-events"
    if (opts.redisUrl) {
        return new BullMQQueue<T>(
            opts.redisUrl,
            queueName,
            opts.retry ?? DEFAULT_RETRY,
            opts.onDeadLetter,
        )
    }
    return new InMemoryQueue<T>(opts.retry ?? DEFAULT_RETRY, opts.onDeadLetter)
}