// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { DEFAULT_KDS_CONFIG, type KdsFeed } from '@repo/common/kds'
import { createElement as h } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Kitchen } from '../kitchen/Kitchen.tsx'
import { useKitchen } from '../kitchen/useKitchen.ts'
import { stockRows } from './queue.ts'
import { ORIGIN, resetStock, session, settings } from './testing.ts'
import {
	button,
	click,
	hasButton,
	installDom,
	mount,
	region,
	text,
	type Page,
} from './ui-testing.ts'

vi.mock('../kitchen/useKitchen.ts', () => ({ useKitchen: vi.fn() }))

let page: Page
beforeEach(async () => {
	installDom()
	await resetStock()
	vi.stubGlobal('Notification', undefined)
	page = mount()
})
afterEach(async () => {
	await page.unmount()
	vi.unstubAllGlobals()
})

const feed: KdsFeed = {
	config: DEFAULT_KDS_CONFIG,
	configVersion: 1,
	tickets: [],
	serverNow: 2_000_000,
	truncated: false,
}

const cancelledTicket = {
	id: 'ord_9',
	source: 'online' as const,
	number: '9',
	channel: 'online' as const,
	fulfillment: 'takeaway' as const,
	tableLabel: null,
	createdAt: 1_900_000,
	dueAt: null,
	version: 'v1',
	completedAt: null,
	cancelled: true,
	lines: [
		{
			id: 'l1',
			itemId: 'dish_shawarma',
			name: 'Shawarma',
			quantity: 2,
			variant: null,
			variantId: null,
			options: [],
			instructions: '',
			stationId: DEFAULT_KDS_CONFIG.defaultStationId,
			stage: 'preparing' as const,
		},
		{
			id: 'l2',
			itemId: 'dish_fries',
			name: 'Fries',
			quantity: 1,
			variant: null,
			variantId: null,
			options: [],
			instructions: '',
			stationId: DEFAULT_KDS_CONFIG.defaultStationId,
			stage: 'new' as const,
		},
	],
}

function drawKitchen(inventory: boolean, tickets: KdsFeed['tickets'] = []) {
	vi.mocked(useKitchen).mockReturnValue({
		feed: { ...feed, tickets },
		error: null,
		busy: false,
		stale: false,
		now: 2_000_000,
		refresh: vi.fn(async () => {}),
		command: vi.fn(async () => true),
		configure: vi.fn(async () => true),
	})
	return page.draw(
		h(Kitchen, {
			settings: {
				...settings,
				apps: {
					timeclock: false,
					reservations: false,
					inventory,
					orders: false,
				},
			},
			session: session(),
			online: true,
			categories: [],
			onSignIn: vi.fn(),
			renderHeader: (controls) => h('header', null, controls),
		}),
	)
}

describe('Kitchen’s Log waste button', () => {
	it('is there only on a terminal that has Stock', async () => {
		await drawKitchen(false)
		expect(hasButton(page.host, /Log waste/)).toBe(false)
		await page.unmount()
		page = mount()
		await drawKitchen(true)
		expect(hasButton(page.host, /Log waste/)).toBe(true)
	})

	it('opens the same waste sheet, and what is logged goes to the same outbox as the Stock app’s', async () => {
		const api = region()
		api.install()
		await drawKitchen(true)
		await click(button(page.host, /Log waste/))
		const dialog = () => page.host.querySelector('dialog[open]')!
		await vi.waitFor(() => expect(hasButton(dialog(), 'Tomatoes')).toBe(true))
		await click(button(dialog(), 'Tomatoes'))
		await click(button(dialog(), 'One more Tomatoes'))
		await click(button(dialog(), 'Over-prepped'))
		await click(button(dialog(), 'Log waste'))
		await vi.waitFor(async () =>
			expect(await stockRows(ORIGIN)).toHaveLength(1),
		)
		expect((await stockRows(ORIGIN))[0]).toMatchObject({
			kind: 'waste',
			madeBy: 'stf_ana',
			payload: { entry: { itemId: 'item_tomato', reason: 'over_prepped' } },
		})
		expect(text(dialog())).toContain('Tomatoes · 1 kg · Over-prepped')
		// Closing it leaves the board as it was.
		await click(button(dialog(), 'Done'))
		expect(page.host.querySelector('dialog')).toBeNull()
	})
})

describe('Kitchen’s "Log it as waste?" on a cancelled ticket', () => {
	it('records only the dishes already started, once the cook taps it', async () => {
		const api = region()
		api.install()
		await drawKitchen(true, [cancelledTicket])
		await click(button(page.host, /Log it as waste\?/))
		await vi.waitFor(() =>
			expect(text(page.host)).toContain('Logged as waste.'),
		)
		const sent = api.requests.find(
			(request) => request.path === '/pos/inventory/waste/dishes',
		)!
		expect(sent.method).toBe('POST')
		expect(sent.body).toMatchObject({
			locationId: 'main',
			// The fries had not been started, so they are not waste.
			lines: [{ itemId: 'dish_shawarma', variantId: null, quantity: 2 }],
		})
		expect(sent.body.clientId).toBe('kw-online-ord_9')
		expect(hasButton(page.host, /Log it as waste\?/)).toBe(false)
	})

	it('is offered only on a cancelled ticket of a terminal that has Stock', async () => {
		await drawKitchen(false, [cancelledTicket])
		expect(hasButton(page.host, /Log it as waste\?/)).toBe(false)
		await page.unmount()
		page = mount()
		await drawKitchen(true, [{ ...cancelledTicket, cancelled: false }])
		expect(hasButton(page.host, /Log it as waste\?/)).toBe(false)
		await page.unmount()
		page = mount()
		// Nothing started, nothing wasted.
		await drawKitchen(true, [
			{
				...cancelledTicket,
				lines: cancelledTicket.lines.map((line) => ({
					...line,
					stage: 'new' as const,
				})),
			},
		])
		expect(hasButton(page.host, /Log it as waste\?/)).toBe(false)
	})

	it('says so when it could not log it, and lets the cook try again', async () => {
		const api = region({ online: false })
		api.install()
		await drawKitchen(true, [cancelledTicket])
		await click(button(page.host, /Log it as waste\?/))
		await vi.waitFor(() =>
			expect(text(page.host)).toContain('We could not log it. Try again.'),
		)
		expect(hasButton(page.host, /Log it as waste\?/)).toBe(true)
	})
})
