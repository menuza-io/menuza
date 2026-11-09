// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { createElement as h } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDemoStockApi } from './demo.ts'
import {
	failRow,
	logWaste,
	saveCountEntry,
	startCount,
	stockRows,
} from './queue.ts'
import { useStockSync } from './runner.ts'
import { SyncSheet } from './SyncSheet.tsx'
import { catalog, ctx, ORIGIN, resetStock } from './testing.ts'
import {
	button,
	click,
	hasButton,
	installDom,
	mount,
	text,
	type Page,
} from './ui-testing.ts'
import { type StockState } from './useStock.ts'

let page: Page
beforeEach(async () => {
	installDom()
	await resetStock()
	page = mount()
})
afterEach(async () => {
	await page.unmount()
	vi.unstubAllGlobals()
})

const sync = vi.fn(async () => {})
const stock = (over: Partial<StockState> = {}): StockState => ({
	api: createDemoStockApi(),
	origin: ORIGIN,
	ctx,
	role: 'cashier',
	staffName: 'Ana K.',
	catalog,
	loading: false,
	checkedAt: Date.now(),
	stale: false,
	refreshError: null,
	refresh: async () => {},
	stats: { waiting: 0, failed: 0 },
	syncState: useStockSync.getState(),
	sync,
	reachable: true,
	hasSession: true,
	...over,
})

const draw = (over: Partial<StockState> = {}, onSignIn = vi.fn()) =>
	page.draw(
		h(SyncSheet, {
			stock: stock(over),
			open: true,
			onClose: vi.fn(),
			onSignIn,
		}),
	)

describe('the sync screen', () => {
	it('says plainly that everything has been sent', async () => {
		await draw()
		expect(text(page.host)).toContain('Everything has been sent.')
	})

	it('lists what waits, in the person’s words, with the item names and no money', async () => {
		await logWaste(ctx, {
			itemId: 'item_tomato',
			amount: 2.5,
			unit: 'kg',
			reason: 'spoiled',
		})
		const record = await startCount(ctx, { id: null, name: null })
		await saveCountEntry(ctx, record.localId, {
			itemId: 'item_pita',
			areaId: null,
			amount: 1,
			unit: 'piece',
		})
		await draw()
		await vi.waitFor(() =>
			expect(text(page.host)).toContain('3 things are saved on this tablet'),
		)
		expect(text(page.host)).toContain('Waste: Tomatoes, 2.5 kg, Spoiled')
		expect(text(page.host)).toContain('Pita bread: 1 piece')
		expect(text(page.host)).toContain('Start a count')
	})

	it('puts entries sent after the count closed in one line, to clear', async () => {
		const record = await startCount(ctx, { id: null, name: null })
		for (const item of ['item_pita', 'item_oil', 'item_lemon'])
			await saveCountEntry(ctx, record.localId, {
				itemId: item,
				areaId: null,
				amount: 1,
				unit: 'piece',
			})
		const rows = await stockRows(ORIGIN)
		for (const row of rows.filter((entry) => entry.kind === 'count_entry'))
			await failRow(row, 'count_closed')
		await draw()
		await vi.waitFor(() =>
			expect(text(page.host)).toContain(
				'Sent after the count closed: 3 entries',
			),
		)
		await click(button(page.host, 'Clear these'))
		await vi.waitFor(async () =>
			expect(
				(await stockRows(ORIGIN)).filter((row) => row.kind === 'count_entry'),
			).toEqual([]),
		)
	})

	it('shows a refusal with its reason, and offers to try again only when that can help', async () => {
		await logWaste(ctx, {
			itemId: 'item_tomato',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		await logWaste(ctx, {
			itemId: 'item_oil',
			amount: 1,
			unit: 'l',
			reason: 'spoiled',
		})
		const [first, second] = await stockRows(ORIGIN)
		await failRow(first!, 'service_unavailable')
		await failRow(second!, 'unit_mismatch')
		await draw({ stats: { waiting: 0, failed: 2 } })
		await vi.waitFor(() => expect(text(page.host)).toContain('Needs attention'))
		expect(text(page.host)).toContain('The unit does not fit this item.')
		expect(button(page.host, 'Try again')).toBeTruthy()
		expect(page.host.querySelectorAll('button').length).toBeGreaterThan(0)
		expect(
			[...page.host.querySelectorAll('button')].filter(
				(b) => b.textContent === 'Try again',
			),
		).toHaveLength(1)
		await click(button(page.host, 'Try again'))
		await vi.waitFor(async () =>
			expect((await stockRows(ORIGIN)).map((row) => row.status).sort()).toEqual(
				['failed', 'queued'],
			),
		)
	})

	it('says why sending is on hold, and offers to sign in when that is the fix', async () => {
		await logWaste(ctx, {
			itemId: 'item_tomato',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		const onSignIn = vi.fn()
		await draw(
			{
				syncState: {
					...useStockSync.getState(),
					paused: 'staff_session_invalid',
				},
			},
			onSignIn,
		)
		await vi.waitFor(() =>
			expect(text(page.host)).toContain('Your sign-in ran out'),
		)
		await click(button(page.host, 'Sign in again'))
		expect(onSignIn).toHaveBeenCalled()
		await page.unmount()
		page = mount()
		await draw({
			syncState: { ...useStockSync.getState(), paused: 'inventory_disabled' },
		})
		await vi.waitFor(() =>
			expect(text(page.host)).toContain(
				'Stock is switched off for this restaurant',
			),
		)
		expect(hasButton(page.host, 'Sign in again')).toBe(false)
	})

	it('Try now asks for a send that ignores the wait', async () => {
		await logWaste(ctx, {
			itemId: 'item_tomato',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		sync.mockClear()
		await draw()
		await vi.waitFor(() =>
			expect((button(page.host, 'Try now') as HTMLButtonElement).disabled).toBe(
				false,
			),
		)
		await click(button(page.host, 'Try now'))
		expect(sync).toHaveBeenCalledWith(true)
	})
})
