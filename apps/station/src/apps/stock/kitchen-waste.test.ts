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

function drawKitchen(inventory: boolean) {
	vi.mocked(useKitchen).mockReturnValue({
		feed,
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
				apps: { timeclock: false, reservations: false, inventory },
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
