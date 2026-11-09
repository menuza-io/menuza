// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { createElement as h } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stockRows } from './queue.ts'
import { Stock } from './Stock.tsx'
import { ORIGIN, resetStock, session, settings } from './testing.ts'
import {
	button,
	buttons,
	click,
	flush,
	hasButton,
	installDom,
	mount,
	region,
	text,
	type,
	type Page,
} from './ui-testing.ts'
import { db } from '~/lib/db.ts'
import { type Session } from '~/lib/signin.ts'

let page: Page
const issues: unknown[][] = []

beforeEach(async () => {
	issues.length = 0
	// Data arrives from IndexedDB and the network after the test's own calls: those updates are not ours to wrap.
	vi.spyOn(console, 'error').mockImplementation((...args) => {
		if (!String(args[0]).includes('not wrapped in act')) issues.push(args)
	})
	installDom()
	await resetStock()
	page = mount()
})
afterEach(async () => {
	await page.unmount()
	try {
		expect(issues).toEqual([])
	} finally {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	}
})

async function openStock(
	node: { online?: boolean; session?: Session | null } = {},
) {
	const props = {
		settings,
		session: node.session === undefined ? session() : node.session,
		online: node.online ?? true,
		onSignIn: vi.fn(),
	}
	await page.draw(h(Stock, props))
	return props
}
/** An earlier visit with a connection: the catalogue is on the tablet, then the page is drawn afresh. */
async function cacheCatalog() {
	region().install()
	await openStock()
	await loaded()
	await page.unmount()
	page = mount()
}
const loaded = () =>
	vi.waitFor(() => expect(text(page.host)).toContain('Weekly count'))

describe('Stock home', () => {
	it('shows Count, Waste and Delivery, and the counts already in progress at the location', async () => {
		const api = region()
		api.install()
		await openStock()
		await loaded()
		expect(hasButton(page.host, /^Count/)).toBe(true)
		expect(hasButton(page.host, /^Waste/)).toBe(true)
		expect(hasButton(page.host, /^Delivery/)).toBe(true)
		expect(text(page.host)).toContain('In progress')
		expect(text(page.host)).toContain('2 of 5 counted')
		// Nothing about money or what is on the shelves.
		expect(text(page.host)).not.toMatch(/[$€£]|on hand|expected/i)
		// The first request is the catalogue, with the staff session and contract version.
		const [first] = api.requests
		expect(first).toMatchObject({
			method: 'GET',
			path: '/pos/inventory/catalog',
		})
		expect(first!.headers.get('Pos-Staff-Session')).toBe(
			'staff-session-token-aaaaaaaa',
		)
		expect(first!.headers.get('Authorization')).toBe('Bearer device-secret')
		expect(first!.headers.get('Pos-Inventory-Contract')).toBe('1')
	})

	it('asks for a location when the terminal has none', async () => {
		region().install()
		await page.draw(
			h(Stock, {
				settings: { ...settings, locationId: null },
				session: session(),
				online: true,
				onSignIn: vi.fn(),
			}),
		)
		expect(text(page.host)).toContain('This tablet needs a location')
	})

	it('works from the copy on the tablet with no connection, and says what it is waiting for', async () => {
		const api = region()
		api.install()
		await openStock()
		await loaded()
		await page.unmount()
		page = mount()
		api.state.online = false
		await openStock({ online: false })
		await loaded()
		expect(text(page.host)).toContain('Weekly count')
	})

	it('first time, with no connection and no copy, says to connect once', async () => {
		region({ online: false }).install()
		await openStock({ online: false })
		await click(button(page.host, /^Waste/))
		await flush()
		expect(text(page.host)).toContain('Connect once')
	})
})

