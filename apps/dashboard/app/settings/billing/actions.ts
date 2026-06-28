"use server"

import { serverClient } from "@/lib/server-client"

// Opens Paddle's hosted customer billing portal for the signed-in org
// (Phase 2). Returns a short-lived URL the client redirects to. Throws a
// friendly error if the org has not completed a checkout yet (no customer id).
export async function openPortalAction(): Promise<{ url: string }> {
	return serverClient().billingPortal()
}
