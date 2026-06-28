import { serverClient } from "@/lib/server-client"
import { ApiKeysManager } from "@/components/ApiKeysManager"

// Self-serve API key management (Phase 1). Lists this org's keys and lets the
// user create / rotate / revoke them. New secrets are shown exactly once.
export const dynamic = "force-dynamic"

export default async function KeysPage() {
	const keys = await serverClient().listKeys()
	return (
		<>
			<h1>API keys</h1>
			<p className="subtle">
				Create, rotate, and revoke keys for this organization. A key&apos;s secret
				is shown only once at creation &mdash; copy it somewhere safe.
			</p>
			<ApiKeysManager initialKeys={keys} />
		</>
	)
}
