import { serverClient } from "@/lib/server-client"
import { OnboardingFlow } from "@/components/OnboardingFlow"

// Guided onboarding (Phase 1 / Step 5). Detects whether the org already has any
// tracked actions so we can show the right empty-state vs. success messaging.
export const dynamic = "force-dynamic"

export default async function OnboardingPage() {
	let hasActions = false
	try {
		const recent = await serverClient().listRecent(1)
		hasActions = recent.length > 0
	} catch {
		// org may not be provisioned yet; step 1 handles it.
	}

	return (
		<>
			<h1>Get started</h1>
			<p className="subtle">Three steps to your first tracked agent action.</p>
			<OnboardingFlow hasActions={hasActions} />
		</>
	)
}
