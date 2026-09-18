import { db, OrganizationLocation, WaitlistEntry } from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

test('location edit page loads without React update loop', async ({
	page,
	login,
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
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: 'Smoke Test Location',
			phone: '+17135551234',
			addressLine1: '123 Main St',
			city: 'Houston',
			state: 'TX',
			postalCode: '77002',
			latitude: 29.7604,
			longitude: -95.3698,
			googlePlaceId: 'mock-place-houston',
			formattedAddress: '123 Main St, Houston, TX 77002, USA',
		})
		.returning({ id: OrganizationLocation.id })

	if (!location) throw new Error('Failed to create location')

	const errors: string[] = []
	page.on('pageerror', (error) => {
		errors.push(error.message)
	})
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text())
	})

	const response = await page.goto(
		`/${organization.slug}/locations/${location.id}`,
		{ waitUntil: 'networkidle' },
	)
	expect(response?.status()).toBe(200)
	await expect(
		page.getByRole('heading', { name: 'Smoke Test Location' }),
	).toBeVisible({ timeout: 15_000 })
	await page.waitForTimeout(1500)

	const depthErrors = errors.filter((message) =>
		message.includes('Maximum update depth'),
	)
	expect(depthErrors).toEqual([])
})
