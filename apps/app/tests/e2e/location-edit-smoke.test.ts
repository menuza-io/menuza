import { db, WaitlistEntry } from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

test('location edit page loads without React update loop', async ({
	page,
	login,
	navigate,
}) => {
	const user = await login()
	await db
		.insert(WaitlistEntry)
		.values({
			userId: user.id,
			referralCode: `e2e-${user.id}`,
			hasEarlyAccess: true,
			grantedAccessAt: new Date(),
			grantedAccessBy: user.id,
		})
		.onConflictDoUpdate({
			target: WaitlistEntry.userId,
			set: { hasEarlyAccess: true, grantedAccessAt: new Date() },
		})

	const organization = await createTestOrganization(user.id, 'admin')

	const errors: string[] = []
	page.on('pageerror', (error) => {
		errors.push(error.message)
	})
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text())
	})

	await navigate('/:slug/locations', { slug: organization.slug })
	await expect(page.getByRole('heading', { name: /locations/i })).toBeVisible({
		timeout: 15_000,
	})

	const editControl = page.getByRole('button', { name: /^edit$/i }).first()
	await expect(editControl).toBeVisible({ timeout: 15_000 })
	await editControl.click()
	await page.waitForLoadState('networkidle')
	await page.waitForTimeout(1500)

	const depthErrors = errors.filter((message) =>
		message.includes('Maximum update depth'),
	)
	expect(depthErrors).toEqual([])
})
