import { auth, clerkClient } from "@clerk/nextjs/server"
import { QuorvelClient } from "./quorvel"

// Builds a server-side QuorvelClient bound to the *current Clerk org*.
// Only imported by server components / actions / route handlers, so the
// dashboard service secret never reaches the browser.
//
// Auth model (matches apps/api/src/router.ts):
//   - Authenticate to the API as the trusted dashboard via the shared
//     DASHBOARD_SERVICE_SECRET (header: x-dashboard-secret).
//   - Pass the signed-in Clerk org + user as context headers. The API
//     (authenticateDashboard) resolves/auto-mirrors the internal org per
//     Clerk org -> real per-tenant isolation.
export function serverClient(): QuorvelClient {
	const baseUrl = process.env.QUORVEL_API_URL
	const dashboardSecret = process.env.DASHBOARD_SERVICE_SECRET
	if (!baseUrl || !dashboardSecret) {
		throw new Error("QUORVEL_API_URL and DASHBOARD_SERVICE_SECRET must be set")
	}

	return new QuorvelClient({
		baseUrl,
		// Resolved lazily per request so serverClient() stays synchronous and
		// auth() runs inside the active request scope.
		authProvider: async () => {
			const { userId, orgId } = await auth()
			if (!userId) throw new Error("Not signed in")
			if (!orgId) throw new Error("No active organization — create or select one first")

			const headers: Record<string, string> = {
				"x-dashboard-secret": dashboardSecret,
				"x-clerk-org-id": orgId,
				"x-clerk-user-id": userId,
			}

			// Best-effort display name so a freshly mirrored org isn't just "org".
			// Cosmetic only — API falls back to "org" if absent.
			try {
				const client = await clerkClient()
				const org = await client.organizations.getOrganization({ organizationId: orgId })
				if (org?.name) headers["x-clerk-org-name"] = org.name
			} catch {
				/* name is non-critical */
			}

			return headers
		},
	})
}