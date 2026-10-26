// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { createElement as h, act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tableState } from './feed.ts'
import { TableSheet } from './TableSheet.tsx'
import { at, day, MIN, rsv } from './testing.ts'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
	HTMLDialogElement.prototype.showModal = function showModal() {
		this.setAttribute('open', '')
	}
	HTMLDialogElement.prototype.close = function close() {
		this.removeAttribute('open')
	}
})

const NOW = at(13 * 60)
let host: HTMLDivElement
let root: Root
beforeEach(() => {
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
})

const fmt = new Intl.DateTimeFormat('en', {
	hour: 'numeric',
	minute: '2-digit',
	timeZone: 'UTC',
})
type Props = ComponentProps<typeof TableSheet>

/** The sheet for Table 2 (it seats up to four) with these bookings on the day. */
function sheet(
	reservations: ReturnType<typeof rsv>[],
	over: Partial<Props> = {},
	extra: Partial<Record<string, unknown>> = {},
) {
	const feed = day(reservations, extra)
	const table = feed.tables.find((t) => t.id === 't2')!
	const props: Props = {
		target: { table, state: tableState(table, feed, NOW) },
		busy: false,
		now: NOW,
		formatTime: (ms) => fmt.format(ms),
		onWalkIn: () => undefined,
		onSeatHeld: () => undefined,
		onFinish: () => undefined,
		onDetails: () => undefined,
		onClose: () => undefined,
		...over,
	}
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => {
		root.render(h(I18nProvider, { i18n }, h(TableSheet, props)))
	})
}
const dialog = () => host.querySelector('dialog')!
const buttons = () =>
	[...dialog().querySelectorAll('button')]
		.map((b) => b.textContent?.trim() ?? '')
		.filter(Boolean)
const has = (label: string | RegExp) =>
	buttons().some((text) =>
		typeof label === 'string' ? text === label : label.test(text),
	)
const press = (label: string | RegExp) =>
	act(() => {
		const target = [...dialog().querySelectorAll('button')].find((b) =>
			typeof label === 'string'
				? b.textContent?.trim() === label
				: label.test(b.textContent?.trim() ?? ''),
		)
		if (!target) throw new Error(`no button ${String(label)}`)
		target.click()
	})
const hasText = (text: string) => dialog().textContent?.includes(text) ?? false

const held = (start: number, status: string, over = {}) =>
	rsv({
		start,
		status,
		tableIds: ['t2'],
		tableLabels: ['2'],
		partySize: 3,
		guest: {
			id: 'g',
			name: 'Rana Khalid',
			firstName: 'Rana',
			lastName: 'Khalid',
		},
		...over,
	})

describe('a table held for a party', () => {
	it('leads with seating them when they are at the stand', () => {
		sheet([held(13 * 60 - 5, 'arrived')])
		expect(has(/^Seat Rana K\. here$/)).toBe(true)
		expect(has('Seat a walk-in anyway')).toBe(true)
		// The walk-in is behind its own tap.
		expect(has(/^Seat \d+ now$/)).toBe(false)
	})
	it('leads with seating them when they are late', () => {
		sheet([held(13 * 60 - 10, 'confirmed')])
		expect(has(/^Seat Rana K\. here$/)).toBe(true)
		expect(has('Seat a walk-in anyway')).toBe(true)
	})
	it('leads with seating a party that is only due when a walk-in would run into them, and warns on the walk-in', () => {
		const seated = vi.fn()
		const walkIn = vi.fn()
		sheet([held(13 * 60 + 20, 'booked')], {
			onSeatHeld: seated,
			onWalkIn: walkIn,
		})
		// The table is free for 20 minutes: a walk-in is given a turn of 90.
		const free = /^Seat \d+ · free 20 min$/
		expect(has(free)).toBe(true)
		expect(has('Seat a walk-in anyway')).toBe(false)
		expect(has(/^Seat Rana K\. here$/)).toBe(true)
		expect(hasText('is due at 1:20 PM. A walk-in here may delay them.')).toBe(
			true,
		)
		// The party comes first, the walk-in (in a warning style) second.
		const order = buttons()
		expect(order.findIndex((t) => /^Seat Rana K\. here$/.test(t))).toBeLessThan(
			order.findIndex((t) => free.test(t)),
		)
		const walkInButton = [...dialog().querySelectorAll('button')].find((b) =>
			free.test(b.textContent?.trim() ?? ''),
		)!
		expect(walkInButton.className).toContain('text-warning')
		press(/^Seat Rana K\. here$/)
		expect(seated).toHaveBeenCalledTimes(1)
		press(free)
		expect(walkIn).toHaveBeenCalledWith(
			expect.objectContaining({ id: 't2' }),
			2,
		)
	})
	it('says how long the table is free on the walk-in button, with no warning when the stay fits', () => {
		// Booked 100 minutes from now: not a held table, free for longer than a turn.
		sheet([held(13 * 60 + 100, 'booked')])
		const fits = [...dialog().querySelectorAll('button')].find((b) =>
			/^Seat \d+ · free 100 min$/.test(b.textContent?.trim() ?? ''),
		)!
		expect(fits).toBeDefined()
		expect(fits.className).not.toContain('text-warning')
		expect(has(/^Seat Rana K\. here$/)).toBe(false)
	})
	it('says nothing of how long it is free when nothing is booked, or not for hours', () => {
		sheet([])
		expect(has(/^Seat \d+ now$/)).toBe(true)
		sheet([held(13 * 60 + 5 * 60, 'booked')])
		expect(has(/^Seat \d+ now$/)).toBe(true)
	})
	it('says a table is big for a small party', () => {
		sheet([])
		expect(hasText('leaves it mostly empty')).toBe(false)
		press('1')
		expect(
			hasText('This table seats 4: a party of 1 leaves it mostly empty.'),
		).toBe(true)
	})
	it('leads with the walk-in, and has no "Seat here", for a party the till cannot seat', () => {
		sheet([held(13 * 60 - 10, 'pending_payment')])
		expect(has(/^Seat \d+ now$/)).toBe(true)
		expect(has(/^Seat Rana K\. here$/)).toBe(false)
	})
})

describe('a table being reset', () => {
	it('says when it is ready, and can still be given a walk-in (the stand asks first)', () => {
		const left = rsv({
			start: 11 * 60,
			status: 'finished',
			tableIds: ['t2'],
			tableLabels: ['2'],
			finishedAt: NOW - 4 * MIN,
		})
		sheet(
			[left],
			{},
			{
				tables: [
					{
						id: 't2',
						areaId: 'a1',
						label: '2',
						minCovers: 1,
						maxCovers: 4,
						resetBufferMin: 10,
					},
				],
			},
		)
		expect(hasText('Resetting, ready 1:06 PM')).toBe(true)
		expect(hasText('6 min left. Seating someone now asks first.')).toBe(true)
		expect(has(/^Seat \d+ now$/)).toBe(true)
	})
})
