// Assembles the runtime dependencies from env: usage store (PG or memory),
// plan lookup, optional Stripe reporter, alert transports, an event bus
// (BullMQ/Redis when REDIS_URL is set, otherwise in-process), and the
// dead-letter store + replay seam. All gated by which env vars are present.
import type { Store } from "./store"
import type { EventBus } from "./bus"
import { InProcessBus, QueueBus } from "./bus"
import { createQueue } from "./queue"
import type { DomainEvent } from "./events"
import { newId } from "./keys"
import {
    MemDeadLetterStore,
    PgDeadLetterStore,
    makeSink,
    resilient,
    type DeadLetterRecord,
    type DeadLetterStore,
    type NamedSubscriber,
    type SqlQueryable,
} from "./deadLetters"
import {
    AlertDispatcher,
    EmailTransport,
    SlackTransport,
    WebhookTransport,
    type AlertTransport,
} from "./alerts"
import {
    MemUsageStore,
    PgUsageStore,
    StripeMeter,
    UsageMeter,
    type PlanLookup,
    type SqlPool,
    type UsageReporter,
    type UsageStore,
} from "./billing"
import { PaddleBilling } from "./paddle"

export interface ServiceDepsBundle {
    deps: {
        bus: EventBus
        limiter: UsageMeter
        billing?: PaddleBilling
        deadLetters: DeadLetterStore
        deadLetterReplay: (rec: DeadLetterRecord) => Promise<void>
    }
    bus: EventBus
    deadLetters: DeadLetterStore
    close(): Promise<void>
}

export function buildDeps(
    store: Store,
    opts: { pool?: SqlPool; env?: Record<string, string | undefined> } = {},
): ServiceDepsBundle {
    const env = opts.env ?? process.env

    const usageStore: UsageStore = opts.pool
        ? new PgUsageStore(opts.pool)
        : new MemUsageStore()
    const plans: PlanLookup = async (orgId) =>
        (await store.getOrg(orgId))?.plan ?? "free"
    const reporter: UsageReporter | undefined = env.STRIPE_SECRET_KEY
        ? new StripeMeter({ secretKey: env.STRIPE_SECRET_KEY })
        : undefined
    const meter = new UsageMeter(usageStore, plans, reporter)

    const priceToPlan: Record<string, string> = {}
    if (env.PADDLE_PRICE_PRO) priceToPlan[env.PADDLE_PRICE_PRO] = "pro"
    if (env.PADDLE_PRICE_SCALE) priceToPlan[env.PADDLE_PRICE_SCALE] = "scale"
    const billing =
        env.PADDLE_API_KEY && env.PADDLE_WEBHOOK_SECRET
            ? new PaddleBilling({
                    apiKey: env.PADDLE_API_KEY,
                    webhookSecret: env.PADDLE_WEBHOOK_SECRET,
                    priceToPlan,
                    apiBase: env.PADDLE_API_BASE,
              })
            : undefined

    const transports: AlertTransport[] = []
    if (env.SLACK_WEBHOOK_URL) transports.push(new SlackTransport(env.SLACK_WEBHOOK_URL))
    if (env.ALERT_WEBHOOK_URL) transports.push(new WebhookTransport(env.ALERT_WEBHOOK_URL))
    if (env.RESEND_API_KEY && env.ALERT_EMAIL_FROM && env.ALERT_EMAIL_TO) {
        transports.push(
            new EmailTransport({
                apiKey: env.RESEND_API_KEY,
                from: env.ALERT_EMAIL_FROM,
                to: env.ALERT_EMAIL_TO,
            }),
        )
    }
    const dispatcher = new AlertDispatcher(transports)

    // --- Dead-letter queue: persistent capture + replay of failed deliveries ---
    const deadLetters: DeadLetterStore = opts.pool
        ? new PgDeadLetterStore(opts.pool as unknown as SqlQueryable)
        : new MemDeadLetterStore()
    const sink = makeSink(deadLetters, () => newId("dlq"))

    // Named so a failure can be attributed to (and replayed against) one subscriber.
    const named: NamedSubscriber[] = [
        { name: "usage-meter", handle: meter.onEvent },
        { name: "alerts", handle: dispatcher.handle },
    ]
    const byName = new Map(named.map((n) => [n.name, n.handle]))

    let close: () => Promise<void> = async () => {}
    let bus: EventBus
    if (env.REDIS_URL) {
        // Queue path: the queue retries the whole fan-out, then dead-letters the
        // event (subscriber unknown at this layer => "*").
        const queue = createQueue<DomainEvent>({
            redisUrl: env.REDIS_URL,
            queueName: env.QUORVEL_QUEUE_NAME,
            onDeadLetter: (dl) => {
                void sink({
                    event: dl.payload,
                    subscriber: "*",
                    error: dl.error,
                    attempts: dl.attempts,
                })
            },
        })
        bus = new QueueBus(queue, named.map((n) => n.handle))
        close = async () => {
            await queue.close()
        }
    } else {
        // In-process path (default / prod today): isolate each subscriber so one
        // failure is captured instead of 500-ing the originating request.
        bus = new InProcessBus(resilient(named, sink))
    }

    const deadLetterReplay = async (rec: DeadLetterRecord): Promise<void> => {
        const event = rec.payload as DomainEvent
        if (rec.subscriber === "*") {
            await bus.publish(event)
            return
        }
        const handle = byName.get(rec.subscriber)
        if (!handle) throw new Error(`no subscriber named "${rec.subscriber}" to replay`)
        await handle(event)
    }

    return {
        deps: { bus, limiter: meter, billing, deadLetters, deadLetterReplay },
        bus,
        deadLetters,
        close,
    }
}