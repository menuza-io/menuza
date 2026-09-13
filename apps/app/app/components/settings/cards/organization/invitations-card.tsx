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
}: {
	pendingInvitations: OrganizationInvitation[]
	inviteLink?: OrganizationInviteLink | null
	actionData?: any
	availableRoles?: OrganizationRoleOption[]
	organizationSlug?: string
	canManageRoles?: boolean
}) {
	return (
		<OrganizationInvitations
			pendingInvitations={pendingInvitations}
			inviteLink={inviteLink}
			actionData={actionData}
			availableRoles={availableRoles}
			organizationSlug={organizationSlug}
			canManageRoles={canManageRoles}
		/>
	)
}
