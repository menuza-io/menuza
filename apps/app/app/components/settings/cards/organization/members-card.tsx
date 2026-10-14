import {
	OrganizationMembers,
	type OrganizationRoleOption,
	type StaffingLocationControl,
} from '#app/components/organization-members.tsx'

interface OrganizationMember {
	userId: string
	organizationRole: {
		id: string
		name: string
		description: string
		level: number
	}
	active: boolean
	user: {
		id: string
		name: string | null
		email: string
		image?: {
			id: string
			altText: string | null
		} | null
	}
}

export function MembersCard({
	members,
	currentUserId,
	availableRoles,
	organizationSlug,
	canManageRoles,
	staffingLocations,
}: {
	members: OrganizationMember[]
	currentUserId: string
	availableRoles?: OrganizationRoleOption[]
	organizationSlug?: string
	canManageRoles?: boolean
	staffingLocations?: StaffingLocationControl | null
}) {
	return (
		<OrganizationMembers
			members={members}
			currentUserId={currentUserId}
			availableRoles={availableRoles}
			organizationSlug={organizationSlug}
			canManageRoles={canManageRoles}
			staffingLocations={staffingLocations}
		/>
	)
}
