import { db, WaitlistEntry } from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

test('menu hub shows section navigation and publish gate', async ({
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

	const menuNav = page.getByRole('navigation', { name: /menu sections/i })
	await expect(menuNav).toBeVisible()
	for (const label of [
		'Overview',
		'Menus',
		'Categories',
		'Items',
		'Modifier sets',
		'Modifiers',
	]) {
		await expect(
			menuNav.getByRole('link', { name: label, exact: true }),
		).toBeVisible()
	}

	const publishGateLink = page.getByRole('link', {
		name: /go to website settings/i,
	})
	await expect(publishGateLink).toBeVisible()
	await expect(publishGateLink).toHaveAttribute(
		'href',
		`/${organization.slug}/website`,
	)
})
