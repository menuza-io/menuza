import { db, eq, Organization, Role, _RoleToUser } from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'

for (const locale of ['en', 'ar'] as const) {
	const labels =
		locale === 'ar'
			? {
					title: 'الاحتفاظ بالرسائل',
					period: 'فترة الاحتفاظ',
					ninetyDays: '90 يومًا',
					thirtyDays: '30 يومًا',
					save: 'حفظ سياسة الاحتفاظ',
					success: 'تم تحديث سياسة الاحتفاظ بالرسائل',
				}
			: {
					title: 'Message retention',
					period: 'Retention period',
					ninetyDays: '90 days',
					thirtyDays: '30 days',
					save: 'Save retention',
					success: 'Message retention updated',
				}

	test(`platform admins explicitly save organization chat retention (${locale})`, async ({
		page,
		login,
		navigate,
	}, testInfo) => {
		test.setTimeout(60_000)
		await page.setExtraHTTPHeaders({ 'Accept-Language': locale })
		const user = await login()
		const adminRole = await db.query.Role.findFirst({
			where: eq(Role.name, 'admin'),
		})
		if (!adminRole) throw new Error('Platform admin role missing')
		await db
			.insert(_RoleToUser)
			.values({ A: adminRole.id, B: user.id })
			.onConflictDoNothing()
		const [organization] = await db
			.insert(Organization)
			.values({
				name: 'Retention test organization',
				slug: `retention-${user.id}`,
				chatRetentionDays: 90,
			})
			.returning()
		if (!organization) throw new Error('Test organization missing')

		try {
			await navigate('/organizations/:id?lng=:locale', {
				id: organization.id,
				locale,
			})
			await page.waitForLoadState('networkidle')
			expect(await page.evaluate(() => document.documentElement.lang)).toBe(
				locale,
			)
			await page.getByRole('link', { name: labels.title }).click()
			await page.waitForLoadState('networkidle')
			await expect(
				page.getByRole('heading', { name: labels.title, exact: true }),
			).toBeVisible()
			const retention = page.getByRole('combobox', { name: labels.period })
			await expect(retention).toHaveText(labels.ninetyDays)
			await retention.click()
			await page
				.getByRole('option', { name: labels.thirtyDays, exact: true })
				.click({ timeout: 10_000 })

			const beforeSave = await db.query.Organization.findFirst({
				where: eq(Organization.id, organization.id),
			})
			expect(beforeSave?.chatRetentionDays).toBe(90)
			await page.getByRole('button', { name: labels.save }).click()
			await expect(page.getByText(labels.success)).toBeVisible()
			const afterSave = await db.query.Organization.findFirst({
				where: eq(Organization.id, organization.id),
			})
			expect(afterSave?.chatRetentionDays).toBe(30)

			await page.screenshot({
				path: testInfo.outputPath('retention-desktop.png'),
				fullPage: true,
			})
			await page.setViewportSize({ width: 390, height: 844 })
			await expect(retention).toBeVisible()
			await page.screenshot({
				path: testInfo.outputPath('retention-mobile.png'),
				fullPage: true,
			})
		} finally {
			await db.delete(Organization).where(eq(Organization.id, organization.id))
		}
	})
}