describe('Count', () => {
	async function joinOpenCount(opts: { online?: boolean } = {}) {
		const api = region({ online: opts.online })
		api.install()
		const props = await openStock({ online: opts.online })
		await loaded()
		await click(button(page.host, /^Weekly count/))
		await vi.waitFor(() => expect(text(page.host)).toContain('Walk-in fridge'))
		return { api, props }
	}

	it('opens the count in progress with area tabs in shelf order, showing what others counted only as counted', async () => {
		await joinOpenCount()
		const tabs = [
			...page.host.querySelectorAll('nav[aria-label="Areas"] button'),
		].map((tab) => tab.textContent?.replace(/\s+/g, ' ').trim())
		// Chicken (typed here before) and lemons (counted by someone) already count.
		expect(tabs).toEqual([
			'Walk-in fridge1/2',
			'Dry store0/2',
			'Not in an area1/1',
		])
		// Rows of the first area, in shelf order.
		const names = [...page.host.querySelectorAll('li p.font-semibold')].map(
			(p) => p.textContent,
		)
		expect(names).toEqual(['Chicken thigh', 'Tomatoes'])
		const field = (name: string) =>
			page.host.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
		// What this person typed before comes back.
		expect(field('Chicken thigh').value).toBe('4.5')
		expect(field('Tomatoes').value).toBe('')
		// Someone else's count is a mark, never a number to copy.
		await click(button(page.host, /^Not in an area/))
		expect(text(page.host)).toContain('Someone already counted this')
		expect(text(page.host)).not.toMatch(/30,000|30000/)
		expect(field('Lemons').value).toBe('')
	})

	it('starts blank: the first + gives one, the first − gives zero, and neither is guessed before', async () => {
		await joinOpenCount()
		const field = (name: string) =>
			page.host.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
		expect(field('Tomatoes').value).toBe('')
		await click(button(page.host, 'One less Tomatoes'))
		expect(field('Tomatoes').value).toBe('0')
		await click(button(page.host, 'One less Tomatoes'))
		expect(field('Tomatoes').value).toBe('0')
		await click(button(page.host, 'One more Tomatoes'))
		await click(button(page.host, '½ of Tomatoes'))
		expect(field('Tomatoes').value).toBe('1.5')
		// Tapping the same fraction again takes it off.
		await click(button(page.host, '½ of Tomatoes'))
		expect(field('Tomatoes').value).toBe('1')
		// Clearing makes it blank (not counted) again.
		await click(button(page.host, 'Clear Tomatoes'))
		expect(field('Tomatoes').value).toBe('')
		await vi.waitFor(async () => {
			const rows = await stockRows(ORIGIN)
			const entry = rows.find((row) => row.kind === 'count_entry')
			expect(
				entry && entry.kind === 'count_entry' && entry.payload.entry.amount,
			).toBeNull()
		})
	})

	it('queues each change on the tablet and sends them in one request, once, with who and when', async () => {
		const { api } = await joinOpenCount()
		await click(button(page.host, 'One more Tomatoes'))
		await click(button(page.host, 'One more Tomatoes'))
		await click(button(page.host, 'One more Tomatoes'))
		// Three taps are one waiting entry.
		const rows = await stockRows(ORIGIN)
		expect(rows.filter((row) => row.kind === 'count_entry')).toHaveLength(1)
		await vi.waitFor(() =>
			expect(text(page.host)).toContain('Saved on this tablet'),
		)
		await vi.waitFor(() => expect(api.writes(/\/entries$/)).toHaveLength(1), {
			timeout: 5_000,
		})
		const [request] = api.writes(/\/entries$/)
		expect(request!.path).toBe('/pos/inventory/counts/cnt_open1/entries')
		expect(request!.body.entries).toHaveLength(1)
		expect(request!.body.entries[0]).toMatchObject({
			itemId: 'item_tomato',
			areaId: 'area_walkin',
			amount: 3,
			unit: 'kg',
			madeBy: 'stf_ana',
		})
		expect(typeof request!.body.entries[0].madeAt).toBe('number')
		await vi.waitFor(async () => expect(await stockRows(ORIGIN)).toEqual([]))
		await vi.waitFor(() => expect(text(page.host)).toContain('Sent'))
	})

	it('switches a row’s unit without changing what was counted', async () => {
		await joinOpenCount()
		const field = page.host.querySelector<HTMLInputElement>(
			'input[aria-label="Tomatoes"]',
		)!
		await type(field, '1.5')
		expect(field.value).toBe('1.5')
		const select = page.host.querySelector<HTMLSelectElement>(
			'select[aria-label="Unit for Tomatoes"]',
		)!
		await act(select, 'g')
		expect(
			page.host.querySelector<HTMLInputElement>('input[aria-label="Tomatoes"]')!
				.value,
		).toBe('1500')
		await vi.waitFor(async () => {
			const rows = await stockRows(ORIGIN)
			const entry = rows.find((row) => row.kind === 'count_entry')
			expect(
				entry && entry.kind === 'count_entry' && entry.payload.entry,
			).toMatchObject({ amount: 1500, unit: 'g' })
		})
	})

	it('offline, keeps every tap on the tablet and sends it when the connection comes back, in order', async () => {
		await cacheCatalog()
		const offline = region({ online: false })
		offline.install()
		const props = await openStock({ online: false })
		await loaded()
		await click(button(page.host, /^Weekly count/))
		await vi.waitFor(() => expect(text(page.host)).toContain('Walk-in fridge'))
		await click(button(page.host, 'One more Tomatoes'))
		await click(button(page.host, 'One more Chicken thigh'))
		await click(button(page.host, /^Dry store/))
		await click(button(page.host, 'One more Olive oil'))
		await vi.waitFor(async () =>
			expect(await stockRows(ORIGIN)).toHaveLength(3),
		)
		expect(offline.writes(/entries/)).toEqual([])
		expect((await stockRows(ORIGIN)).map((row) => row.kind)).toEqual([
			'count_entry',
			'count_entry',
			'count_entry',
		])
		await vi.waitFor(() =>
			expect(text(page.host)).toContain('Saved on this tablet'),
		)

		// The connection is back.
		offline.state.online = true
		await page.draw(h(Stock, { ...props, online: true }))
		await vi.waitFor(() => expect(offline.writes(/entries/)).toHaveLength(1), {
			timeout: 5_000,
		})
		expect(
			offline
				.writes(/entries/)[0]!
				.body.entries.map((e: { itemId: string }) => e.itemId),
		).toEqual(['item_tomato', 'item_chicken', 'item_oil'])
		await vi.waitFor(async () => expect(await stockRows(ORIGIN)).toEqual([]))
	})

	it('starting a new count offline works at once and names the count by its start until the server answers', async () => {
		await cacheCatalog()
		const offline = region({ online: false })
		offline.install()
		await openStock({ online: false })
		await click(button(page.host, /^Count/))
		const dialog = page.host.querySelector('dialog[open]')!
		// The list on offer to start (the count in progress above it is the other one).
		await click(buttons(dialog, /^Weekly count/).at(-1)!)
		await vi.waitFor(() => expect(text(page.host)).toContain('Walk-in fridge'))
		await click(button(page.host, 'One more Tomatoes'))
		await vi.waitFor(async () =>
			expect(await stockRows(ORIGIN)).toHaveLength(2),
		)
		const rows = await stockRows(ORIGIN)
		expect(rows.map((row) => row.kind)).toEqual(['count_start', 'count_entry'])
		expect(rows[1]).toMatchObject({
			payload: { count: { clientId: rows[0]!.id } },
		})
		await vi.waitFor(() =>
			expect(text(page.host)).toContain('Saved on this tablet'),
		)
	})

	it('Send for review asks first, queues the send after every entry, and ends this tablet’s part', async () => {
		const { api } = await joinOpenCount()
		await click(button(page.host, 'One more Tomatoes'))
		await click(button(page.host, 'Send for review'))
		expect(text(page.host)).toContain('Send for review?')
		expect(text(page.host)).toContain(
			'Items you did not count stay as they were',
		)
		const dialog = page.host.querySelector('dialog[open]')!
		await click(button(dialog, 'Send for review'))
		await vi.waitFor(
			() => expect(text(page.host)).toContain('Your part of the count is done'),
			{
				timeout: 5_000,
			},
		)
		await vi.waitFor(() => expect(api.writes(/\/send$/)).toHaveLength(1), {
			timeout: 5_000,
		})
		const order = api.requests
			.filter((request) => request.method === 'POST')
			.map((request) => request.path.split('/').pop())
		expect(order).toEqual(['entries', 'send'])
		expect(api.writes(/\/send$/)[0]!.body).toMatchObject({ madeBy: 'stf_ana' })
	})

	it('tells the person when entries were refused after the count closed, and keeps them to clear', async () => {
		const api = region()
		api.install()
		const original = api.fetchImpl.getMockImplementation()!
		api.fetchImpl.mockImplementation(async (input, init) => {
			if (String(input).endsWith('/entries'))
				return Response.json({ error: 'count_closed' }, { status: 409 })
			return original(input, init)
		})
		await openStock()
		await loaded()
		await click(button(page.host, /^Weekly count/))
		await vi.waitFor(() => expect(text(page.host)).toContain('Walk-in fridge'))
		await click(button(page.host, 'One more Tomatoes'))
		await vi.waitFor(
			() => expect(text(page.host)).toContain('1 entry was not sent'),
			{
				timeout: 5_000,
			},
		)
		expect(text(page.host)).toContain('Not sent')
		await click(button(page.host, 'See why'))
		await vi.waitFor(() =>
			expect(text(page.host)).toContain('Sent after the count closed: 1 entry'),
		)
		await click(button(page.host, 'Clear these'))
		await vi.waitFor(async () => expect(await stockRows(ORIGIN)).toEqual([]))
	})
})

