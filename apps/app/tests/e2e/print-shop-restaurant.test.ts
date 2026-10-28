import { PRINT_SHOP_FLAG_KEYS } from '@repo/common/print-shop'
import { QR_ORDERING_FLAG_KEYS } from '@repo/common/qr-ordering'
import { expect, test } from '#tests/playwright-utils.ts'
import {
	createDesign,
	designUrl,
	setRole,
	setup,
} from './print-shop-helpers.ts'

/**
 * The restaurant print vertical (docs/print-shop-restaurant.md): table QR
 * cards, table codes behind the menu edit right, and menu dishes.
 */

test.describe('Print shop: restaurant', () => {
	test('table QR cards come first and posters feature dishes', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login)
		await page.goto(`/${org.slug}/marketing/print/new`)
		await page.waitForLoadState('networkidle')
		await expect(page.getByLabel('Name')).toHaveValue('Table QR cards')
		await createDesign(page, org.slug, { product: 'Poster' })
		await expect(page.getByText('Featured dishes')).toBeVisible()
		await expect(
			page.getByText('Your menu has no dishes to feature yet.'),
		).toBeVisible()
	})
})

test.describe('Print shop: table cards', () => {
	test('without QR ordering, table cards cannot point at a table', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login)
		await createDesign(page, org.slug)
		await expect(
			page
				.getByRole('radio', { name: 'Order ahead (menu)' })
				.or(page.getByRole('radio', { name: 'A page on your website' }))
				.first(),
		).toBeVisible()
		await expect(
			page.getByRole('radio', { name: 'Order at the table' }),
		).toHaveCount(0)
		// Table cards never go without a QR code.
		await expect(page.getByRole('radio', { name: 'No QR code' })).toHaveCount(0)
	})

	test('when tables cannot be loaded, a table set says so and keeps its choice', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login, {
			flags: [
				PRINT_SHOP_FLAG_KEYS.enabled,
				QR_ORDERING_FLAG_KEYS.enabled,
				QR_ORDERING_FLAG_KEYS.dineIn,
			],
		})
		await createDesign(page, org.slug)
		await expect(
			page.getByRole('radio', { name: 'Order at the table' }),
		).toBeChecked()
		// No region serves this test organization: an outage, not "no tables".
		await expect(
			page.getByText(
				'Your tables could not be loaded right now. Try again in a minute.',
			),
		).toBeVisible()
		await expect(
			page.getByText('You have no QR tables yet', { exact: false }),
		).toHaveCount(0)
		// Saving other fields keeps "every table" instead of asking for tables.
		await page.getByRole('button', { name: 'Save and update proof' }).click()
		await expect(
			page.getByText('Choose at least one table for the cards.'),
		).toHaveCount(0)
		// The proof says the codes are unavailable (503), not a server error.
		const designId = new URL(page.url()).pathname.split('/').at(-1)!
		const proof = await page.request.get(
			`${designUrl(org.slug, designId)}/proof`,
		)
		expect(proof.status()).toBe(503)
	})

	test('a member cannot see the table codes on a table set', async ({
		page,
		login,
	}) => {
		const { user, org } = await setup(login, {
			flags: [
				PRINT_SHOP_FLAG_KEYS.enabled,
				QR_ORDERING_FLAG_KEYS.enabled,
				QR_ORDERING_FLAG_KEYS.dineIn,
			],
		})
		const designId = await createDesign(page, org.slug)
		await setRole(user.id, org.id, 'member')
		await page.goto(designUrl(org.slug, designId))
		await expect(
			page.getByText(
				"Table cards carry each table's ordering code, so only people who can edit the menu can see the proof and download it.",
			),
		).toBeVisible()
		await expect(page.getByTitle('Print proof')).toHaveCount(0)
		expect(
			(
				await page.request.get(`${designUrl(org.slug, designId)}/proof`)
			).status(),
		).toBe(403)
	})
})
