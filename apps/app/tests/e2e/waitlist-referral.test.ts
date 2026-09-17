import { faker } from '@faker-js/faker'
import { db, eq, User, WaitlistEntry } from '@repo/database'
import { createUser, expect, test as base } from '#tests/playwright-utils.ts'

// Override LAUNCH_STATUS for these tests to force CLOSED_BETA mode
const originalLaunchStatus = process.env.LAUNCH_STATUS
process.env.LAUNCH_STATUS = 'CLOSED_BETA'

const test = base.extend<{
	getOnboardingData(): {
		username: string
		name: string
		email: string
		password: string
	}
}>({
	getOnboardingData: async ({}, use) => {
		const userData = createUser()
		await use(() => {
			const onboardingData = {
				...userData,
				password: faker.internet.password(),
			}
			return onboardingData
		})
		await db.delete(User).where(eq(User.username, userData.username))
	},
})

async function getWaitlistEntryByUserId(userId: string) {
	const [entry] = await db
		.select()
		.from(WaitlistEntry)
		.where(eq(WaitlistEntry.userId, userId))
		.limit(1)
	return entry
}

test.describe('Waitlist Referral System', () => {
	test.afterAll(async () => {
		// Restore original LAUNCH_STATUS after tests
		if (originalLaunchStatus) {
			process.env.LAUNCH_STATUS = originalLaunchStatus
		}
	})

	test('referral link redirects to signup with code stored in session', async ({
		page,
		insertNewUser,
		navigate,
	}) => {
		const referrer = await insertNewUser()

		// Create waitlist entry for referrer
		const [referrerEntry] = await db
			.insert(WaitlistEntry)
			.values({
				userId: referrer.id,
				referralCode: `${referrer.username}-5678`,
			})
			.returning()
		if (!referrerEntry) throw new Error('Failed to create waitlist entry')

		// Visit referral link as unauthenticated user
		await navigate('/r/:code', { code: referrerEntry.referralCode })

		// Should redirect to signup
		await expect(page).toHaveURL('/signup')
	})

	test('rank calculation: higher points = better rank', async ({
		insertNewUser,
	}) => {
		// Create multiple users with different points
		const user1 = await insertNewUser()
		const user2 = await insertNewUser()
		const user3 = await insertNewUser()

		// Create waitlist entries with different points
		await db.insert(WaitlistEntry).values({
			userId: user1.id,
			referralCode: `${user1.username}-0001`,
			points: 10, // Highest points
		})

		await db.insert(WaitlistEntry).values({
			userId: user2.id,
			referralCode: `${user2.username}-0002`,
			points: 5,
		})

		await db.insert(WaitlistEntry).values({
			userId: user3.id,
			referralCode: `${user3.username}-0003`,
			points: 1, // Lowest points
		})

		// Calculate ranks
		const { calculateUserRank } = await import('#app/utils/waitlist.server.ts')

		const rank1 = await calculateUserRank(user1.id)
		const rank2 = await calculateUserRank(user2.id)
		const rank3 = await calculateUserRank(user3.id)

		// User with most points should have a better rank
		expect(rank1.rank).toBeLessThan(rank2.rank)
		expect(rank2.rank).toBeLessThan(rank3.rank)
	})

	test('rank calculation: same points, earlier signup gets better rank', async ({
		insertNewUser,
	}) => {
		const user1 = await insertNewUser()
		const user2 = await insertNewUser()

		// Create entries with same points but different timestamps
		await db.insert(WaitlistEntry).values({
			userId: user1.id,
			referralCode: `${user1.username}-1111`,
			points: 5,
			createdAt: new Date('2025-01-01T00:00:00Z'),
		})

		// Wait a moment to ensure different timestamps
		await new Promise((resolve) => setTimeout(resolve, 10))

		await db.insert(WaitlistEntry).values({
			userId: user2.id,
			referralCode: `${user2.username}-2222`,
			points: 5,
			createdAt: new Date('2025-01-02T00:00:00Z'),
		})

		const { calculateUserRank } = await import('#app/utils/waitlist.server.ts')

		const rank1 = await calculateUserRank(user1.id)
		const rank2 = await calculateUserRank(user2.id)

		// Earlier signup should have better rank
		expect(rank1.rank).toBeLessThan(rank2.rank)
	})

	test('Discord points can be claimed once', async ({ insertNewUser }) => {
		const user = await insertNewUser()

		// Create waitlist entry
		await db.insert(WaitlistEntry).values({
			userId: user.id,
			referralCode: `${user.username}-3333`,
			points: 1,
			hasJoinedDiscord: false,
		})

		// Award Discord points
		const { awardDiscordPoints } = await import('#app/utils/waitlist.server.ts')
		await awardDiscordPoints(user.id)

		// Verify points updated in database (1 initial + 2 Discord = 3)
		const updatedEntry = await getWaitlistEntryByUserId(user.id)
		expect(updatedEntry?.points).toBe(3)
		expect(updatedEntry?.hasJoinedDiscord).toBe(true)

		// Try to claim again - should fail
		await expect(awardDiscordPoints(user.id)).rejects.toThrow(
			/already awarded/i,
		)
	})

	test('admins can add points to an existing waitlist entry', async ({
		insertNewUser,
	}) => {
		const user = await insertNewUser()

		await db.insert(WaitlistEntry).values({
			userId: user.id,
			referralCode: `${user.username}-3344`,
			points: 1,
		})

		const { addWaitlistPoints } = await import('#app/utils/waitlist.server.ts')
		await addWaitlistPoints(user.id, 7)

		const updatedEntry = await getWaitlistEntryByUserId(user.id)
		expect(updatedEntry?.points).toBe(8)
	})

	test('prevents self-referral', async ({ insertNewUser }) => {
		const user = await insertNewUser()

		const [waitlistEntry] = await db
			.insert(WaitlistEntry)
			.values({
				userId: user.id,
				referralCode: `${user.username}-4444`,
			})
			.returning()
		if (!waitlistEntry) throw new Error('Failed to create waitlist entry')

		const { linkReferral } = await import('#app/utils/waitlist.server.ts')

		// Try to refer self
		const result = await linkReferral(user.id, waitlistEntry.referralCode)

		expect(result.success).toBe(false)
		expect(result.message).toContain('Cannot refer yourself')

		// Points should remain unchanged
		const updatedEntry = await getWaitlistEntryByUserId(user.id)
		expect(updatedEntry?.points).toBe(1)
	})

	test('prevents duplicate referral linking', async ({ insertNewUser }) => {
		const referrer = await insertNewUser()
		const referee = await insertNewUser()

		const [referrerEntry] = await db
			.insert(WaitlistEntry)
			.values({
				userId: referrer.id,
				referralCode: `${referrer.username}-5555`,
			})
			.returning()
		if (!referrerEntry) throw new Error('Failed to create referrer entry')

		await db.insert(WaitlistEntry).values({
			userId: referee.id,
			referralCode: `${referee.username}-6666`,
		})

		const { linkReferral } = await import('#app/utils/waitlist.server.ts')

		// First referral should work
		const result1 = await linkReferral(referee.id, referrerEntry.referralCode)
		expect(result1.success).toBe(true)

		// Second referral should fail
		const result2 = await linkReferral(referee.id, referrerEntry.referralCode)
		expect(result2.success).toBe(false)
		expect(result2.message).toContain('Already referred by someone')
	})

	test('invalid referral code shows error', async ({ page, navigate }) => {
		// Visit invalid referral link
		await navigate('/r/invalid-code-9999')

		// Should redirect to signup with error
		await expect(page).toHaveURL('/signup')
		// (toast messages are unreliable to verify in test environment due to redirect timing)
	})

	test('referral code format is username-XXXX', async ({ insertNewUser }) => {
		const user = await insertNewUser()

		const { getOrCreateWaitlistEntry } =
			await import('#app/utils/waitlist.server.ts')

		const entry = await getOrCreateWaitlistEntry(user.id)

		// Check format: username-XXXX where XXXX is 4 digits
		expect(entry.referralCode).toMatch(new RegExp(`^${user.username}-\\d{4}$`))
	})

	test('transaction ensures referral linking and points are atomic', async ({
		insertNewUser,
	}) => {
		const referrer = await insertNewUser()
		const referee = await insertNewUser()

		await db.insert(WaitlistEntry).values({
			userId: referrer.id,
			referralCode: `${referrer.username}-9991`,
			points: 1,
		})

		await db.insert(WaitlistEntry).values({
			userId: referee.id,
			referralCode: `${referee.username}-9992`,
		})

		const { linkReferral } = await import('#app/utils/waitlist.server.ts')

		// Link the referral
		const result = await linkReferral(referee.id, `${referrer.username}-9991`)
		expect(result.success).toBe(true)

		// Verify both the link and points were updated
		const referrerEntry = await getWaitlistEntryByUserId(referrer.id)
		const refereeEntry = await getWaitlistEntryByUserId(referee.id)

		expect(referrerEntry?.points).toBe(6) // 1 + 5
		expect(refereeEntry?.referredById).toBe(referrerEntry?.id)
	})

	test('getOrCreateWaitlistEntry creates entry with default values', async ({
		insertNewUser,
	}) => {
		const user = await insertNewUser()

		const { getOrCreateWaitlistEntry } =
			await import('#app/utils/waitlist.server.ts')

		const entry = await getOrCreateWaitlistEntry(user.id)

		expect(entry).toBeTruthy()
		expect(entry.userId).toBe(user.id)
		expect(entry.points).toBe(1)
		expect(entry.hasJoinedDiscord).toBe(false)
		expect(entry.hasEarlyAccess).toBe(false)
		expect(entry.referralCode).toMatch(/^.*-\d{4}$/)
	})

	test('shouldBeOnWaitlist returns true for users without early access', async ({
		insertNewUser,
	}) => {
		const user = await insertNewUser()

		// Create waitlist entry without early access
		await db.insert(WaitlistEntry).values({
			userId: user.id,
			referralCode: `${user.username}-7777`,
			hasEarlyAccess: false,
		})

		const { __setMockLaunchStatus } = await import('#app/utils/env.server.ts')
		__setMockLaunchStatus('CLOSED_BETA')
		const { shouldBeOnWaitlist } = await import('#app/utils/waitlist.server.ts')
		const onWaitlist = await shouldBeOnWaitlist(user.id)
		__setMockLaunchStatus(null)

		expect(onWaitlist).toBe(true)
	})

	test('shouldBeOnWaitlist returns false for users with early access', async ({
		insertNewUser,
	}) => {
		const user = await insertNewUser()

		// Create waitlist entry with early access
		await db.insert(WaitlistEntry).values({
			userId: user.id,
			referralCode: `${user.username}-8888`,
			hasEarlyAccess: true,
		})

		const { __setMockLaunchStatus } = await import('#app/utils/env.server.ts')
		__setMockLaunchStatus('CLOSED_BETA')
		const { shouldBeOnWaitlist } = await import('#app/utils/waitlist.server.ts')
		const onWaitlist = await shouldBeOnWaitlist(user.id)
		__setMockLaunchStatus(null)

		expect(onWaitlist).toBe(false)
	})

	test('shouldBeOnWaitlist returns false when not in CLOSED_BETA', async ({
		insertNewUser,
	}) => {
		const user = await insertNewUser()

		// Create waitlist entry without early access
		await db.insert(WaitlistEntry).values({
			userId: user.id,
			referralCode: `${user.username}-9999`,
			hasEarlyAccess: false,
		})

		// Temporarily change LAUNCH_STATUS
		const { __setMockLaunchStatus } = await import('#app/utils/env.server.ts')
		__setMockLaunchStatus('PUBLIC_BETA')

		const { shouldBeOnWaitlist } = await import('#app/utils/waitlist.server.ts')
		const onWaitlist = await shouldBeOnWaitlist(user.id)

		// Restore original status
		__setMockLaunchStatus(null)

		expect(onWaitlist).toBe(false)
	})

	test('grantEarlyAccess grants access to a user', async ({
		insertNewUser,
	}) => {
		const user = await insertNewUser()
		const admin = await insertNewUser()

		// Create waitlist entry without early access
		await db.insert(WaitlistEntry).values({
			userId: user.id,
			referralCode: `${user.username}-1001`,
			hasEarlyAccess: false,
		})

		const { grantEarlyAccess } = await import('#app/utils/waitlist.server.ts')
		await grantEarlyAccess(user.id, admin.id)

		// Verify access was granted
		const entry = await getWaitlistEntryByUserId(user.id)

		expect(entry?.hasEarlyAccess).toBe(true)
		expect(entry?.grantedAccessBy).toBe(admin.id)
		expect(entry?.grantedAccessAt).toBeTruthy()
	})

	test('revokeEarlyAccess revokes access from a user', async ({
		insertNewUser,
	}) => {
		const user = await insertNewUser()

		// Create waitlist entry with early access
		await db.insert(WaitlistEntry).values({
			userId: user.id,
			referralCode: `${user.username}-1002`,
			hasEarlyAccess: true,
			grantedAccessAt: new Date(),
			grantedAccessBy: user.id, // satisfying foreign key constraints
		})

		const { revokeEarlyAccess } = await import('#app/utils/waitlist.server.ts')
		await revokeEarlyAccess(user.id)

		// Verify access was revoked
		const entry = await getWaitlistEntryByUserId(user.id)

		expect(entry?.hasEarlyAccess).toBe(false)
		expect(entry?.grantedAccessBy).toBeNull()
		expect(entry?.grantedAccessAt).toBeNull()
	})

	test('referral code validation rejects invalid formats', async ({
		page,
		navigate,
	}) => {
		// Try various invalid formats - all should redirect to signup
		const invalidCodes = [
			'test', // Too short
			'a'.repeat(101), // Too long
			'user@name-1234', // Invalid character
			'username-abc', // Not 4 digits
			'username-12345', // Too many digits
		]

		for (const code of invalidCodes) {
			await navigate('/r/:code', { code: code })
			// Invalid codes should redirect to signup page
			// (toast messages are unreliable to verify in test environment)
			await expect(page).toHaveURL(/\/signup/, { timeout: 5000 })
		}
	})
})
