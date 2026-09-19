import { db, WaitlistEntry } from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

test('menu page loads for organization admin', async ({
	page,
	login,
	navigate,
}) => {
	const user = await login()
	await db
		.insert(WaitlistEntry)
		.values({
			userId: user.id,
			referralCode: `e2e-menu-${user.id}`,
			hasEarlyAccess: true,
			grantedAccessAt: new Date(),
			grantedAccessBy: user.id,
		})
		.onConflictDoUpdate({
			target: WaitlistEntry.userId,
			set: { hasEarlyAccess: true, grantedAccessAt: new Date() },
		})

	const organization = await createTestOrganization(user.id, 'admin')

	await navigate('/:slug/menu', { slug: organization.slug })
	await expect(page.getByRole('heading', { name: /^menu$/i })).toBeVisible({
		timeout: 15_000,
	})
})
