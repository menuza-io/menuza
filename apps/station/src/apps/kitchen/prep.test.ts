// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { DEFAULT_KDS_CONFIG, type KdsFeed } from '@repo/common/kds'
import { createElement as h } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStock, session, settings } from '../stock/testing.ts'
import {
	button,
	click,
	hasButton,
	installDom,
	mount,
	region,
	text,
	type Page,
} from '../stock/ui-testing.ts'
import { Kitchen } from './Kitchen.tsx'
import {
	notableDemandPercent,
	plannedAnswer,
	quantityText,
} from './prep-model.ts'
import { useKitchen } from './useKitchen.ts'
import { preparedTask } from '../stock/testing.ts'

vi.mock('./useKitchen.ts', () => ({ useKitchen: vi.fn() }))

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

describe('the kitchen prep list', () => {
	it('is there only when the terminal has Stock and the organization has prep', async () => {
		const api = region()
		api.install()
		await drawKitchen(false)
		expect(hasButton(page.host, 'Prep')).toBe(false)
		await page.unmount()
		page = mount()
		await drawKitchen(true)
		await vi.waitFor(() => expect(hasButton(page.host, 'Prep')).toBe(true))
	})

	it('hides itself when the region says prep is not switched on', async () => {
		let asked = 0
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).includes('/pos/inventory/prep')) {
					asked += 1
					return Response.json({ error: 'inventory_disabled' }, { status: 403 })
				}
				return Response.json({ error: 'not_found' }, { status: 404 })
			}),
		)
		await drawKitchen(true)
		await vi.waitFor(() => expect(asked).toBeGreaterThan(0))
		await vi.waitFor(() => expect(hasButton(page.host, 'Prep')).toBe(false))
	})

	it('shows what to make with the numbers, starts a task and records what came out', async () => {
		const api = region()
		api.install()
		await drawKitchen(true)
		await vi.waitFor(() => expect(hasButton(page.host, 'Prep')).toBe(true))
		await click(button(page.host, 'Prep'))
		await vi.waitFor(() => expect(text(page.host)).toContain('Garlic sauce'))
		expect(text(page.host)).toContain('Fill up to')

		const card = () =>
			page.host.querySelector('[data-testid="kitchen-prep-task_1"]')!
		await click(button(card(), 'Start'))
		await vi.waitFor(() =>
			expect(
				api.requests.some(
					(request) =>
						request.path === '/pos/inventory/prep/tasks/task_1/start',
				),
			).toBe(true),
		)
		const start = api.requests.find(
			(request) => request.path === '/pos/inventory/prep/tasks/task_1/start',
		)!
		expect(start.body).toEqual({ expectedVersion: 1 })

		await click(button(card(), 'Done'))
		const dialog = () => page.host.querySelector('dialog[open]')!
		await vi.waitFor(() =>
			expect(page.host.querySelector('dialog[open]')).not.toBeNull(),
		)
		expect(text(dialog())).toContain('How much did you make?')
		await click(button(dialog(), 'Mark as done'))
		await vi.waitFor(() =>
			expect(
				api.requests.some(
					(request) => request.path === '/pos/inventory/prep/tasks/task_1/done',
				),
			).toBe(true),
		)
		const done = api.requests.find(
			(request) => request.path === '/pos/inventory/prep/tasks/task_1/done',
		)!
		// The plan (two batches) was filled in.
		expect(done.body).toMatchObject({
			expectedVersion: 1,
			made: { kind: 'batches', count: 2 },
		})
		expect(done.body.clientId).toMatch(/^prep-[a-f0-9]{24}$/)
	})
})

describe('prep as pure rules', () => {
	const task = {
		...preparedTask(),
		plannedQuantity: 8_000_000,
		batches: 2,
	}

	it('says a quantity in the unit the item is counted in', () => {
		expect(quantityText(task, 8_000_000, 'en')).toBe('8 L')
		expect(quantityText(task, 1_500_000, 'en')).toBe('1.5 L')
	})

	it('fills in the plan: batches when the recipe has a batch size, else the amount', () => {
		expect(plannedAnswer(task)).toEqual({ kind: 'batches', value: 2 })
		expect(plannedAnswer({ ...task, batches: null, batchSize: null })).toEqual({
			kind: 'amount',
			value: 8,
		})
	})

	it('only mentions a real difference in how busy the day is', () => {
		expect(notableDemandPercent(10_200)).toBe(0)
		expect(notableDemandPercent(12_000)).toBe(20)
		expect(notableDemandPercent(8_000)).toBe(-20)
	})
})
