"use server"

import { revalidatePath } from "next/cache"
import { serverClient } from "../lib/server-client"

// Server actions invoked directly from <form action={...}> in server components.
// Each calls the same REST API the SDK uses, then revalidates the affected
// views so the queue/timeline update without a full reload.
export async function approveAction(formData: FormData): Promise<void> {
	const key = String(formData.get("key") ?? "")
	if (!key) return
	await serverClient().approve(key)
	revalidatePath("/")
	revalidatePath("/agents")
}

export async function rejectAction(formData: FormData): Promise<void> {
	const key = String(formData.get("key") ?? "")
	if (!key) return
	const reason = String(formData.get("reason") ?? "").trim() || "Rejected from dashboard"
	await serverClient().reject(key, reason)
	revalidatePath("/")
	revalidatePath("/agents")
}

export async function startCheckout(
	plan: string,
): Promise<{ transactionId: string }> {
	const allowed = new Set(["pro", "scale"])
	if (!allowed.has(plan)) throw new Error(`unsupported plan: ${plan}`)
	const result = await serverClient().checkout(plan)
	return { transactionId: result.transactionId }
}
