import { db, eq, Integration } from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

test.describe('Integration Settings & Providers Management', () => {
	test('Operators can view available integrations catalog and request banner', async ({
		page,
		login,
		navigate,
	}, testInfo) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await navigate('/:slug/settings/integrations', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify page title and header
		await expect(
			page.getByRole('heading', { name: /^integrations$/i }),
		).toBeVisible()

		// Verify provider cards in the catalog
		await expect(page.getByText('Slack').first()).toBeVisible()
		await expect(page.getByText('Jira').first()).toBeVisible()
		await expect(page.getByText('Linear').first()).toBeVisible()
		await expect(page.getByText('GitLab').first()).toBeVisible()

		// Verify related providers appear in named groups
		for (const [name, providers] of [
			['Communication', ['Slack']],
			['Project management', ['Jira', 'Linear', 'ClickUp', 'Asana', 'Trello']],
			['Development', ['GitLab', 'GitHub']],
			['Knowledge management', ['Notion']],
		] as const) {
			const group = page.getByRole('region', { name, exact: true })
			await expect(group).toBeVisible()
			for (const provider of providers) {
				await expect(
					group.getByRole('heading', { name: provider, exact: true }),
				).toBeVisible()
			}
		}
		await expect(
			page.getByRole('region', { name: 'Other integrations' }),
		).toHaveCount(0)

		// Verify request integration banner
		await expect(
			page.getByText(/need an integration but don't see it here\?/i),
		).toBeVisible()
		await expect(
			page.getByRole('link', { name: /request integration/i }),
		).toBeVisible()

		await page.screenshot({
			path: testInfo.outputPath('integrations-desktop.png'),
			fullPage: true,
		})
		await page.setViewportSize({ width: 390, height: 844 })
		for (const group of await page.getByRole('region').all()) {
			const bounds = await group.boundingBox()
			if (!bounds) continue
			expect(bounds.x).toBeGreaterThanOrEqual(0)
			expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
		}
		await page.screenshot({
			path: testInfo.outputPath('integrations-mobile.png'),
			fullPage: true,
		})
	})

	test('Operators can view connected integrations and disconnect an active integration', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		// Seed an active Slack integration
		const [seededIntegration] = await db
			.insert(Integration)
			.values({
				organizationId: org.id,
				providerName: 'slack',
				providerType: 'productivity',
				config: '{}',
				isActive: true,
			})
			.returning()

		if (!seededIntegration) throw new Error('Seeded integration not found')
		expect(seededIntegration).toBeTruthy()

		await navigate('/:slug/settings/integrations', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify disconnect button appears for connected integration
		const disconnectButton = page.getByRole('button', {
			name: /^disconnect$/i,
		})
		await expect(disconnectButton).toBeVisible()

		// Disconnect the integration
		await Promise.all([
			page.waitForResponse(
				(res) =>
					res.url().includes('/settings/integrations') &&
					res.request().method() === 'POST',
			),
			disconnectButton.click(),
		])

		// Verify button reverts to Connect
		await expect(
			page.getByRole('button', { name: /^disconnect$/i }),
		).not.toBeVisible()

		// Verify integration was removed from the database
		const [deletedIntegration] = await db
			.select()
			.from(Integration)
			.where(eq(Integration.id, seededIntegration.id))
			.limit(1)

		expect(deletedIntegration).toBeUndefined()
	})
})