async function act(select: HTMLSelectElement, value: string) {
	const { act: reactAct } = await import('react')
	await reactAct(async () => {
		select.value = value
		select.dispatchEvent(new Event('change', { bubbles: true }))
	})
}

describe('Waste', () => {
	async function openWaste() {
		const api = region()
		api.install()
		await openStock()
		await loaded()
		await click(button(page.host, /^Waste/))
		return api
	}

	it('offers this terminal’s recent items first and keeps cost out of it', async () => {
		await openWaste()
		const dialog = page.host.querySelector('dialog[open]')!
		expect(text(dialog)).toContain('Recent')
		expect(hasButton(dialog, 'Tomatoes')).toBe(true)
		expect(hasButton(dialog, 'Pita bread')).toBe(true)
		expect(text(dialog)).not.toMatch(/[$€£]|cost|price/i)
		expect(text(dialog)).toContain('Logging as Ana K.')
	})

	it('needs an amount and a reason, then queues one entry for the signed-in person', async () => {
		await openWaste()
		const dialog = () => page.host.querySelector('dialog[open]')!
		await click(button(dialog(), 'Tomatoes'))
		const submit = () => button(dialog(), 'Log waste') as HTMLButtonElement
		expect(submit().disabled).toBe(true)
		await click(button(dialog(), 'One more Tomatoes'))
		await click(button(dialog(), '½ of Tomatoes'))
		expect(submit().disabled).toBe(true)
		await click(button(dialog(), 'Spoiled'))
		expect(submit().disabled).toBe(false)
		await click(submit())
		await vi.waitFor(async () =>
			expect(await stockRows(ORIGIN)).toHaveLength(1),
		)
		const rows = await stockRows(ORIGIN)
		expect(rows[0]).toMatchObject({
			kind: 'waste',
			madeBy: 'stf_ana',
			payload: {
				entry: {
					itemId: 'item_tomato',
					amount: 1.5,
					unit: 'kg',
					reason: 'spoiled',
					locationId: 'main',
				},
			},
		})
		expect(text(dialog())).toContain('Tomatoes · 1.5 kg · Spoiled')
	})

	it('undoing straight away takes it out of the queue before it ever leaves the tablet', async () => {
		const api = await openWaste()
		const dialog = () => page.host.querySelector('dialog[open]')!
		await click(button(dialog(), 'Pita bread'))
		await click(button(dialog(), 'One more Pita bread'))
		await click(button(dialog(), 'Dropped'))
		await click(button(dialog(), 'Log waste'))
		await vi.waitFor(async () =>
			expect((await stockRows(ORIGIN)).map((row) => row.kind)).toEqual([
				'waste',
			]),
		)
		await vi.waitFor(() => expect(hasButton(dialog(), /^Undo/)).toBe(true))
		await click(button(dialog(), /^Undo/))
		await vi.waitFor(() => expect(text(dialog())).toContain('Undone'))
		expect(await stockRows(ORIGIN)).toEqual([])
		expect(api.writes(/waste/)).toEqual([])
	})

	it('sends waste a few seconds after it is logged, and an undo after that is the server’s', async () => {
		const api = await openWaste()
		const dialog = () => page.host.querySelector('dialog[open]')!
		await click(button(dialog(), 'Tomatoes'))
		await click(button(dialog(), 'One more Tomatoes'))
		await click(button(dialog(), 'Expired'))
		await click(button(dialog(), 'Log waste'))
		await vi.waitFor(
			() => expect(api.writes('/pos/inventory/waste')).toHaveLength(1),
			{
				timeout: 6_000,
			},
		)
		await vi.waitFor(async () => expect(await stockRows(ORIGIN)).toEqual([]))
		await click(button(dialog(), /^Undo/))
		await vi.waitFor(
			() => expect(api.writes(/\/waste\/wst_1\/undo$/)).toHaveLength(1),
			{
				timeout: 5_000,
			},
		)
		expect(api.writes(/undo$/)[0]!.body.clientId).toBeTruthy()
	})

	it('finds an item by typing its name', async () => {
		await openWaste()
		const dialog = () => page.host.querySelector('dialog[open]')!
		const search = dialog().querySelector<HTMLInputElement>(
			'input[type="search"]',
		)!
		await type(search, 'lem', false)
		expect(hasButton(dialog(), /^Lemons/)).toBe(true)
		expect(hasButton(dialog(), /^Tomatoes/)).toBe(false)
		expect(text(dialog())).not.toContain('Recent')
	})
})

