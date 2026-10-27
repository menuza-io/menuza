import { type Page } from '@playwright/test'
import { PRINT_SHOP_FLAG_KEYS } from '@repo/common/print-shop'
import { QR_ORDERING_FLAG_KEYS } from '@repo/common/qr-ordering'
import {
	and,
	ConfigFlag,
	db,
	eq,
	inArray,
	Organization,
	PrintDesign,
	PrintOrder,
	PrintVendorProduct,
	UserOrganization,
} from '@repo/database'
import { MockStripeCheckoutPage } from '#tests/playwright-payments-mock.ts'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

type Role = 'admin' | 'member' | 'viewer' | 'guest'

async function setFlags(organizationId: string, keys: string[]) {
	if (keys.length === 0) return
	await db.insert(ConfigFlag).values(
		keys.map((key) => ({
			key,
			value: true,
			level: 'organization' as const,
			organizationId,
		})),
	)
}

async function setRole(userId: string, organizationId: string, role: Role) {
	await db
		.update(UserOrganization)
		.set({ organizationRoleId: `org_role_${role}` })
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organizationId),
			),
		)
}

async function setup(
	login: (options?: any) => Promise<{ id: string }>,
	options: { role?: Role; flags?: string[] } = {},
) {
	const user = await login()
	const org = await createTestOrganization(user.id, options.role ?? 'admin')
	await setFlags(org.id, options.flags ?? [PRINT_SHOP_FLAG_KEYS.enabled])
	return { user, org }
}

const designUrl = (slug: string, id: string) => `/${slug}/marketing/print/${id}`
const downloadUrl = (
	slug: string,
	id: string,
	query = 'format=home&sheet=letter',
) => `${designUrl(slug, id)}/download?${query}`

/** A Base UI `Button` rendered as a link exposes the button role. */
const linkOrButton = (page: Page, name: string | RegExp) =>
	page.getByRole('link', { name }).or(page.getByRole('button', { name }))

async function createDesign(
	page: Page,
	slug: string,
	options: { product?: string; name?: string } = {},
) {
	await page.goto(`/${slug}/marketing/print/new`)
	await expect(
		page.getByRole('heading', { name: 'New print', level: 1 }),
	).toBeVisible()
	// Choices made before hydration are reset by the form state.
	await page.waitForLoadState('networkidle')
	if (options.product) {
		await page
			.getByRole('radio', { name: new RegExp(`^${options.product}`) })
			.click()
	}
	if (options.name) await page.getByLabel('Name').fill(options.name)
	await page.getByRole('button', { name: 'Continue' }).click()
	// `/print/new` matches the editor pattern too: wait for the redirect.
	await page.waitForURL(
		(url) =>
			/\/marketing\/print\/[^/]+$/.test(url.pathname) &&
			!url.pathname.endsWith('/new'),
	)
	return new URL(page.url()).pathname.split('/').at(-1)!
}

async function saveAndApprove(page: Page, headline: string) {
	await page.getByLabel('Headline').first().fill(headline)
	await page.getByRole('button', { name: 'Save and update proof' }).click()
	await expect(
		page.frameLocator('iframe[title="Print proof"]').getByText(headline),
	).toBeVisible()
	await page.getByRole('button', { name: 'Approve proof' }).click()
	await expect(page.getByText('Free PDFs of the approved proof.')).toBeVisible()
}

