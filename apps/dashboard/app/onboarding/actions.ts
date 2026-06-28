"use server"

import { revalidatePath } from "next/cache"
import { serverClient } from "@/lib/server-client"

// Step 5 onboarding helpers. provisionAction ensures the signed-in Clerk org is
// mirrored in Neon and returns the first API key (only on initial creation).
// seedSampleAction inserts a few sample actions so the dashboard isn't empty.

export async function provisionAction(): Promise<{
	orgId: string
	created: boolean
	apiKey?: string
	keyPrefix?: string
}> {
	const res = await serverClient().provisionOrg()
	revalidatePath("/onboarding")
	return res
}

export async function seedSampleAction(): Promise<{ created: number }> {
	const res = await serverClient().seedSample()
	revalidatePath("/")
	revalidatePath("/onboarding")
	return res
}