describe('Delivery', () => {
	async function openDelivery(who: Session) {
		const api = region()
		api.install()
		await openStock({ session: who })
		await loaded()
		await click(button(page.host, /^Delivery/))
		return api
	}
	const manager = () =>
		session({ role: 'manager', staff: { id: 'stf_mo', name: 'Mo A.' } })

	it('needs a manager when the location says so', async () => {
		await openDelivery(session())
		const dialog = page.host.querySelector('dialog[open]')!
		expect(text(dialog)).toContain(
			'A manager must sign in to receive a delivery',
		)
		expect(text(dialog)).not.toContain('Fresh Produce Co')
	})

	it('receives an expected delivery by quantity only, with a short line, the real weight and the invoice number', async () => {
		const api = await openDelivery(manager())
		const dialog = () => page.host.querySelector('dialog[open]')!
		expect(text(dialog())).toContain('Expected deliveries')
		await click(button(dialog(), /^Fresh Produce Co/))
		// Prices are nowhere on it.
		expect(text(dialog())).not.toMatch(/[$€£]|price|total/i)
		// Tomatoes: two crates of the three ordered.
		await click(button(dialog(), 'One less Crate 6 kg of Tomatoes'))
		expect(text(dialog())).toContain('Short')
		// Chicken is priced by weight: type what the scale says.
		const weight = dialog().querySelector<HTMLInputElement>(
			'input[aria-label="Weight of Chicken thigh"]',
		)!
		await type(weight, '18.4')
		const invoice = [...dialog().querySelectorAll('label')]
			.find((label) => label.textContent?.includes('Invoice number'))!
			.querySelector('input')!
		await type(invoice, 'INV-2041')
		await click(button(dialog(), 'Save delivery'))
		await vi.waitFor(() => expect(text(dialog())).toContain('Delivery saved'))
		await vi.waitFor(
			() => expect(api.writes('/pos/inventory/deliveries')).toHaveLength(1),
			{
				timeout: 5_000,
			},
		)
		const [request] = api.writes('/pos/inventory/deliveries')
		expect(request!.body).toMatchObject({
			supplierId: 'sup_fresh',
			orderId: 'ord_41',
			invoiceNumber: 'INV-2041',
			locationId: 'main',
			madeBy: 'stf_mo',
		})
		expect(request!.body.lines).toEqual([
			{
				itemId: 'item_tomato',
				supplierProductId: 'sp_tomato_crate',
				quantity: 12_000_000,
				packs: 2,
				packName: 'Crate 6 kg',
				packBaseQuantity: 6_000_000,
				realWeightQuantity: null,
				orderLineId: 'ol_1',
			},
			{
				itemId: 'item_chicken',
				supplierProductId: 'sp_chicken_box',
				quantity: 18_400_000,
				packs: 2,
				packName: 'Box',
				packBaseQuantity: 10_000_000,
				realWeightQuantity: 18_400_000,
				orderLineId: 'ol_2',
			},
		])
		// No money anywhere in what was sent.
		expect(JSON.stringify(request!.body)).not.toMatch(
			/Minor|price|total|currency/,
		)
	})

	it('a delivery without an order picks a supplier and adds items from its pack products', async () => {
		const api = await openDelivery(manager())
		const dialog = () => page.host.querySelector('dialog[open]')!
		await click(button(dialog(), 'Fresh Produce Co'))
		await click(button(dialog(), /^Lemons/))
		expect(text(dialog())).toContain('Bag of 20')
		await click(button(dialog(), 'One more Bag of 20 of Lemons'))
		await click(button(dialog(), 'Save delivery'))
		await vi.waitFor(
			() => expect(api.writes('/pos/inventory/deliveries')).toHaveLength(1),
			{
				timeout: 5_000,
			},
		)
		const body = api.writes('/pos/inventory/deliveries')[0]!.body
		expect(body.orderId).toBeUndefined()
		expect(body.lines).toMatchObject([
			{ itemId: 'item_lemon', packs: 2, quantity: 40_000, orderLineId: null },
		])
	})

	it('offline, saves the delivery on the tablet and says it goes later', async () => {
		await cacheCatalog()
		const api = region({ online: false })
		api.install()
		await openStock({ session: manager(), online: false })
		await loaded()
		await click(button(page.host, /^Delivery/))
		const dialog = () => page.host.querySelector('dialog[open]')!
		await click(button(dialog(), /^Fresh Produce Co/))
		await click(button(dialog(), 'Save delivery'))
		await vi.waitFor(() =>
			expect(text(dialog())).toContain(
				'goes to the office when it is connected',
			),
		)
		expect((await stockRows(ORIGIN)).map((row) => row.kind)).toEqual([
			'delivery',
		])
		expect(await db.stockQueue.count()).toBe(1)
	})
})
