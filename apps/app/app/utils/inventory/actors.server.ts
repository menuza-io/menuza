import { db, eq, User, UserOrganization } from '@repo/database'

/** A signed-in person's display name: their name, else their username. */
function displayName(row: { name: string | null; username: string }): string {
	return row.name?.trim() || row.username
}

/**
 * Names of the organization's members by user id, so the History and Waste
 * logs can show who did something. The region only knows operator user ids
 * (`actor.id`); names stay in the control plane and are joined here.
 */
export async function loadMemberNames(
	organizationId: string,
): Promise<Record<string, string>> {
	const rows = await db
		.select({
			id: User.id,
			name: User.name,
			username: User.username,
		})
		.from(UserOrganization)
		.innerJoin(User, eq(User.id, UserOrganization.userId))
		.where(eq(UserOrganization.organizationId, organizationId))
	return Object.fromEntries(rows.map((row) => [row.id, displayName(row)]))
}

export async function loadUserName(userId: string): Promise<string> {
	const [row] = await db
		.select({ name: User.name, username: User.username })
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)
	return row ? displayName(row) : ''
}
