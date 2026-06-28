// Observability bootstrap (Phase 4/8): Sentry error tracking + OpenTelemetry.
// Both are OPTIONAL and lazily imported, so the package has no hard dependency
// on them. They activate only when the relevant env vars are present and the
// packages are installed. Install with:
//   pnpm --filter @quorvel/cloud-api add @sentry/node @opentelemetry/api \
//     @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node

export interface ObservabilityHandle {
	sentryEnabled: boolean
	otelEnabled: boolean
	shutdown: () => Promise<void>
}

export async function initObservability(): Promise<ObservabilityHandle> {
	let sentryEnabled = false
	let otelEnabled = false
	let shutdownOtel: (() => Promise<void>) | undefined

	const dsn = process.env.SENTRY_DSN
	if (dsn) {
		try {
			// @ts-ignore - optional dependency, resolved at runtime only.
			const Sentry = await import("@sentry/node")
			Sentry.init({
				dsn,
				environment: process.env.NODE_ENV ?? "production",
				tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
			})
			sentryEnabled = true
		} catch {
			console.warn("[observability] SENTRY_DSN set but @sentry/node not installed")
		}
	}

	if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
		try {
			// @ts-ignore - optional dependency, resolved at runtime only.
			const { NodeSDK } = await import("@opentelemetry/sdk-node")
			// @ts-ignore - optional dependency.
			const { getNodeAutoInstrumentations } = await import(
				"@opentelemetry/auto-instrumentations-node"
			)
			const sdk = new NodeSDK({
				instrumentations: [getNodeAutoInstrumentations()],
			})
			await sdk.start()
			shutdownOtel = () => sdk.shutdown()
			otelEnabled = true
		} catch {
			console.warn(
				"[observability] OTEL endpoint set but OpenTelemetry packages not installed",
			)
		}
	}

	return {
		sentryEnabled,
		otelEnabled,
		shutdown: async () => {
			if (shutdownOtel) await shutdownOtel().catch(() => {})
		},
	}
}

/** Report an error to Sentry if available; always logs to console. */
export async function reportError(
	err: unknown,
	context?: Record<string, unknown>,
): Promise<void> {
	console.error("[error]", err, context ?? {})
	if (!process.env.SENTRY_DSN) return
	try {
		// @ts-ignore - optional dependency.
		const Sentry = await import("@sentry/node")
		Sentry.captureException(err, context ? { extra: context } : undefined)
	} catch {
		// ignore
	}
}
