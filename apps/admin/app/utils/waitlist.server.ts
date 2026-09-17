import { WaitlistEntry, db, eq, sql } from '@repo/database'

export const MAX_ADMIN_POINTS_ADJUSTMENT = 1000

/**
 * Grant early access to a user on the waitlist
 */
export async function grantEarlyAccess(
	userId: string,
	grantedBy: string,
): Promise<void> {
	await db
		.update(WaitlistEntry)
		.set({
			hasEarlyAccess: true,
			grantedAccessAt: new Date(),
			grantedAccessBy: grantedBy,
		})
		.where(eq(WaitlistEntry.userId, userId))
}

/**
 * Revoke early access from a user
 */
export async function revokeEarlyAccess(userId: string): Promise<void> {
	await db
		.update(WaitlistEntry)
		.set({
			hasEarlyAccess: false,
			grantedAccessAt: null,
			grantedAccessBy: null,
		})
		.where(eq(WaitlistEntry.userId, userId))
}

/**
 * Add manually awarded points without a read-then-write race.
 */
export async function addWaitlistPoints(
	userId: string,
	points: number,
): Promise<void> {
	if (
		!Number.isSafeInteger(points) ||
		points < 1 ||
		points > MAX_ADMIN_POINTS_ADJUSTMENT
	) {
		throw new Error(
			`Points must be a whole number between 1 and ${MAX_ADMIN_POINTS_ADJUSTMENT}`,
		)
	}

	const updatedEntries = await db
		.update(WaitlistEntry)
		.set({ points: sql`${WaitlistEntry.points} + ${points}` })
		.where(eq(WaitlistEntry.userId, userId))
		.returning({ id: WaitlistEntry.id })

	if (updatedEntries.length === 0) {
		throw new Error('Waitlist entry not found')
	}
}
