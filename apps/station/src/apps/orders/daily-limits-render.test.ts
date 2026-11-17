// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	type DailyDishChangeBody,
	type DailyDishStatusData,
	type DailyDishStatusRowData,
} from '@repo/common/daily-dish-limits'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrdersError, type OrdersApi } from './api.ts'
import { ControlsSheet } from './Controls.tsx'
import { parseAmountLeft } from './DailyLimits.tsx'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/**
 * "Daily limits" in the manager controls (#409): what is left of each capped
 * dish today, the +5 / +10 and "Set amount left" top-ups, and that the list is
 * read again after every answer.
 */

const row = (
	values: Partial<DailyDishStatusRowData> = {},
): DailyDishStatusRowData => ({
	key: 'item:i-lamb',
	kind: 'item',
	id: 'i-lamb',
	name: 'Lamb shank special',
	limit: 20,
	showRemaining: true,
	toppedUpUnits: 0,
	soldUnits: 14,
	heldUnits: 2,
	remaining: 4,
	...values,
})
const status = (
	rows: DailyDishStatusRowData[],
	enabled = true,
): DailyDishStatusData => ({
	enabled,
	businessDate: '2026-03-10',
	rows,
})

let host: HTMLDivElement
let root: Root
let current: DailyDishStatusData
let api: Pick<
	OrdersApi,
	'controls' | 'pause' | 'availability' | 'dailyLimits' | 'topUpDailyLimit'
>
const dailyLimits = vi.fn()
const topUp = vi.fn()

beforeEach(() => {
	localStorage.clear()
	current = status([row()])
	dailyLimits.mockReset().mockImplementation(async () => current)
	topUp.mockReset().mockImplementation(async (change: DailyDishChangeBody) => {
		const found = current.rows.find((entry) => entry.key === change.key)!
		// Like the region: the figures move, then the list is read again.
		const remaining =
			change.addUnits !== undefined
				? found.remaining + change.addUnits
				: (change.amountLeft ?? 0)
		current = status(
			current.rows.map((entry) =>
				entry.key === change.key ? { ...entry, remaining } : entry,
			),
		)
		return current.rows.find((entry) => entry.key === change.key)!
	})
	api = {
		controls: vi.fn(async () => ({
			locationId: 'loc',
			pause: null,
			heldByStock: [],
			serverNow: 1,
		})),
		pause: vi.fn(),
		availability: vi.fn(),
		dailyLimits,
		topUpDailyLimit: topUp,
	}
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			disconnect() {}
		},
	)
	vi.stubGlobal('matchMedia', () => ({ matches: true }))
	HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
		this.setAttribute('open', '')
	}
	HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
		this.removeAttribute('open')
	}
	host = document.createElement('div')
	document.body.append(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

async function draw(over: { open?: boolean; online?: boolean } = {}) {
	await act(async () =>
		root.render(
			h(
				I18nProvider,
				{ i18n },
				h(ControlsSheet, {
					open: over.open ?? true,
					onClose: vi.fn(),
					api,
					online: over.online ?? true,
				}),
			),
		),
	)
}
const section = () =>
	document.querySelector('section[aria-labelledby="controls-daily-limits"]')
const buttonIn = (name: string) =>
	[...(section()?.querySelectorAll('button') ?? [])].find(
		(b) =>
			b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
	) as HTMLButtonElement | undefined
async function click(target: HTMLElement) {
	await act(async () => target.click())
}
/** Types into an input the way a person does: the value, then an input event. */
function type(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		'value',
	)!.set!
	act(() => {
		setter.call(input, value)
		input.dispatchEvent(new Event('input', { bubbles: true }))
	})
}

