import { OrganizationProfile } from "@clerk/nextjs"

// Members & roles (Phase 1). Clerk's <OrganizationProfile/> handles the full
// members, roles (owner/admin/member), and invite flow for us, so we just mount
// it. Membership maps to Neon via clerk_org_id on first request.
export const dynamic = "force-dynamic"

export default function MembersPage() {
	return (
		<>
			<h1>Members</h1>
			<p className="subtle">
				Invite teammates and manage roles for this organization.
			</p>
			<div className="members-wrap">
				<OrganizationProfile routing="hash" />
			</div>
		</>
	)
}
