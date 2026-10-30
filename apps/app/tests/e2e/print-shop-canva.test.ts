import { type Page } from '@playwright/test'
import { PRINT_SHOP_FLAG_KEYS } from '@repo/common/print-shop'
import { db, eq, PrintCanvaConnection, PrintDesign } from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'
import {
	createDesign,
	designUrl,
	downloadUrl,
	linkOrButton,
	setRole,
	setup,
} from './print-shop-helpers.ts'

/**
 * Import from Canva against the local emulator (`CANVA_MOCK`, set by the
 * Playwright web server): three designs, an A3 poster with bleed, a two-page
 * A5 flyer without bleed and a square post that fits no print.
 */

const CANVA_FLAGS = [PRINT_SHOP_FLAG_KEYS.enabled, PRINT_SHOP_FLAG_KEYS.canva]

const canvaUrl = (slug: string) => `/${slug}/marketing/print/canva`

async function connectCanva(page: Page, slug: string) {
	await page.goto(canvaUrl(slug))
	await linkOrButton(page, /^Connect Canva$/).click()
	await expect(page.getByText('Canva is connected')).toBeVisible()
}

test.describe('Print shop: Canva', () => {
	test('stays hidden without the Canva flag', async ({ page, login }) => {
		const { org } = await setup(login)
		await page.goto(`/${org.slug}/marketing/print`)
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
		await expect(linkOrButton(page, 'Import from Canva')).toHaveCount(0)
		for (const path of ['', '/connect']) {
			expect(
				(await page.request.get(`${canvaUrl(org.slug)}${path}`)).status(),
			).toBe(404)
		}
	})

	test('a member who cannot change prints cannot use Canva', async ({
		page,
		login,
	}) => {
		const { user, org } = await setup(login, { flags: CANVA_FLAGS })
		await setRole(user.id, org.id, 'member')
		for (const path of ['', '/connect']) {
			expect(
				(await page.request.get(`${canvaUrl(org.slug)}${path}`)).status(),
			).toBe(403)
		}
		expect(
			(await page.request.post(`${canvaUrl(org.slug)}/connect`)).status(),
		).toBe(403)
		await page.goto(`/${org.slug}/marketing/print`)
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
		await expect(linkOrButton(page, 'Import from Canva')).toHaveCount(0)
	})

	test('connects, imports a poster and downloads its PDF', async ({
		page,
		login,
	}) => {
		const { user, org } = await setup(login, { flags: CANVA_FLAGS })
		await page.goto(`/${org.slug}/marketing/print`)
		await linkOrButton(page, 'Import from Canva').click()
		// A plain visit (a link from anywhere) does not start connecting.
		await page.goto(`${canvaUrl(org.slug)}/connect`)
		await expect(page).toHaveURL(new RegExp(`${canvaUrl(org.slug)}$`))
		await expect(page.getByText('Connect your Canva account')).toBeVisible()
		await linkOrButton(page, /^Connect Canva$/).click()
		await expect(page.getByText('Canva is connected')).toBeVisible()
		await expect(
			page.getByText('Connected to Canva as Mock Canva user.'),
		).toBeVisible()
		await page.waitForLoadState('networkidle')

		// A square post is not an A3 page: refused, nothing is made.
		await page.getByRole('radio', { name: /Social post/ }).click()
		await page.getByRole('radio', { name: 'Poster', exact: true }).click()
		await page.getByRole('radio', { name: /^A3/ }).click()
		await page.getByRole('button', { name: 'Import design' }).click()
		await expect(page.getByText('The design was not imported')).toBeVisible()
		await expect(
			page.getByText("The design's page is not the size of the print."),
		).toBeVisible()

		await page.getByRole('radio', { name: /Spring poster/ }).click()
		await expect(page.getByLabel('Name')).toHaveValue('Spring poster')
		await page.getByRole('button', { name: 'Import design' }).click()
		await page.waitForURL(
			(url) =>
				/\/marketing\/print\/[^/]+$/.test(url.pathname) &&
				!url.pathname.endsWith('/canva'),
		)
		const designId = new URL(page.url()).pathname.split('/').at(-1)!
		await expect(page.getByText('3 mm bleed')).toBeVisible()
		await expect(
			page.getByText('This print is a finished design', { exact: false }),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Send to Canva' }),
		).toHaveCount(0)

		expect(
			(
				await page.request.get(downloadUrl(org.slug, designId, 'format=pro'))
			).status(),
		).toBe(409)
		await page.getByRole('button', { name: 'Approve proof' }).click()
		await expect(
			page.getByText('Free PDFs of the approved proof.'),
		).toBeVisible()
		const file = await page.request.get(
			downloadUrl(org.slug, designId, 'format=pro'),
		)
		expect(file.status()).toBe(200)
		expect(file.headers()['content-type']).toContain('application/pdf')
		expect((await file.body()).subarray(0, 5).toString()).toBe('%PDF-')

		// Updating from Canva takes the print back to draft.
		await page.getByRole('button', { name: 'Update from Canva' }).click()
		await expect(page.getByText('Updated from Canva')).toBeVisible()
		const [row] = await db
			.select({ status: PrintDesign.status, source: PrintDesign.source })
			.from(PrintDesign)
			.where(eq(PrintDesign.id, designId))
		expect(row).toEqual({ status: 'draft', source: 'artwork' })

		// Edit in Canva goes to the design's own edit link.
		const edit = await page.request.post(designUrl(org.slug, designId), {
			form: { intent: 'canva-edit' },
			maxRedirects: 0,
		})
		expect(edit.status()).toBe(302)
		expect(edit.headers().location).toBe(
			'https://www.canva.com/design/MOCK-POSTER/edit',
		)

		await page.goto(`/${org.slug}/marketing/print`)
		await expect(page.getByText(/· From Canva$/)).toBeVisible()

		// Disconnecting forgets the tokens.
		await page.goto(canvaUrl(org.slug))
		await page.getByRole('button', { name: 'Disconnect Canva' }).click()
		await expect(linkOrButton(page, /^Connect Canva$/)).toBeVisible()
		const connections = await db
			.select({ id: PrintCanvaConnection.id })
			.from(PrintCanvaConnection)
			.where(eq(PrintCanvaConnection.userId, user.id))
		expect(connections).toHaveLength(0)
	})

	test('notes the extra pages and the missing bleed of a flyer', async ({
		page,
		login,
	}) => {
		const { org } = await setup(login, { flags: CANVA_FLAGS })
		await connectCanva(page, org.slug)
		await page.waitForLoadState('networkidle')
		await expect(
			page.getByText('2 pages: only the first one prints.'),
		).toBeVisible()
		await page.getByRole('radio', { name: /Weekend flyer/ }).click()
		await page.getByRole('radio', { name: 'Flyer', exact: true }).click()
		await page.getByRole('radio', { name: /^A5/ }).click()
		await page.getByRole('button', { name: 'Import design' }).click()
		await expect(page.getByText('No bleed')).toBeVisible()
		await expect(
			page.getByText('The design has more pages: only the first one prints.'),
		).toBeVisible()
	})

	test('sends a template print to Canva', async ({ page, login }) => {
		const { org } = await setup(login, { flags: CANVA_FLAGS })
		await connectCanva(page, org.slug)
		const designId = await createDesign(page, org.slug, {
			product: 'Poster',
			name: 'Hours poster',
		})
		await expect(
			page.getByRole('button', { name: 'Send to Canva' }),
		).toBeVisible()
		const send = await page.request.post(designUrl(org.slug, designId), {
			form: { intent: 'canva-send' },
			maxRedirects: 0,
		})
		expect(send.status()).toBe(302)
		expect(send.headers().location).toMatch(
			/^https:\/\/www\.canva\.com\/design\/MOCK-IMPORT-\d+\/edit$/,
		)
	})
})
