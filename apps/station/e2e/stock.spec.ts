import fs from 'node:fs'
import path from 'node:path'
import {
	type BrowserContext,
	type Page,
	type Request,
	type Route,
} from '@playwright/test'
import {
	API,
	APP,
	expect,
	goOffline,
	goOnline,
	seedSettings,
	selectStationApp,
	signInWithPin,
	test,
} from './helpers.ts'

/**
 * The Stock app (counts, waste, deliveries) on a paired tablet.
 *
 * Until the region serves `/pos/inventory/*` (a later phase of the inventory
 * plan), these tests stand a recording region in front of the page with
 * `context.route`: the terminal's `/pos/me` and `/pos/sign-in`, and every
 * `/pos/inventory/*` call, answered from the recorded fixtures in
 * `src/apps/stock/fixtures` (the same ones the contract tests read). Everything
 * else (the menu) still comes from the backend harness. When the region
 * route exists, swap `stockRegion` for the real harness and keep the
 * assertions.
 *
 * `CAPTURE_DIR=<dir>` also saves a screenshot of each screen, for design review.
 */

const FIXTURES = path.join(import.meta.dirname, '../src/apps/stock/fixtures')
const fixture = (name: string) =>
	JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))
const catalog = fixture('catalog.json')
const countSheet = fixture('count-sheet.json')
const openCount = catalog.counts[0]

const CAPTURE_DIR = process.env.CAPTURE_DIR
async function capture(page: Page, name: string) {
	if (!CAPTURE_DIR) return
	fs.mkdirSync(CAPTURE_DIR, { recursive: true })
	await page.waitForTimeout(700)
	await page.screenshot({ path: path.join(CAPTURE_DIR, `stock-${name}.png`) })
}

type Seen = {
	method: string
	path: string
	headers: Record<string, string>
	body: any
}

/**
 * A recording regional node for Stock. `role` is who the PIN signs in as
 * (a manager may receive a delivery at a location that asks for one).
 */
async function stockRegion(
	context: BrowserContext,
	options: {
		role?: 'cashier' | 'manager'
		receiveRequiresManager?: boolean
	} = {},
) {
	const role = options.role ?? 'cashier'
	const seen: Seen[] = []
	let serial = 0
	const cors = {
		'access-control-allow-origin': '*',
		'access-control-allow-headers': '*',
		'access-control-allow-methods': '*',
		'access-control-expose-headers': 'etag, date',
	}
	const json = (route: Route, body: unknown, status = 200) =>
		route.fulfill({
			status,
			contentType: 'application/json',
			headers: cors,
			body: JSON.stringify(body),
		})
	await context.route(`${API}/pos/**`, async (route, request: Request) => {
		const url = new URL(request.url())
		if (request.method() === 'OPTIONS')
			return route.fulfill({ status: 204, headers: cors })
		const p = url.pathname
		if (p === '/pos/me')
			return json(route, {
				device: {
					signInRequired: true,
					scopeId: 'main',
					label: 'Kitchen tablet',
					terminalCode: 'T1',
					dayStartMinutes: 240,
					shiftsRequired: false,
				},
				apps: { timeclock: false, reservations: false, inventory: true },
				transfers: [],
				fiscalChains: [],
				zatca: null,
			})
		if (p === '/pos/sign-in')
			return json(route, {
				staff: { id: 'stf_ana', name: 'Ana K.' },
				role,
				sessionToken: 'e2e-session-token-aaaaaaaaaaaa',
				sessionExpiresAt: Date.now() + 3_600_000,
			})
		if (!p.startsWith('/pos/inventory/')) return route.fallback()
		const body = request.postData() ? JSON.parse(request.postData()!) : null
		seen.push({
			method: request.method(),
			path: p,
			headers: request.headers(),
			body,
		})
		if (p === '/pos/inventory/catalog')
			return json(route, {
				...catalog,
				settings: {
					...catalog.settings,
					receiveRequiresManager: options.receiveRequiresManager ?? true,
				},
			})
		if (/\/counts\/[^/]+\/entries$/.test(p))
			return json(route, {
				accepted: body.entries.map((entry: { clientId: string }) => ({
					clientId: entry.clientId,
					quantity: null,
				})),
				duplicates: [],
				refused: [],
			})
		if (/\/counts\/[^/]+\/send$/.test(p))
			return json(route, { ...openCount, status: 'in_review' })
		if (/\/counts\/[^/]+$/.test(p)) return json(route, countSheet)
		if (p === '/pos/inventory/waste')
			return json(route, {
				accepted: body.entries.map((entry: { clientId: string }) => ({
					clientId: entry.clientId,
					id: `wst_${++serial}`,
					quantity: 1000,
				})),
				duplicates: [],
				refused: [],
				lateSync: [],
			})
		if (/\/waste\/[^/]+\/undo$/.test(p)) return json(route, { id: 'rev_1' })
		if (p === '/pos/inventory/deliveries')
			return json(route, {
				id: 'dlv_1',
				lineCount: body.lines.length,
				receivedAt: Date.now(),
				pricesPending: true,
				lateSync: false,
				duplicate: false,
				order: { id: body.orderId ?? 'none', status: 'partly_received' },
				orderLinkIgnored: null,
			})
		return json(route, { error: 'not_found' }, 404)
	})
	return {
		seen,
		writes: (match: string | RegExp) =>
			seen.filter(
				(call) =>
					call.method === 'POST' &&
					(typeof match === 'string'
						? call.path === match
						: match.test(call.path)),
			),
	}
}

