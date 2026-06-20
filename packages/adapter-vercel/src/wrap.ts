import { idempotencyKey } from "./canonical.js"
import {
	ApprovalRequiredError,
	BudgetExceededError,
	RejectedError,
	TimeoutError,
	toErrorInfo,
} from "./errors.js"
import {
	computeDelay,
	defaultIsRetryable,
	defaultRetry,
	sleep,
	type RetryPolicy,
} from "./retry.js"
import { InMemoryStore, type ReliabilityStore } from "./store.js"
import {
	resolveBool,
	resolveNum,
	type Budget,
	type ToolPolicy,
} from "./policy.js"
import type {
	ActionRecord,
	ApprovalRecord,
	ExecuteFn,
	Hook,
	LifecycleEvent,
	VercelLikeTool,
} from "./types.js"

export interface BelayOptions {
	/** Reliability store. Defaults to a process-local InMemoryStore. */
	store?: ReliabilityStore
	/** Retry policy overrides (merged over defaults). */
	retry?: Partial<RetryPolicy>
	/** Session budget across all wrapped tools sharing this context. */
	budget?: Budget
	/** Namespaces idempotency keys (tenant / environment). */
	salt?: string
	/** interrupt = throw ApprovalRequiredError; wait = block until resolved. */
	approvalMode?: "interrupt" | "wait"
	waitForApproval?: (approvalId: string) => Promise<"approved" | "rejected">
	approvalPollMs?: number
	/** Lifecycle hook — feed this straight into the dashboard SSE stream. */
	onEvent?: Hook
	/** Per-tool policy keyed by tool name. */
	perTool?: Record<string, ToolPolicy>
	/** Policy applied to every tool unless overridden by perTool. */
	defaultPolicy?: ToolPolicy
	/** Injectable clock for deterministic tests. */
	now?: () => number
}

interface Ctx {
	store: ReliabilityStore
	retry: RetryPolicy
	budget?: Budget
	salt?: string
	approvalMode: "interrupt" | "wait"
	waitForApproval?: (id: string) => Promise<"approved" | "rejected">
	approvalPollMs: number
	onEvent?: Hook
	now: () => number
}

function buildCtx(o: BelayOptions = {}): Ctx {
	return {
		store: o.store ?? new InMemoryStore(),
		retry: {
			...defaultRetry,
			...o.retry,
			isRetryable: o.retry?.isRetryable ?? defaultIsRetryable,
		},
		budget: o.budget,
		salt: o.salt,
		approvalMode: o.approvalMode ?? "interrupt",
		waitForApproval: o.waitForApproval,
		approvalPollMs: o.approvalPollMs ?? 1_000,
		onEvent: o.onEvent,
		now: o.now ?? (() => Date.now()),
	}
}

async function emit(ctx: Ctx, ev: LifecycleEvent): Promise<void> {
	if (!ctx.onEvent) return
	try {
		await ctx.onEvent(ev)
	} catch {
		// Observability must never break the call path.
	}
}

async function persist(
	ctx: Ctx,
	key: string,
	tool: string,
	args: unknown,
	patch: Partial<ActionRecord>,
): Promise<ActionRecord> {
	const now = ctx.now()
	const existing = await ctx.store.getAction(key)
	const rec: ActionRecord = {
		key,
		tool,
		args,
		status: patch.status ?? existing?.status ?? "pending",
		attempts: patch.attempts ?? existing?.attempts ?? 0,
		result: "result" in patch ? patch.result : existing?.result,
		error: "error" in patch ? patch.error : existing?.error,
		costCents: patch.costCents ?? existing?.costCents ?? 0,
		approvalId: patch.approvalId ?? existing?.approvalId,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	}
	await ctx.store.putAction(rec)
	return rec
}

function withTimeout<T>(
	value: Promise<T> | T,
	ms: number,
	name: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new TimeoutError(name, ms)), ms)
		Promise.resolve(value).then(
			(v) => {
				clearTimeout(timer)
				resolve(v)
			},
			(e) => {
				clearTimeout(timer)
				reject(e)
			},
		)
	})
}

