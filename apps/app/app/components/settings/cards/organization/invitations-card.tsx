import { OrganizationInvitations } from '#app/components/organization-invitations.tsx'
import { type OrganizationRoleOption } from '#app/components/organization-members.tsx'

interface OrganizationInvitation {
	id: string
	email: string
	organizationRole: {
		id: string
		name: string
	}
	createdAt: Date
	inviter?: { name: string | null; email: string } | null
	locationScope?: string
	locationIds?: string[]
	hasNoLocations?: boolean
}

interface OrganizationInviteLink {
	id: string
	token: string
	organizationRole: {
		id: string
		name: string
	}
	isActive: boolean
	createdAt: Date
}

export function InvitationsCard({
	pendingInvitations,
	inviteLink,
	actionData,
	availableRoles,
	organizationSlug,
	canManageRoles,
	locationNames,
	invitableLocationIds,
}: {
	pendingInvitations: OrganizationInvitation[]
	inviteLink?: OrganizationInviteLink | null
	actionData?: any
	availableRoles?: OrganizationRoleOption[]
	organizationSlug?: string
	canManageRoles?: boolean
	locationNames?: Record<string, string>
	invitableLocationIds?: string[] | null
}) {
	return (
		<OrganizationInvitations
			pendingInvitations={pendingInvitations}
			inviteLink={inviteLink}
			actionData={actionData}
			availableRoles={availableRoles}
			organizationSlug={organizationSlug}
			canManageRoles={canManageRoles}
			locationNames={locationNames}
			invitableLocationIds={invitableLocationIds}
		/>
	)
}
