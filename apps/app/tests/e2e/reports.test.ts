import { db, eq, SavedReport } from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

test.describe('Reports & Analytics Workspace', () => {
	test('Operators can view reports dashboard and browse template categories', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await navigate('/:slug/reports', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify main heading and description
		await expect(
			page.getByRole('heading', { name: /^analytics & reports$/i }),
		).toBeVisible()

		// Verify the reports library action and template catalogue.
		await expect(
			page.getByRole('button', { name: /new report/i }),
		).toBeVisible()
		await expect(page.getByText('Start from a template')).toBeVisible()

		// Verify template links are present in sidebar/start sections
		await expect(
			page.getByRole('link', { name: /customer list/i }).first(),
		).toBeVisible()
		await expect(
			page.getByRole('link', { name: /phone verification/i }).first(),
		).toBeVisible()
	})

	test('Operators can launch a template, save a custom report, and see it in saved reports', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await navigate('/:slug/reports', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Launch the "Notes by status" template
		const templateLink = page
			.getByRole('link', { name: /notes by status/i })
			.first()
		await expect(templateLink).toBeVisible()
		await templateLink.click()

		// Verify Report Builder workspace loads
		await expect(page).toHaveURL(
			new RegExp(`/${org.slug}/reports/new\\?template=notes-by-status`),
		)

		await expect(
			page.getByRole('heading', { name: /notes by status/i }),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: /open assistant/i }),
		).toBeVisible()

		// Click "Save Report"
		const saveReportBtn = page.getByRole('button', { name: /save report/i })
		await expect(saveReportBtn).toBeVisible()
		await saveReportBtn.click()

		// Wait for redirect to saved report route: /:slug/reports/:reportId
		await expect(page).toHaveURL(
			new RegExp(`/${org.slug}/reports/[a-zA-Z0-9_-]+$`),
		)

		// Verify report was persisted in database
		const savedReports = await db
			.select({
				id: SavedReport.id,
				title: SavedReport.title,
				organizationId: SavedReport.organizationId,
			})
			.from(SavedReport)
			.where(eq(SavedReport.organizationId, org.id))

		expect(savedReports.length).toBeGreaterThan(0)
		expect(savedReports[0]?.title).toBe('Notes by status')

		// Return to main reports page
		await navigate('/:slug/reports', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify "Notes by status" is now displayed under "Saved reports"
		await expect(page.getByText('Saved reports')).toBeVisible()
		await expect(
			page.getByRole('link', { name: /notes by status/i }).first(),
		).toBeVisible()
	})
})
