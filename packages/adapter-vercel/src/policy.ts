// Per-tool policy. Values can be static or computed from the call arguments,
// which lets you gate on amounts (e.g. require approval only for refunds > $100).
export interface ToolPolicy {
	requiresApproval?: boolean | ((args: any) => boolean)
	costCents?: number | ((args: any) => number)
	maxAttempts?: number
	timeoutMs?: number
}

export interface Budget {
	maxCalls?: number
	maxCostCents?: number
}

export function resolveBool(
	v: boolean | ((a: any) => boolean) | undefined,
	args: any,
): boolean {
	return typeof v === "function" ? !!v(args) : !!v
}

export function resolveNum(
	v: number | ((a: any) => number) | undefined,
	args: any,
): number {
	return typeof v === "function" ? v(args) : v ?? 0
}
