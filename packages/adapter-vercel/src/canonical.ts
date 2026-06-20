import { createHash } from "node:crypto"

// Deterministic JSON serialization: object keys are sorted recursively and
// `undefined` values are dropped, so logically-equal argument objects always
// produce the same string regardless of key order or insertion order.
export function canonicalize(value: unknown): string {
	return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue)
	if (value && typeof value === "object") {
		const input = value as Record<string, unknown>
		const out: Record<string, unknown> = {}
		for (const key of Object.keys(input).sort()) {
			const v = input[key]
			if (v !== undefined) out[key] = sortValue(v)
		}
		return out
	}
	return value
}

// Stable idempotency key for a (tool, args) pair. An optional salt namespaces
// keys per tenant / environment so identical calls don't collide across scopes.
export function idempotencyKey(
	toolName: string,
	args: unknown,
	salt?: string,
): string {
	const h = createHash("sha256")
	h.update(toolName)
	h.update("\u0000")
	h.update(canonicalize(args))
	if (salt) {
		h.update("\u0000")
		h.update(salt)
	}
	return "act_" + h.digest("hex").slice(0, 32)
}
