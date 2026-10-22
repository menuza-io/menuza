import { faker } from '@faker-js/faker'
import { db, eq, Organization } from '@repo/database'
import { expect, saveBar, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

test.describe('Organization Shop Settings & Product Management', () => {
	test('Operators can view shop settings, configure product details, and persist shop changes', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await navigate('/:slug/settings/shop', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify page heading and sections
		await expect(
			page.getByRole('heading', { name: /^settings$/i }),
		).toBeVisible()
		await expect(page.getByText('Site shop')).toBeVisible()
		await expect(
			page.getByRole('button', { name: /connect payout account/i }),
		).toBeVisible()

		// Fill in product details
		const productName = `Merch Package ${faker.string.alphanumeric(6)}`
		const productDescription = `Official merchandise and digital pack ${faker.string.alphanumeric(10)}`
		const priceDollars = '49.99'

		const nameInput = page.getByRole('textbox', { name: /product name/i })
		await expect(nameInput).toBeVisible()
		await nameInput.fill(productName)

		const descInput = page.getByRole('textbox', { name: /description/i })
		await expect(descInput).toBeVisible()
		await descInput.fill(productDescription)

		const priceInput = page.getByLabel(/price \(usd\)/i)
		await expect(priceInput).toBeVisible()
		await priceInput.fill(priceDollars)

		const enableCheckbox = page.getByRole('checkbox', {
			name: /show product on your public site/i,
		})
		await expect(enableCheckbox).toBeVisible()
		if (!(await enableCheckbox.isChecked())) {
			await enableCheckbox.check()
		}

		// Save product configuration and wait for form POST response
		await expect(saveBar(page).save).toBeVisible()

		await Promise.all([
			page.waitForResponse(
				(res) =>
					res.url().includes('/settings/shop') &&
					res.request().method() === 'POST',
			),
			saveBar(page).save.click(),
		])

		// Verify success toast appears
		await expect(page.getByText(/shop updated/i)).toBeVisible()

		// Verify updated values in the inputs
		await expect(nameInput).toHaveValue(productName)
		await expect(descInput).toHaveValue(productDescription)
		await expect(priceInput).toHaveValue(priceDollars)
		await expect(enableCheckbox).toBeChecked()

		// Verify persistence in SQLite database
		const [dbOrg] = await db
			.select({
				shopProductName: Organization.shopProductName,
				shopProductDescription: Organization.shopProductDescription,
				shopProductPriceCents: Organization.shopProductPriceCents,
				shopEnabled: Organization.shopEnabled,
			})
			.from(Organization)
			.where(eq(Organization.id, org.id))
			.limit(1)

		expect(dbOrg).toBeTruthy()
		expect(dbOrg?.shopProductName).toBe(productName)
		expect(dbOrg?.shopProductDescription).toBe(productDescription)
		expect(dbOrg?.shopProductPriceCents).toBe(4999)
		expect(dbOrg?.shopEnabled).toBe(true)
	})
})