async function pollApproval(
	ctx: Ctx,
	approvalId: string,
): Promise<"approved" | "rejected"> {
	for (;;) {
		const a = await ctx.store.getApproval(approvalId)
		if (a && a.status !== "pending") return a.status
		await sleep(ctx.approvalPollMs)
	}
}

async function ensureApproval(
	name: string,
	key: string,
	args: unknown,
	prior: ActionRecord | undefined,
	ctx: Ctx,
): Promise<"approved" | "rejected"> {
	// Honor an already-decided approval (resume path).
	if (prior?.approvalId) {
		const a = await ctx.store.getApproval(prior.approvalId)
		if (a && a.status !== "pending") return a.status
	}
	const approvalId =
		prior?.approvalId ??
		"apr_" + key.slice(4, 20) + "_" + Math.random().toString(36).slice(2, 8)
	const existing = await ctx.store.getApproval(approvalId)
	if (!existing) {
		const rec: ApprovalRecord = {
			approvalId,
			key,
			tool: name,
			args,
			requestedAt: ctx.now(),
			status: "pending",
		}
		await ctx.store.createApproval(rec)
	}
	await persist(ctx, key, name, args, {
		status: "awaiting_approval",
		approvalId,
	})
	await emit(ctx, {
		type: "approval_required",
		key,
		tool: name,
		approvalId,
		at: ctx.now(),
	})

	if (ctx.approvalMode === "wait") {
		const decision = ctx.waitForApproval
			? await ctx.waitForApproval(approvalId)
			: await pollApproval(ctx, approvalId)
		await emit(ctx, {
			type: "approval_resolved",
			key,
			tool: name,
			approvalId,
			decision,
			at: ctx.now(),
		})
		return decision
	}
	throw new ApprovalRequiredError(approvalId, name)
}

function wrapExecute(
	name: string,
	fn: ExecuteFn,
	policy: ToolPolicy,
	ctx: Ctx,
): ExecuteFn {
	return async (args: unknown, options?: unknown) => {
		const key = idempotencyKey(name, args, ctx.salt)
		const prior = await ctx.store.getAction(key)

		// 1) Idempotent replay: a previously succeeded call returns its cached result.
		if (prior?.status === "succeeded") {
			await emit(ctx, {
				type: "cache_hit",
				key,
				tool: name,
				result: prior.result,
				at: ctx.now(),
			})
			return prior.result
		}
		if (prior?.status === "rejected") {
			throw new RejectedError(name, prior.approvalId)
		}

		// 2) Human-in-the-loop gating.
		if (resolveBool(policy.requiresApproval, args)) {
			const decision = await ensureApproval(name, key, args, prior, ctx)
			if (decision === "rejected") {
				await persist(ctx, key, name, args, { status: "rejected" })
				throw new RejectedError(name)
			}
		}

		// 3) Budget enforcement (session-scoped via shared store/context).
		const cost = resolveNum(policy.costCents, args)
		if (ctx.budget) {
			const s = await ctx.store.stats()
			if (ctx.budget.maxCalls != null && s.calls >= ctx.budget.maxCalls) {
				await emit(ctx, { type: "budget_exceeded", key, tool: name, at: ctx.now() })
				throw new BudgetExceededError("calls", ctx.budget.maxCalls)
			}
			if (
				ctx.budget.maxCostCents != null &&
				s.costCents + cost > ctx.budget.maxCostCents
			) {
				await emit(ctx, { type: "budget_exceeded", key, tool: name, at: ctx.now() })
				throw new BudgetExceededError("cost", ctx.budget.maxCostCents)
			}
		}

		// 4) Execute with bounded retry + full-jitter backoff.
		const maxAttempts = policy.maxAttempts ?? ctx.retry.maxAttempts
		const isRetryable = ctx.retry.isRetryable ?? defaultIsRetryable
		let attempt = 0
		let lastErr: unknown
		await emit(ctx, { type: "start", key, tool: name, at: ctx.now() })
		while (attempt < maxAttempts) {
			attempt++
			try {
				await persist(ctx, key, name, args, {
					status: "running",
					attempts: attempt,
					costCents: cost,
				})
				const result = policy.timeoutMs
					? await withTimeout(fn(args, options), policy.timeoutMs, name)
					: await fn(args, options)
				await persist(ctx, key, name, args, {
					status: "succeeded",
					attempts: attempt,
					result,
					costCents: cost,
				})
				await emit(ctx, {
					type: "success",
					key,
					tool: name,
					attempt,
					result,
					at: ctx.now(),
				})
				return result
			} catch (err) {
				lastErr = err
				if (!isRetryable(err) || attempt >= maxAttempts) {
					await persist(ctx, key, name, args, {
						status: "failed",
						attempts: attempt,
						error: toErrorInfo(err),
					})
					await emit(ctx, {
						type: "error",
						key,
						tool: name,
						attempt,
						error: err,
						at: ctx.now(),
					})
					throw err
				}
				const delayMs = computeDelay(attempt, ctx.retry)
				await emit(ctx, {
					type: "retry",
					key,
					tool: name,
					attempt,
					delayMs,
					error: err,
					at: ctx.now(),
				})
				await sleep(delayMs)
			}
		}
		throw lastErr
	}
}