test.describe('Print shop: access', () => {
	test('every page is hidden while the Print shop is off', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login, { flags: [] })
		for (const path of ['', '/new', '/orders', '/orders/new']) {
			const response = await page.request.get(
				`/${org.slug}/marketing/print${path}`,
			)
			expect(response.status(), path || '/').toBe(404)
		}
		await page.goto(`/${org.slug}/marketing`)
		await expect(
			page.locator(`a[href="/${org.slug}/marketing/print"]`),
		).toHaveCount(0)
	})

	test('the shipping flag alone does not open the Print shop', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login, {
			flags: [PRINT_SHOP_FLAG_KEYS.shipping],
		})
		const response = await page.request.get(`/${org.slug}/marketing/print`)
		expect(response.status()).toBe(404)
	})

	test('a guest without campaign access is refused', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login, { role: 'guest' })
		const response = await page.request.get(`/${org.slug}/marketing/print`)
		expect(response.status()).toBe(403)
	})

	test('a member can look and download but not change prints', async ({
		page,
		login,
	}) => {
		const { user, org } = await setup(login)
		const designId = await createDesign(page, org.slug, {
			product: 'Poster',
			name: 'Lobby poster',
		})
		await saveAndApprove(page, 'Fresh every day')
		await setRole(user.id, org.id, 'member')

		await page.goto(`/${org.slug}/marketing/print`)
		await expect(linkOrButton(page, /Lobby poster/)).toBeVisible()
		await expect(linkOrButton(page, 'New print')).toHaveCount(0)
		expect(
			(await page.request.get(`/${org.slug}/marketing/print/new`)).status(),
		).toBe(403)

		await page.goto(designUrl(org.slug, designId))
		await expect(page.getByLabel('Headline').first()).toBeDisabled()
		for (const name of [
			'Save and update proof',
			'Approve proof',
			'Archive this print',
		]) {
			await expect(page.getByRole('button', { name })).toHaveCount(0)
		}
		// Downloads are free for anyone who can see the print.
		expect(
			(await page.request.get(downloadUrl(org.slug, designId))).status(),
		).toBe(200)

		// A crafted save is refused on the server, not only hidden.
		const post = await page.request.post(designUrl(org.slug, designId), {
			form: { intent: 'archive' },
		})
		expect(post.status()).toBe(403)
		const [row] = await db
			.select({ archivedAt: PrintDesign.archivedAt })
			.from(PrintDesign)
			.where(eq(PrintDesign.id, designId))
		expect(row?.archivedAt).toBeNull()
	})

	test("another organization's prints cannot be opened", async ({
		page,
		login,
	}) => {
		const { user, org } = await setup(login)
		const other = await createTestOrganization(user.id, 'admin')
		await setFlags(other.id, [PRINT_SHOP_FLAG_KEYS.enabled])
		const designId = await createDesign(page, org.slug, {
			product: 'Flyer',
			name: 'Private flyer',
		})
		await saveAndApprove(page, 'Only ours')

		for (const path of [
			designUrl(other.slug, designId),
			`${designUrl(other.slug, designId)}/proof`,
			downloadUrl(other.slug, designId),
		]) {
			expect((await page.request.get(path)).status(), path).toBe(404)
		}
		const post = await page.request.post(designUrl(other.slug, designId), {
			form: { intent: 'archive' },
		})
		expect(post.status()).toBe(404)
		await page.goto(`/${other.slug}/marketing/print`)
		await expect(page.getByText('No prints yet')).toBeVisible()
	})
})