describe('Daily limits in the manager controls', () => {
	it('lists each capped dish with what is left, and what was sold or is waiting for payment', async () => {
		current = status([
			row(),
			row({
				key: 'option:o-baklava',
				kind: 'option',
				id: 'o-baklava',
				name: 'Baklava',
				remaining: 9,
				soldUnits: 3,
				heldUnits: 0,
			}),
		])
		await draw()
		const text = section()!.textContent!
		expect(text).toContain('Daily limits')
		expect(text).toContain('Lamb shank special')
		expect(text).toContain('Left: 4')
		expect(text).toContain('14 sold · 2 waiting for payment')
		expect(text).toContain('Baklava')
		expect(text).toContain('Left: 9')
		// An option says it is one.
		expect(text).toContain('Option')
	})

	it('highlights a dish that is sold out, instead of saying 0 left', async () => {
		current = status([row({ remaining: 0, soldUnits: 20, heldUnits: 0 })])
		await draw()
		const text = section()!.textContent!
		expect(text).toContain('Sold out')
		expect(text).not.toContain('Left: 0')
	})

	it('stays out of the way while the feature is off, nothing is limited, or the node is older', async () => {
		current = status([row()], false)
		await draw()
		expect(section()).toBeNull()
		current = status([])
		await draw({ open: false })
		await draw()
		expect(section()).toBeNull()
		dailyLimits.mockRejectedValue(new OrdersError('orders_unavailable', 404))
		await draw({ open: false })
		await draw()
		expect(section()).toBeNull()
		// The rest of the sheet is still there.
		expect(document.body.textContent).toContain('Online ordering here')
	})

	it('asks nothing while offline, and nothing is kept to send later', async () => {
		await draw({ online: false })
		expect(dailyLimits).not.toHaveBeenCalled()
		expect(section()).toBeNull()
	})

	it('adds 5 or 10 with the dish key, then reads the list again', async () => {
		await draw()
		expect(dailyLimits).toHaveBeenCalledTimes(1)
		await click(buttonIn('Add 5: Lamb shank special')!)
		expect(topUp).toHaveBeenLastCalledWith({
			key: 'item:i-lamb',
			addUnits: 5,
		})
		expect(dailyLimits).toHaveBeenCalledTimes(2)
		expect(section()!.textContent).toContain('Left: 9')
		await click(buttonIn('Add 10: Lamb shank special')!)
		expect(topUp).toHaveBeenLastCalledWith({
			key: 'item:i-lamb',
			addUnits: 10,
		})
		expect(dailyLimits).toHaveBeenCalledTimes(3)
		expect(section()!.textContent).toContain('Left: 19')
	})

	it('sets the amount left from a count, prefilled with what is left', async () => {
		await draw()
		await click(buttonIn('Set amount left: Lamb shank special')!)
		const input = section()!.querySelector('input') as HTMLInputElement
		expect(input.value).toBe('4')
		type(input, '7')
		await click(buttonIn('Save')!)
		expect(topUp).toHaveBeenCalledExactlyOnceWith({
			key: 'item:i-lamb',
			amountLeft: 7,
		})
		expect(dailyLimits).toHaveBeenCalledTimes(2)
		expect(section()!.textContent).toContain('Left: 7')
		// The editor closes once it was saved.
		expect(section()!.querySelector('input')).toBeNull()
	})

	it('accepts 0 as the amount left (the batch is gone)', async () => {
		await draw()
		await click(buttonIn('Set amount left: Lamb shank special')!)
		type(section()!.querySelector('input') as HTMLInputElement, '0')
		await click(buttonIn('Save')!)
		expect(topUp).toHaveBeenCalledExactlyOnceWith({
			key: 'item:i-lamb',
			amountLeft: 0,
		})
	})

	it('refuses an amount that is not a whole number in range, and sends nothing', async () => {
		await draw()
		await click(buttonIn('Set amount left: Lamb shank special')!)
		const input = section()!.querySelector('input') as HTMLInputElement
		for (const bad of ['abc', '-3', '2.5', '10001', '']) {
			type(input, bad)
			expect(buttonIn('Save')!.disabled).toBe(true)
		}
		type(input, 'abc')
		expect(section()!.querySelector('[role="alert"]')!.textContent).toContain(
			'Enter a whole number',
		)
		expect(topUp).not.toHaveBeenCalled()
	})

	it('says only a manager can change it, and shows what is true now', async () => {
		topUp.mockRejectedValueOnce(new OrdersError('permission_required', 403))
		await draw()
		await click(buttonIn('Add 5: Lamb shank special')!)
		expect(section()!.querySelector('[role="alert"]')!.textContent).toContain(
			'Only a manager can change this.',
		)
		// Read again whatever happened.
		expect(dailyLimits).toHaveBeenCalledTimes(2)
	})

	it('never claims a write that may have gone through did not', async () => {
		topUp.mockRejectedValueOnce(new OrdersError('connection_lost'))
		await draw()
		await click(buttonIn('Add 5: Lamb shank special')!)
		expect(section()!.querySelector('[role="alert"]')!.textContent).toContain(
			'That may not have gone through',
		)
		expect(dailyLimits).toHaveBeenCalledTimes(2)
	})

	it('words a dish that lost its limit meanwhile', async () => {
		topUp.mockRejectedValueOnce(new OrdersError('daily_limit_not_found', 404))
		await draw()
		await click(buttonIn('Add 10: Lamb shank special')!)
		expect(section()!.querySelector('[role="alert"]')!.textContent).toContain(
			'no longer has a daily limit',
		)
	})

	it('forgets the last opening when the sheet closes', async () => {
		await draw()
		expect(section()).not.toBeNull()
		current = status([])
		await draw({ open: false })
		await draw()
		expect(section()).toBeNull()
	})
})

describe('the amount left a manager types', () => {
	it('is a whole number from 0 to the most the region takes', () => {
		expect(parseAmountLeft('0')).toBe(0)
		expect(parseAmountLeft(' 12 ')).toBe(12)
		expect(parseAmountLeft('10000')).toBe(10_000)
		expect(parseAmountLeft('10001')).toBeNull()
		for (const bad of ['', 'x', '1.5', '-1', '1e3', '١٢']) {
			expect(parseAmountLeft(bad), bad).toBeNull()
		}
	})
})
