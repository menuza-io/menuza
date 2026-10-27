import { PRINT_SHOP_FLAG_KEYS } from '@repo/common/print-shop'
import { ConfigFlag, db, eq, PrintDesign } from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

async function enablePrintShop(organizationId: string) {
	await db.insert(ConfigFlag).values({
		key: PRINT_SHOP_FLAG_KEYS.enabled,
		value: true,
		level: 'organization',
		organizationId,
	})
}

test.describe('Print shop', () => {
	test('stays hidden until the Print shop is on for the organization', async ({
		page,
		login,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		const response = await page.goto(`/${org.slug}/marketing/print`)
		expect(response?.status()).toBe(404)
	})

	test('operators design a poster, approve the proof and download it', async ({
		page,
		login,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		await enablePrintShop(org.id)

		await page.goto(`/${org.slug}/marketing/print`)
		await expect(
			page.getByRole('heading', { name: 'Print shop', level: 1 }),
		).toBeVisible()
		await expect(page.getByText('No prints yet')).toBeVisible()
		// Shipping is off: no paid orders are offered.
		await expect(
			page.getByRole('button', { name: 'Print orders' }),
		).toHaveCount(0)

		await page.getByRole('button', { name: 'New print' }).click()
		await expect(
			page.getByRole('heading', { name: 'New print', level: 1 }),
		).toBeVisible()
		await page.getByRole('radio', { name: /^Poster/ }).click()
		// The name follows the product until the operator types one.
		await expect(page.getByLabel('Name')).toHaveValue('Poster')
		await page.getByLabel('Name').fill('Window poster')
		await page.getByRole('button', { name: 'Continue' }).click()

		// `/print/new` matches the editor pattern too: wait for the redirect.
		await page.waitForURL(
			(url) =>
				/\/marketing\/print\/[^/]+$/.test(url.pathname) &&
				!url.pathname.endsWith('/new'),
		)
		const designId = new URL(page.url()).pathname.split('/').at(-1)!
		await expect(page.getByText('Draft', { exact: true })).toBeVisible()
		for (const name of [
			'Print at home (US Letter)',
			'Print at home (A4)',
			'For a print shop (with bleed)',
		]) {
			await expect(page.getByText(name)).toBeVisible()
		}
		// Not approved yet: the file is refused.
		const early = await page.request.get(
			`/${org.slug}/marketing/print/${designId}/download?format=home&sheet=letter`,
		)
		expect(early.status()).toBe(409)

		await page.getByLabel('Headline').first().fill('Order from your table')
		await expect(
			page.getByText(
				'Save first, so the proof shows your changes before you approve it.',
			),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Approve proof' }),
		).toBeDisabled()
		await page.getByRole('button', { name: 'Save and update proof' }).click()

		const proof = page.frameLocator('iframe[title="Print proof"]')
		await expect(proof.getByText('Order from your table')).toBeVisible()

		await page.getByRole('button', { name: 'Approve proof' }).click()
		await expect(page.getByText('Approved', { exact: true })).toBeVisible()
		await expect(
			page.getByText('Free PDFs of the approved proof.'),
		).toBeVisible()

		const [design] = await db
			.select({ approvedAt: PrintDesign.approvedAt })
			.from(PrintDesign)
			.where(eq(PrintDesign.id, designId))
		expect(design?.approvedAt).toBeTruthy()

		// Without Browser Rendering keys the download is a print-ready page.
		const file = await page.request.get(
			`/${org.slug}/marketing/print/${designId}/download?format=home&sheet=letter`,
		)
		expect(file.status()).toBe(200)
		const type = file.headers()['content-type'] ?? ''
		expect(type).toMatch(/text\/html|application\/pdf/)
		if (type.includes('text/html')) {
			expect(await file.text()).toContain('Order from your table')
		}

		await page.goto(`/${org.slug}/marketing/print`)
		await expect(
			page
				.getByRole('link', { name: /Window poster/ })
				.or(page.getByRole('button', { name: /Window poster/ })),
		).toBeVisible()
	})
})
