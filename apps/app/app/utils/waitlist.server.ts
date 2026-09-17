import { randomInt } from 'node:crypto'
import {
	and,
	count,
	db,
	eq,
	gt,
	lt,
	or,
	sql,
	WaitlistEntry,
	User,
} from '@repo/database'
import { getLaunchStatus } from './env.server.ts'

const REFERRAL_POINTS = 5
const DISCORD_POINTS = 2
export const MAX_ADMIN_POINTS_ADJUSTMENT = 1000

export async function generateReferralCode(username: string): Promise<string> {
	while (true) {
		const referralCode = `${username}-${randomInt(1000, 10000)}`
		const [existing] = await db
			.select({ id: WaitlistEntry.id })
			.from(WaitlistEntry)
			.where(eq(WaitlistEntry.referralCode, referralCode))
			.limit(1)
		if (!existing) return referralCode
	}
}

async function withReferrals(entry: typeof WaitlistEntry.$inferSelect) {
	const [referredBy] = entry.referredById
		? await db
				.select()
				.from(WaitlistEntry)
				.where(eq(WaitlistEntry.id, entry.referredById))
				.limit(1)
		: []
	const referrals = await db
		.select()
		.from(WaitlistEntry)
		.where(eq(WaitlistEntry.referredById, entry.id))
	return { ...entry, referredBy: referredBy ?? null, referrals }
}

export async function getOrCreateWaitlistEntry(userId: string) {
	const [user] = await db
		.select({ username: User.username })
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)
	if (!user) throw new Error('User not found')
	let [entry] = await db
		.select()
		.from(WaitlistEntry)
		.where(eq(WaitlistEntry.userId, userId))
		.limit(1)
	if (!entry) {
		entry = (
			await db
				.insert(WaitlistEntry)
				.values({
					userId,
					referralCode: await generateReferralCode(user.username),
				})
				.returning()
		)[0]
	}
	if (!entry) throw new Error('Failed to create waitlist entry')
	return withReferrals(entry)
}

export async function calculateUserRank(
	userId: string,
): Promise<{ rank: number; totalUsers: number }> {
	const [entry] = await db
		.select()
		.from(WaitlistEntry)
		.where(eq(WaitlistEntry.userId, userId))
		.limit(1)
	if (!entry) throw new Error('Waitlist entry not found')
	const [rankRow] = await db
		.select({ value: count() })
		.from(WaitlistEntry)
		.where(
			or(
				gt(WaitlistEntry.points, entry.points),
				and(
					eq(WaitlistEntry.points, entry.points),
					lt(WaitlistEntry.createdAt, entry.createdAt),
				),
			),
		)
	const [totalRow] = await db.select({ value: count() }).from(WaitlistEntry)
	return { rank: (rankRow?.value ?? 0) + 1, totalUsers: totalRow?.value ?? 0 }
}

export async function awardReferralPoints(referrerId: string) {
	const [entry] = await db
		.select({ id: WaitlistEntry.id })
		.from(WaitlistEntry)
		.where(eq(WaitlistEntry.userId, referrerId))
		.limit(1)
	if (!entry) throw new Error('Referrer waitlist entry not found')
	const current = await db
		.select({ points: WaitlistEntry.points })
		.from(WaitlistEntry)
		.where(eq(WaitlistEntry.id, entry.id))
		.limit(1)
	await db
		.update(WaitlistEntry)
		.set({ points: (current[0]?.points ?? 0) + REFERRAL_POINTS })
		.where(eq(WaitlistEntry.id, entry.id))
}

export async function awardDiscordPoints(userId: string) {
	const [entry] = await db
		.select()
		.from(WaitlistEntry)
		.where(
			and(
				eq(WaitlistEntry.userId, userId),
				eq(WaitlistEntry.hasJoinedDiscord, false),
			),
		)
		.limit(1)
	if (!entry) {
		const [existing] = await db
			.select({ id: WaitlistEntry.id })
			.from(WaitlistEntry)
			.where(eq(WaitlistEntry.userId, userId))
			.limit(1)
		if (!existing) throw new Error('Waitlist entry not found')
		throw new Error('Discord points already awarded')
	}
	await db
		.update(WaitlistEntry)
		.set({ hasJoinedDiscord: true, points: entry.points + DISCORD_POINTS })
		.where(eq(WaitlistEntry.id, entry.id))
}

export async function addWaitlistPoints(userId: string, points: number) {
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

export async function linkReferral(userId: string, referralCode: string) {
	const [referrer] = await db
		.select()
		.from(WaitlistEntry)
		.where(eq(WaitlistEntry.referralCode, referralCode))
		.limit(1)
	if (!referrer) return { success: false, message: 'Invalid referral code' }
	if (referrer.userId === userId)
		return { success: false, message: 'Cannot refer yourself' }
	const [entry] = await db
		.select()
		.from(WaitlistEntry)
		.where(eq(WaitlistEntry.userId, userId))
		.limit(1)
	if (entry?.referredById)
		return { success: false, message: 'Already referred by someone' }
	if (!entry) return { success: false, message: 'Waitlist entry not found' }
	await db.transaction(async (tx) => {
		await tx
			.update(WaitlistEntry)
			.set({ referredById: referrer.id })
			.where(eq(WaitlistEntry.id, entry.id))
		await tx
			.update(WaitlistEntry)
			.set({ points: referrer.points + REFERRAL_POINTS })
			.where(eq(WaitlistEntry.id, referrer.id))
	})
	return { success: true, message: 'Referral linked successfully' }
}

export async function shouldBeOnWaitlist(userId: string): Promise<boolean> {
	if (getLaunchStatus() !== 'CLOSED_BETA') return false
	const [entry] = await db
		.select({ hasEarlyAccess: WaitlistEntry.hasEarlyAccess })
		.from(WaitlistEntry)
		.where(eq(WaitlistEntry.userId, userId))
		.limit(1)
	return !entry || !entry.hasEarlyAccess
}

export async function grantEarlyAccess(userId: string, grantedBy: string) {
	await db
		.update(WaitlistEntry)
		.set({
			hasEarlyAccess: true,
			grantedAccessAt: new Date(),
			grantedAccessBy: grantedBy,
		})
		.where(eq(WaitlistEntry.userId, userId))
}

export async function revokeEarlyAccess(userId: string) {
	await db
		.update(WaitlistEntry)
		.set({
			hasEarlyAccess: false,
			grantedAccessAt: null,
			grantedAccessBy: null,
		})
		.where(eq(WaitlistEntry.userId, userId))
}