function policyFor(o: BelayOptions, name: string): ToolPolicy {
	return { ...(o.defaultPolicy ?? {}), ...(o.perTool?.[name] ?? {}) }
}

function wrapOne<T extends VercelLikeTool>(
	name: string,
	tool: T,
	policy: ToolPolicy,
	ctx: Ctx,
): T {
	if (typeof tool.execute !== "function") return tool
	return { ...tool, execute: wrapExecute(name, tool.execute.bind(tool), policy, ctx) }
}

/** Wrap a single AI SDK tool with the Belay reliability layer. */
export function wrapTool<T extends VercelLikeTool>(
	name: string,
	tool: T,
	options: BelayOptions = {},
): T {
	return wrapOne(name, tool, policyFor(options, name), buildCtx(options))
}

/** Wrap a whole toolset; all tools share one context (store + budget). */
export function withBelay<T extends Record<string, VercelLikeTool>>(
	tools: T,
	options: BelayOptions = {},
): T {
	const ctx = buildCtx(options)
	const out: Record<string, VercelLikeTool> = {}
	for (const [name, tool] of Object.entries(tools)) {
		out[name] = wrapOne(name, tool, policyFor(options, name), ctx)
	}
	return out as T
}

export interface Belay {
	store: ReliabilityStore
	wrap<T extends Record<string, VercelLikeTool>>(tools: T): T
	wrapOne<T extends VercelLikeTool>(name: string, tool: T, policy?: ToolPolicy): T
	listPendingApprovals(): Promise<ApprovalRecord[]>
	approve(approvalId: string, by?: string): Promise<ApprovalRecord>
	reject(approvalId: string, by?: string): Promise<ApprovalRecord>
}

/**
 * Create a Belay instance with a shared context. This is the recommended entry
 * point: one instance per agent owns the store, budget, approvals, and events.
 */
export function createBelay(options: BelayOptions = {}): Belay {
	const ctx = buildCtx(options)
	return {
		store: ctx.store,
		wrap(tools) {
			const out: Record<string, VercelLikeTool> = {}
			for (const [name, tool] of Object.entries(tools)) {
				out[name] = wrapOne(name, tool, policyFor(options, name), ctx)
			}
			return out as typeof tools
		},
		wrapOne(name, tool, policy) {
			const merged = { ...policyFor(options, name), ...(policy ?? {}) }
			return wrapOne(name, tool, merged, ctx)
		},
		listPendingApprovals: () => ctx.store.listPendingApprovals(),
		approve: (id, by) => ctx.store.resolveApproval(id, "approved", by),
		reject: (id, by) => ctx.store.resolveApproval(id, "rejected", by),
	}
}