test.describe('Print shop: designing', () => {
	test('the new print form follows the product until a name is typed', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login)
		await page.goto(`/${org.slug}/marketing/print`)
		await expect(page.getByText('No prints yet')).toBeVisible()
		// Shipping is off: no orders and no "Can ship" badges.
		await expect(linkOrButton(page, 'Print orders')).toHaveCount(0)
		await linkOrButton(page, 'Create a print').click()

		const name = page.getByLabel('Name')
		await expect(name).toHaveValue('Table QR cards')
		await expect(page.getByText('Can ship')).toHaveCount(0)

		await page.getByRole('radio', { name: /^Flyer/ }).click()
		await expect(name).toHaveValue('Flyer')
		for (const size of [
			'A5 · 148 × 210 mm',
			'A4 · 210 × 297 mm',
			'US Letter',
		]) {
			await expect(page.getByRole('radio', { name: size })).toBeVisible()
		}
		// The first size of the new product is chosen.
		await expect(
			page.getByRole('radio', { name: 'A5 · 148 × 210 mm' }),
		).toBeChecked()

		await name.fill('Brunch flyer')
		await page.getByRole('radio', { name: /^Poster/ }).click()
		await expect(name).toHaveValue('Brunch flyer')
		await expect(
			page.getByRole('radio', { name: 'A3 · 297 × 420 mm' }),
		).toBeChecked()

		await name.fill('')
		await page.getByRole('button', { name: 'Continue' }).click()
		await expect(page).toHaveURL(
			new RegExp(`/${org.slug}/marketing/print/new$`),
		)
		await expect(name).toHaveAttribute('aria-invalid', 'true')

		await linkOrButton(page, 'Cancel').click()
		await expect(page).toHaveURL(new RegExp(`/${org.slug}/marketing/print$`))
	})

	test('a poster is saved, approved and downloaded', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login)
		const designId = await createDesign(page, org.slug, {
			product: 'Poster',
			name: 'Window poster',
		})
		await expect(page.getByText('Draft', { exact: true })).toBeVisible()
		await expect(
			page.getByText('Approve the proof to download it.'),
		).toBeVisible()
		await expect(
			page.getByText('Your menu has no dishes to feature yet.'),
		).toBeVisible()
		// Not approved yet: the file is refused.
		expect(
			(await page.request.get(downloadUrl(org.slug, designId))).status(),
		).toBe(409)

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
		await expect(
			page.getByRole('button', { name: 'Approve proof' }),
		).toBeEnabled()

		await page.getByRole('button', { name: 'Approve proof' }).click()
		await expect(page.getByText('Approved', { exact: true })).toBeVisible()
		const [approved] = await db
			.select({ approvedAt: PrintDesign.approvedAt })
			.from(PrintDesign)
			.where(eq(PrintDesign.id, designId))
		expect(approved?.approvedAt).toBeTruthy()

		// Without Browser Rendering keys every format is a print-ready page.
		for (const query of [
			'format=home&sheet=letter',
			'format=home&sheet=a4',
			'format=pro',
		]) {
			const file = await page.request.get(
				downloadUrl(org.slug, designId, query),
			)
			expect(file.status(), query).toBe(200)
			const type = file.headers()['content-type'] ?? ''
			expect(type).toMatch(/text\/html|application\/pdf/)
			if (type.includes('text/html')) {
				expect(await file.text()).toContain('Order from your table')
			}
		}
		expect(
			(
				await page.request.get(downloadUrl(org.slug, designId, 'format=poster'))
			).status(),
		).toBe(400)

		// The proof frame is locked down: no scripts, framed by the App only.
		const proofResponse = await page.request.get(
			`${designUrl(org.slug, designId)}/proof`,
		)
		expect(proofResponse.headers()['cache-control']).toContain('no-store')
		expect(proofResponse.headers()['content-security-policy']).toBeTruthy()
		expect(proofResponse.headers()['x-content-type-options']).toContain(
			'nosniff',
		)

		await page.goto(`/${org.slug}/marketing/print`)
		await expect(linkOrButton(page, /Window poster/)).toBeVisible()
		await expect(page.getByText('Approved', { exact: true })).toBeVisible()
	})

	test('an edit after approval goes back to draft until approved again', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login)
		const designId = await createDesign(page, org.slug, { product: 'Flyer' })
		await saveAndApprove(page, 'First version')
		expect(
			(await page.request.get(downloadUrl(org.slug, designId))).status(),
		).toBe(200)

		await page.getByLabel('Headline').first().fill('Second version')
		await page.getByRole('button', { name: 'Save and update proof' }).click()
		await expect(page.getByText('Draft', { exact: true })).toBeVisible()
		await expect(
			page.getByText('Approve the proof to download it.'),
		).toBeVisible()
		expect(
			(await page.request.get(downloadUrl(org.slug, designId))).status(),
		).toBe(409)

		await page.getByRole('button', { name: 'Approve proof' }).click()
		await expect(page.getByText('Approved', { exact: true })).toBeVisible()
		const file = await page.request.get(downloadUrl(org.slug, designId))
		const text = await file.text()
		if ((file.headers()['content-type'] ?? '').includes('text/html')) {
			expect(text).toContain('Second version')
			expect(text).not.toContain('First version')
		}
	})

	test('QR links stay on the organization’s own site', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login)
		await createDesign(page, org.slug, { product: 'Poster' })
		await page.getByRole('radio', { name: 'A page on your website' }).click()
		const path = page.getByLabel('Page', { exact: true })
		const save = page.getByRole('button', { name: 'Save and update proof' })
		const refused = page.getByText(
			'Check the QR code: use a page on your own website, like /contact.',
		)

		for (const value of [
			'https://evil.example/menu',
			'//evil.example/menu',
			'javascript:alert(1)',
			'/menu<script>',
		]) {
			await path.fill(value)
			await save.click()
			await expect(refused, value).toBeVisible()
		}

		await path.fill('/menu?utm_source=poster')
		await save.click()
		await expect(refused).toHaveCount(0)
		await expect(path).toHaveValue('/menu?utm_source=poster')

		// Posters can also go without a QR code.
		await page.getByRole('radio', { name: 'No QR code' }).click()
		await expect(page.getByLabel('Page', { exact: true })).toHaveCount(0)
		await save.click()
		await expect(page.getByRole('radio', { name: 'No QR code' })).toBeChecked()
	})

	test('a bilingual print shows both languages, right to left where needed', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login)
		await db
			.update(Organization)
			.set({
				siteLocales: JSON.stringify(['en', 'ar']),
				siteDefaultLocale: 'en',
			})
			.where(eq(Organization.id, org.id))
		await createDesign(page, org.slug, { product: 'Poster' })

		const second = page.getByLabel('Second language')
		await expect(second).toHaveValue('')
		await expect(page.getByRole('group', { name: 'العربية' })).toHaveCount(0)
		await second.selectOption('ar')
		const arabic = page
			.getByRole('group', { name: 'العربية' })
			.getByLabel('Headline')
		await expect(arabic).toHaveAttribute('dir', 'rtl')
		await page
			.getByRole('group', { name: 'English' })
			.getByLabel('Headline')
			.fill('Scan to order')
		await arabic.fill('امسح للطلب')
		await page.getByRole('button', { name: 'Save and update proof' }).click()
		const proof = page.frameLocator('iframe[title="Print proof"]')
		await expect(proof.getByText('Scan to order')).toBeVisible()
		await expect(proof.getByText('امسح للطلب')).toBeVisible()

		// The main language cannot also be the second one.
		await page.getByLabel('Main language').selectOption('ar')
		await expect(second.getByRole('option', { name: 'العربية' })).toHaveCount(0)
	})

	test('archiving asks first and then removes the print', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login)
		const designId = await createDesign(page, org.slug, {
			product: 'Flyer',
			name: 'Old flyer',
		})
		await page.getByRole('button', { name: 'Archive this print' }).click()
		const dialog = page.getByRole('alertdialog')
		await expect(
			dialog.getByText(
				'It leaves the Print shop list. Orders already placed keep printing it.',
			),
		).toBeVisible()
		await dialog.getByRole('button', { name: 'Keep it' }).click()
		await expect(dialog).toBeHidden()
		await expect(page).toHaveURL(new RegExp(`${designId}$`))

		await page.getByRole('button', { name: 'Archive this print' }).click()
		await page
			.getByRole('alertdialog')
			.getByRole('button', { name: 'Archive', exact: true })
			.click()
		await expect(page).toHaveURL(new RegExp(`/${org.slug}/marketing/print$`))
		await expect(page.getByText('No prints yet')).toBeVisible()
		for (const path of [
			designUrl(org.slug, designId),
			`${designUrl(org.slug, designId)}/proof`,
			downloadUrl(org.slug, designId),
		]) {
			expect((await page.request.get(path)).status(), path).toBe(404)
		}
	})

	test('an unknown print is not found', async ({ page, login }) => {
		const { org } = await setup(login)
		const response = await page.goto(designUrl(org.slug, 'no-such-print'))
		expect(response?.status()).toBe(404)
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

	test('with no tables yet, a table set cannot be saved or approved', async ({
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
		await expect(
			page.getByText(
				'Add tables in QR ordering first. Each table gets its own card.',
			),
		).toBeVisible()
		await page.getByRole('button', { name: 'Save and update proof' }).click()
		await expect(
			page.getByText('Choose at least one table for the cards.'),
		).toBeVisible()
		// No region serves this test organization: the proof says the codes
		// are unavailable (503) instead of failing with a server error.
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

test.describe('Print shop: shipped orders', () => {
	// Shipped prints need an active vendor product per size; the emulator
	// (`PRINT_MOCK`, set by playwright.config.ts) stands in for the vendor.
	const created: string[] = []
	test.beforeAll(async () => {
		for (const [product, sizeKey] of [
			['poster', 'a3'],
			['flyer', 'a5'],
		] as const) {
			const [existing] = await db
				.select({ id: PrintVendorProduct.id })
				.from(PrintVendorProduct)
				.where(
					and(
						eq(PrintVendorProduct.product, product),
						eq(PrintVendorProduct.sizeKey, sizeKey),
						eq(PrintVendorProduct.active, true),
					),
				)
			if (existing) continue
			const [row] = await db
				.insert(PrintVendorProduct)
				.values({
					product,
					sizeKey,
					vendor: 'gelato',
					vendorSku: `e2e-${product}-${sizeKey}`,
				})
				.returning({ id: PrintVendorProduct.id })
			created.push(row!.id)
		}
	})
	test.afterAll(async () => {
		if (created.length > 0) {
			await db
				.delete(PrintVendorProduct)
				.where(inArray(PrintVendorProduct.id, created))
		}
	})

	const SHIPPING = [PRINT_SHOP_FLAG_KEYS.enabled, PRINT_SHOP_FLAG_KEYS.shipping]

	async function fillAddress(page: Page) {
		await page.getByLabel('Recipient').fill('Front desk')
		await page.getByLabel('Phone for the carrier').fill('+1 555 010 0100')
		await page.getByLabel('Street address').fill('1 Main Street')
		await page.getByLabel('City').fill('Austin')
		await page.getByLabel('State').selectOption('TX')
		await page.getByLabel('ZIP code').fill('78701')
	}

	/** Prices the one approved print of the organization. */
	async function quote(page: Page, slug: string, copies = '2') {
		await page.goto(`/${slug}/marketing/print/orders/new`)
		// Typing before hydration is reset by the prefilled address.
		await page.waitForLoadState('networkidle')
		await page.getByRole('spinbutton').fill(copies)
		await fillAddress(page)
		await page.getByRole('button', { name: 'See the price' }).click()
		await page.waitForURL(
			(url) =>
				/\/marketing\/print\/orders\/[^/]+$/.test(url.pathname) &&
				!url.pathname.endsWith('/new'),
		)
		await page.waitForLoadState('networkidle')
		return new URL(page.url()).pathname.split('/').at(-1)!
	}

	test('shipping shows where it applies and only for approved prints', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login, { flags: SHIPPING })
		await page.goto(`/${org.slug}/marketing/print`)
		await expect(linkOrButton(page, 'Print orders')).toBeVisible()

		await page.goto(`/${org.slug}/marketing/print/new`)
		// Table cards, posters and flyers ship; tents and stickers are PDF only.
		await expect(page.getByText('Can ship')).toHaveCount(3)

		await page.goto(`/${org.slug}/marketing/print/orders`)
		await expect(page.getByText('No print orders yet')).toBeVisible()
		await page.goto(`/${org.slug}/marketing/print/orders/new`)
		await expect(page.getByText('Nothing to ship yet')).toBeVisible()

		await createDesign(page, org.slug, { product: 'Poster' })
		await expect(
			page.getByText('Approve the proof to order prints.'),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Order prints' }),
		).toBeDisabled()
		await saveAndApprove(page, 'Ship me')
		await expect(
			page.getByText('We print and ship it to your door.'),
		).toBeVisible()
		await linkOrButton(page, 'Order prints').click()
		await expect(page).toHaveURL(
			new RegExp(`/${org.slug}/marketing/print/orders/new$`),
		)
		await expect(page.getByRole('spinbutton')).toHaveValue('0')

		// PDF-only products never offer an order.
		await createDesign(page, org.slug, { product: 'Window sticker' })
		await expect(page.getByText('Have it printed')).toHaveCount(0)
	})

	test('the order form refuses an empty order and a bad address', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login, { flags: SHIPPING })
		await createDesign(page, org.slug, { product: 'Flyer' })
		await saveAndApprove(page, 'Weekend brunch')
		await page.goto(`/${org.slug}/marketing/print/orders/new`)
		await page.waitForLoadState('networkidle')
		// The recipient starts as the organization name.
		await expect(page.getByLabel('Recipient')).toHaveValue(org.name)

		await fillAddress(page)
		await page.getByRole('button', { name: 'See the price' }).click()
		await expect(
			page.getByText('Choose at least one print and how many copies.'),
		).toBeVisible()

		// Copies are counted on the server too, not only by the input.
		const copies = page.getByRole('spinbutton')
		await copies.fill('501')
		await page.getByRole('button', { name: 'See the price' }).click()
		await expect(page.getByText('Order at most 500 copies')).toBeVisible()
		await expect(copies).toHaveAttribute('aria-invalid', 'true')
		await copies.fill('1.5')
		await page.getByRole('button', { name: 'See the price' }).click()
		await expect(page.getByText('Enter a whole number of copies')).toBeVisible()

		await copies.fill('1')
		await page.getByLabel('Street address').fill('')
		await page.getByLabel('ZIP code').fill('7870')
		await page.getByLabel('Phone for the carrier').fill('call me')
		await page.getByLabel('State').selectOption('')
		await page.getByRole('button', { name: 'See the price' }).click()
		await expect(page.getByText('Enter a 5-digit ZIP code')).toBeVisible()
		await expect(page.getByText('Enter a street address')).toBeVisible()
		await expect(
			page.getByText('Enter a phone number for the carrier'),
		).toBeVisible()
		await expect(page.getByText('Choose a state')).toBeVisible()
		await expect(page).toHaveURL(
			new RegExp(`/${org.slug}/marketing/print/orders/new$`),
		)
		const orders = await db
			.select({ id: PrintOrder.id })
			.from(PrintOrder)
			.where(eq(PrintOrder.organizationId, org.id))
		expect(orders).toHaveLength(0)
	})

	test('a member can see orders but not place or pay them', async ({
		page,
		login,
	}) => {
		const { user, org } = await setup(login, { flags: SHIPPING })
		const designId = await createDesign(page, org.slug, { product: 'Poster' })
		await saveAndApprove(page, 'Members look only')
		const orderId = await quote(page, org.slug)
		await setRole(user.id, org.id, 'member')

		expect(
			(
				await page.request.get(`/${org.slug}/marketing/print/orders/new`)
			).status(),
		).toBe(403)
		await page.goto(designUrl(org.slug, designId))
		await expect(page.getByText('Have it printed')).toHaveCount(0)

		await page.goto(`/${org.slug}/marketing/print/orders/${orderId}`)
		await expect(
			page.getByRole('button', { name: 'Pay securely' }),
		).toHaveCount(0)
		const pay = await page.request.post(
			`/${org.slug}/marketing/print/orders/${orderId}`,
			{ form: { intent: 'pay' }, maxRedirects: 0 },
		)
		expect(pay.status()).toBe(403)
	})

	test('a quote can be cancelled before paying, and expires', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login, { flags: SHIPPING })
		await createDesign(page, org.slug, { product: 'Poster' })
		await saveAndApprove(page, 'Quote only')

		const first = await quote(page, org.slug)
		await expect(page.getByText('Price ready').first()).toBeVisible()
		await expect(page.getByText(/This price is held until/)).toBeVisible()
		await expect(page.getByText('Added at payment')).toBeVisible()
		await page.getByRole('button', { name: 'Cancel order' }).click()
		const dialog = page.getByRole('alertdialog')
		await expect(
			dialog.getByText('Nothing has been charged yet.'),
		).toBeVisible()
		await dialog.getByRole('button', { name: 'Keep the order' }).click()
		await expect(dialog).toBeHidden()
		await page.getByRole('button', { name: 'Cancel order' }).click()
		await page
			.getByRole('alertdialog')
			.getByRole('button', { name: 'Cancel order' })
			.click()
		await expect(page.getByText('This order was cancelled')).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Pay securely' }),
		).toHaveCount(0)

		// A held price runs out: paying is refused until a new price.
		const second = await quote(page, org.slug)
		expect(second).not.toBe(first)
		await db
			.update(PrintOrder)
			.set({ quoteExpiresAt: new Date(Date.now() - 60_000) })
			.where(eq(PrintOrder.id, second))
		await page.reload()
		await expect(page.getByText('This price has expired.')).toBeVisible()
		await expect(linkOrButton(page, 'Get a new price')).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Pay securely' }),
		).toHaveCount(0)
		const pay = await page.request.post(
			`/${org.slug}/marketing/print/orders/${second}`,
			{ form: { intent: 'pay' }, maxRedirects: 0 },
		)
		expect(pay.status()).toBe(200)
		expect(await pay.text()).toContain('quote_expired')
	})

	test('paying sends the order to the printer, and it can still be cancelled', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login, { flags: SHIPPING })
		await createDesign(page, org.slug, {
			product: 'Poster',
			name: 'Paid poster',
		})
		await saveAndApprove(page, 'Paid for')
		const orderId = await quote(page, org.slug, '3')
		await expect(page.getByText('Paid poster')).toBeVisible()
		await expect(page.getByText('3 printed')).toBeVisible()

		// Back from the payment page: nothing charged, still payable.
		await page.getByRole('button', { name: 'Pay securely' }).click()
		const checkout = new MockStripeCheckoutPage(page)
		await expect(page.getByTestId('mock-banner')).toBeVisible()
		await checkout.back()
		await expect(page).toHaveURL(/cancelled=1/)
		await expect(page.getByText('Payment not finished')).toBeVisible()
		// Server-rendered text shows before hydration; clicks wait for it.
		await page.waitForLoadState('networkidle')

		await page.getByRole('button', { name: 'Pay securely' }).click()
		await expect(page.getByTestId('mock-banner')).toBeVisible()
		await checkout.pay('4242 4242 4242 4242')
		await expect(page).toHaveURL(
			new RegExp(`/marketing/print/orders/${orderId}\\?paid=1`),
		)
		// The mock delivers the webhook before the redirect.
		await expect
			.poll(
				async () =>
					(
						await db
							.select({ status: PrintOrder.status })
							.from(PrintOrder)
							.where(eq(PrintOrder.id, orderId))
					)[0]?.status,
			)
			.toMatch(/^(paid|submitting|submitted)$/)
		await page.reload()
		await expect(
			page.getByRole('button', { name: 'Pay securely' }),
		).toHaveCount(0)

		// Paying twice is refused.
		const again = await page.request.post(
			`/${org.slug}/marketing/print/orders/${orderId}`,
			{ form: { intent: 'pay' }, maxRedirects: 0 },
		)
		expect(await again.text()).toMatch(/not_payable|payment_processing/)

		await page.goto(`/${org.slug}/marketing/print/orders`)
		await expect(linkOrButton(page, /Order of/).first()).toBeVisible()

		// Before production starts the order can be cancelled for a refund.
		await page.goto(`/${org.slug}/marketing/print/orders/${orderId}`)
		await page.waitForLoadState('networkidle')
		await page.getByRole('button', { name: 'Cancel order' }).click()
		await expect(
			page
				.getByRole('alertdialog')
				.getByText('You get a full refund to the card you paid with.'),
		).toBeVisible()
		await page
			.getByRole('alertdialog')
			.getByRole('button', { name: 'Cancel order' })
			.click()
		await expect(page.getByText('This order was refunded')).toBeVisible()
	})
})
