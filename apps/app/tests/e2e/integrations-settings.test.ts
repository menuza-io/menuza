import { db, eq, Integration, OrganizationLocation } from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

test.describe('Integration Settings & Providers Management', () => {
	test('Operators can view the POS integrations catalog', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await navigate('/:slug/settings/integrations', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		await expect(
			page.getByRole('heading', { name: /^integrations$/i }).first(),
		).toBeVisible()

		// The POS/delivery platforms are shown
		await expect(page.getByText('Clover').first()).toBeVisible()
		await expect(page.getByText('Square').first()).toBeVisible()
		await expect(page.getByText('Toast').first()).toBeVisible()
		await expect(page.getByText('Uber Eats').first()).toBeVisible()
		await expect(page.getByText('DoorDash').first()).toBeVisible()

		await expect(page.getByText('Slack').first()).toBeVisible()
		await expect(page.getByText('Jira').first()).toBeVisible()

		await expect(
			page.getByText(/need an integration but don't see it here\?/i).first(),
		).toBeVisible()
	})

	test('Operators can connect a POS platform in sandbox mode', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await navigate('/:slug/settings/integrations', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		await page
			.getByRole('group', { name: 'Clover', exact: true })
			.getByRole('button', { name: /^connect$/i })
			.click()

		// The connected card shows the Connected badge and a Disconnect action
		await expect(page.getByText('Connected').first()).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^disconnect$/i }),
		).toBeVisible()

		const [integration] = await db
			.select()
			.from(Integration)
			.where(eq(Integration.organizationId, org.id))
			.limit(1)
		expect(integration?.providerName).toBe('clover')
	})

	test('Operators can disconnect an active POS integration', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		const [location] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: org.id,
				name: 'Main location',
				slug: 'main',
				isDefault: true,
			})
			.returning()
		if (!location) throw new Error('Seeded location not found')
		const organizationLocationId = location.id

		const [seededIntegration] = await db
			.insert(Integration)
			.values({
				organizationId: org.id,
				organizationLocationId,
				providerName: 'clover',
				providerType: 'pos',
				config: JSON.stringify({
					environment: 'sandbox',
					merchantId: 'M_SANDBOX_CLOVER',
				}),
				isActive: true,
			})
			.returning()

		if (!seededIntegration) throw new Error('Seeded integration not found')

		await navigate('/:slug/settings/integrations', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		const disconnectButton = page.getByRole('button', {
			name: /^disconnect$/i,
		})
		await expect(disconnectButton).toBeVisible()

		await Promise.all([
			page.waitForResponse(
				(res) =>
					res.url().includes('/settings/integrations') &&
					res.request().method() === 'POST',
			),
			disconnectButton.click(),
		])

		await expect(
			page.getByRole('button', { name: /^disconnect$/i }),
		).toHaveCount(0)

		const [deletedIntegration] = await db
			.select()
			.from(Integration)
			.where(eq(Integration.id, seededIntegration.id))
			.limit(1)

		expect(deletedIntegration).toBeUndefined()
	})
})