/** A terminal paired at the Main location with staff sign-in and Stock on. */
async function pairedWithStock(
	context: BrowserContext,
	page: Page,
	options: Parameters<typeof stockRegion>[1] = {},
) {
	const region = await stockRegion(context, options)
	await seedSettings(context, {
		appUrl: APP,
		slug: 'demo',
		tenantApiUrl: API,
		terminalCode: 'T1',
		locationId: 'main',
		locationLocked: true,
		signInRequired: true,
		deviceToken: 'pdv1.e2e.stock-secret',
		deviceLabel: 'Kitchen tablet',
		demo: false,
		apps: { timeclock: false, reservations: false, inventory: true },
	})
	await page.goto('/')
	await signInWithPin(page, '4321')
	return region
}

const stock = (page: Page) => page.getByRole('main', { name: 'Stock' })
const sheet = (page: Page, name: string) => page.getByRole('dialog', { name })

test.describe('the Stock app', () => {
	test('is in the launcher on a terminal that has it, and opens on Count, Waste and Delivery', async ({
		page,
		context,
	}) => {
		await pairedWithStock(context, page)
		await selectStationApp(page, 'Stock')
		await expect(
			stock(page).getByRole('button', { name: /^Count/ }),
		).toBeVisible()
		await expect(
			stock(page).getByRole('button', { name: /^Waste/ }),
		).toBeVisible()
		await expect(
			stock(page).getByRole('button', { name: /^Delivery/ }),
		).toBeVisible()
		await expect(stock(page).getByText('In progress')).toBeVisible()
		await capture(page, 'home')
	})

	test('a count joined from the list, counted offline, goes out on reconnect in one request and is sent for review', async ({
		page,
		context,
	}) => {
		const region = await pairedWithStock(context, page)
		await selectStationApp(page, 'Stock')
		await stock(page)
			.getByRole('button', { name: /^Weekly count/ })
			.click()
		await expect(page.getByRole('navigation', { name: 'Areas' })).toBeVisible()
		await capture(page, 'count')

		await goOffline(context, page)
		await page.getByRole('button', { name: 'One more Tomatoes' }).click()
		await page.getByRole('button', { name: '½ of Tomatoes' }).click()
		await expect(page.getByLabel('Tomatoes', { exact: true })).toHaveValue(
			'1.5',
		)
		await expect(page.getByText('Saved on this tablet').first()).toBeVisible()
		await page.getByRole('button', { name: /^Dry store/ }).click()
		await page.getByRole('button', { name: 'One more Olive oil' }).click()
		expect(region.writes(/entries$/)).toHaveLength(0)
		await capture(page, 'count-offline')

		await goOnline(context, page)
		await expect
			.poll(() => region.writes(/entries$/).length, { timeout: 40_000 })
			.toBe(1)
		const [request] = region.writes(/entries$/)
		expect(request!.path).toBe('/pos/inventory/counts/cnt_open1/entries')
		expect(request!.headers['pos-staff-session']).toBe(
			'e2e-session-token-aaaaaaaaaaaa',
		)
		expect(request!.headers['pos-inventory-contract']).toBe('1')
		expect(
			request!.body.entries.map(
				(e: { itemId: string; amount: number; madeBy: string }) => [
					e.itemId,
					e.amount,
					e.madeBy,
				],
			),
		).toEqual([
			['item_tomato', 1.5, 'stf_ana'],
			['item_oil', 1, 'stf_ana'],
		])

		await page.getByRole('button', { name: 'Send for review' }).first().click()
		await sheet(page, 'Send for review?')
			.getByRole('button', { name: 'Send for review' })
			.click()
		await expect(page.getByText('Your part of the count is done')).toBeVisible()
		await expect.poll(() => region.writes(/send$/).length).toBe(1)
	})

	test('waste undone within the minute never leaves the tablet; undone after it was sent goes to the region', async ({
		page,
		context,
	}) => {
		const region = await pairedWithStock(context, page)
		await selectStationApp(page, 'Stock')
		await stock(page)
			.getByRole('button', { name: /^Waste/ })
			.click()
		const waste = sheet(page, 'Log waste')
		await waste.getByRole('button', { name: 'Pita bread' }).click()
		await waste.getByRole('button', { name: 'One more Pita bread' }).click()
		await waste.getByRole('button', { name: 'Dropped' }).click()
		await capture(page, 'waste')
		await waste.getByRole('button', { name: 'Log waste' }).click()
		await waste.getByRole('button', { name: /^Undo/ }).click()
		await expect(waste.getByText('Undone')).toBeVisible()
		// Past the few seconds waste waits before it is sent: nothing went.
		await page.waitForTimeout(4_500)
		expect(region.writes('/pos/inventory/waste')).toHaveLength(0)

		await waste.getByRole('button', { name: 'Tomatoes' }).click()
		await waste.getByRole('button', { name: 'One more Tomatoes' }).click()
		await waste.getByRole('button', { name: 'Spoiled' }).click()
		await waste.getByRole('button', { name: 'Log waste' }).click()
		await expect
			.poll(() => region.writes('/pos/inventory/waste').length, {
				timeout: 15_000,
			})
			.toBe(1)
		expect(
			region.writes('/pos/inventory/waste')[0]!.body.entries[0],
		).toMatchObject({
			itemId: 'item_tomato',
			reason: 'spoiled',
			locationId: 'main',
			madeBy: 'stf_ana',
		})
		await waste.getByRole('button', { name: /^Undo/ }).click()
		await expect.poll(() => region.writes(/undo$/).length).toBe(1)
	})

	test('Kitchen has a Log waste button that opens the same sheet', async ({
		page,
		context,
	}) => {
		await pairedWithStock(context, page)
		await selectStationApp(page, 'Kitchen')
		await page.getByRole('button', { name: 'Log waste' }).click()
		await expect(sheet(page, 'Log waste')).toBeVisible()
		await expect(
			sheet(page, 'Log waste').getByText('Logging as Ana K.'),
		).toBeVisible()
		await capture(page, 'kitchen-waste')
	})

	test('a delivery with a short line and a real weight is received by quantity, no prices anywhere', async ({
		page,
		context,
	}) => {
		const region = await pairedWithStock(context, page, { role: 'manager' })
		await selectStationApp(page, 'Stock')
		await stock(page)
			.getByRole('button', { name: /^Delivery/ })
			.click()
		const delivery = sheet(page, 'Receive delivery')
		await delivery.getByRole('button', { name: /^Fresh Produce Co/ }).click()
		await capture(page, 'delivery')
		await delivery
			.getByRole('button', { name: 'One less Crate 6 kg of Tomatoes' })
			.click()
		await expect(delivery.getByText('Short')).toBeVisible()
		await delivery.getByLabel('Weight of Chicken thigh').fill('18.4')
		await delivery.getByLabel('Invoice number (optional)').fill('INV-2041')
		await expect(delivery).not.toContainText(/[$€£]|price|total/i)
		await delivery.getByRole('button', { name: 'Save delivery' }).click()
		await expect(delivery.getByText('Delivery saved')).toBeVisible()
		await expect
			.poll(() => region.writes('/pos/inventory/deliveries').length, {
				timeout: 15_000,
			})
			.toBe(1)
		const body = region.writes('/pos/inventory/deliveries')[0]!.body
		expect(body).toMatchObject({
			supplierId: 'sup_fresh',
			orderId: 'ord_41',
			invoiceNumber: 'INV-2041',
		})
		expect(
			body.lines.map((line: { itemId: string; quantity: number }) => [
				line.itemId,
				line.quantity,
			]),
		).toEqual([
			['item_tomato', 12_000_000],
			['item_chicken', 18_400_000],
		])
		expect(JSON.stringify(body)).not.toMatch(/Minor|price|currency/)
	})

	test('a cashier is told a manager must sign in to receive a delivery', async ({
		page,
		context,
	}) => {
		await pairedWithStock(context, page, { role: 'cashier' })
		await selectStationApp(page, 'Stock')
		await stock(page)
			.getByRole('button', { name: /^Delivery/ })
			.click()
		await expect(
			sheet(page, 'Receive delivery').getByText(
				'A manager must sign in to receive a delivery.',
			),
		).toBeVisible()
	})

	test('on a phone, counting fits the screen', async ({ page, context }) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await pairedWithStock(context, page)
		await selectStationApp(page, 'Stock')
		await stock(page)
			.getByRole('button', { name: /^Weekly count/ })
			.click()
		await expect(
			page.getByRole('button', { name: 'One more Tomatoes' }),
		).toBeVisible()
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth,
		)
		expect(overflow).toBe(false)
		await capture(page, 'phone-count')
	})

	test('right to left, the home reads in Arabic', async ({ page, context }) => {
		await pairedWithStock(context, page)
		await page.evaluate(() => {
			const key = 'pos.settings.v1'
			const settings = JSON.parse(localStorage.getItem(key) ?? '{}')
			localStorage.setItem(
				key,
				JSON.stringify({ ...settings, locale: 'ar', activeApp: 'stock' }),
			)
		})
		await page.reload()
		await signInWithPin(page, '4321')
		await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
		await expect(page.getByRole('main', { name: 'المخزون' })).toBeVisible()
		await capture(page, 'home-ar')
	})
})
