import { db, inArray, User } from '@repo/database'
import { resolveAlertMembers } from '#app/utils/alerts/members.server.ts'

export type CountAssigneeMember = { id: string; name: string }

/**
 * The members of the organization who can be made responsible for a scheduled
 * count at a location (#491): people with a login who may see inventory there.
 * Staff on the roster are read in the browser from the region, never here
 * (their names are regional data). Ordered by name.
 */
export async function listCountAssigneeMembers(input: {
	organizationId: string
	locationId: string | null
}): Promise<CountAssigneeMember[]> {
	const members = await resolveAlertMembers({
		organizationId: input.organizationId,
		permission: 'read:inventory:any',
		locationId: input.locationId,
	})
	if (members.length === 0) return []
	const users = await db
		.select({ id: User.id, name: User.name, email: User.email })
		.from(User)
		.where(
			inArray(
				User.id,
				members.map((member) => member.userId),
			),
		)
	return users
		.map((user) => ({ id: user.id, name: user.name?.trim() || user.email }))
		.sort((a, b) => a.name.localeCompare(b.name))
}
