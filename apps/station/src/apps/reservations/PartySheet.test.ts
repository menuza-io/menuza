// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { createElement as h, act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DayReservation } from './feed.ts'
import { PartySheet } from './PartySheet.tsx'
import { type PartyCommand } from './sheets.tsx'
import { at, MIN, rsv } from './testing.ts'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no modal dialog: the sheet only needs `open` to be set.
beforeEach(() => {
	HTMLDialogElement.prototype.showModal = function showModal() {
		this.setAttribute('open', '')
	}
	HTMLDialogElement.prototype.close = function close() {
		this.removeAttribute('open')
	}
})

const NOW = at(13 * 60 + 30)
const fmt = new Intl.DateTimeFormat('en', {
	hour: 'numeric',
	minute: '2-digit',
	timeZone: 'UTC',
})
const formatTime = (ms: number) => fmt.format(ms)
const formatDay = (ms: number) =>
	new Intl.DateTimeFormat('en', {
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC',
	}).format(ms)

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

type Props = {
	r: DayReservation | null
	viewOnly?: boolean
	canReadGuest?: boolean
	now?: number
	tableKindOf?: (id: string) => 'open' | 'seated' | 'blocked' | null
	onCommand?: (r: DayReservation, command: PartyCommand) => void
}

// React's own `act` around a root, not Testing Library's.
function draw(props: Props) {
	const element: ReactElement = h(
		I18nProvider,
		{ i18n },
		h(PartySheet, {
			reservation: props.r,
			viewOnly: props.viewOnly ?? false,
			canReadGuest: props.canReadGuest ?? true,
			busy: false,
			now: props.now ?? NOW,
			formatTime,
			formatDay,
			tableKindOf: props.tableKindOf,
			onCommand: props.onCommand ?? (() => undefined),
			onClose: () => undefined,
		}),
	)
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(element))
}

const dialog = () => host.querySelector('dialog')!
/** The words on each button of the sheet. */
const buttons = () =>
	[...dialog().querySelectorAll('button')]
		.map((button) => button.textContent?.trim() ?? '')
		.filter(Boolean)
const has = (label: string | RegExp) =>
	buttons().some((text) =>
		typeof label === 'string' ? text === label : label.test(text),
	)
const hasText = (text: string) => dialog().textContent?.includes(text) ?? false
const links = () =>
	[...dialog().querySelectorAll('a[href]')].map((a) => a.getAttribute('href')!)

const guest = (over: Record<string, unknown> = {}) => ({
	id: 'g1',
	name: 'Rana Khalid',
	firstName: 'Rana',
	lastName: 'Khalid',
	phone: '+966551234567',
	...over,
})
const booking = (status: string, over: Record<string, unknown> = {}) =>
	rsv({
		start: 13 * 60,
		status,
		guest: guest(),
		seatedAt: status === 'seated' ? NOW - 40 * MIN : null,
		...over,
	})

const STATUSES = [
	'booked',
	'confirmed',
	'arrived',
	'seated',
	'finished',
	'no_show',
	'cancelled',
	'pending_payment',
] as const
const PAYMENTS = ['none', 'paid', 'guaranteed', 'refund_pending'] as const

describe('the party sheet, over status, day, grant and payment', () => {
	for (const status of STATUSES)
		for (const viewOnly of [false, true])
			for (const canReadGuest of [true, false])
				for (const paymentStatus of PAYMENTS) {
					const name = `${status} / ${viewOnly ? 'another day' : 'today'} / ${canReadGuest ? 'guest grant' : 'no grant'} / payment ${paymentStatus}`
					it(name, () => {
						const r = booking(status, { paymentStatus })
						draw({ r, viewOnly, canReadGuest, now: NOW + 40 * MIN })
						const paid = paymentStatus !== 'none'
						const live = ['booked', 'confirmed', 'arrived', 'seated'].includes(
							status,
						)

						// Money is a manager's: no size change, cancel or no-show, and a line that says so.
						if (paid) {
							expect(has(/^Change (party )?size/)).toBe(false)
							expect(has('Cancel booking')).toBe(false)
							expect(has('No-show')).toBe(false)
						}
						if (paid && live)
							expect(
								hasText('A manager handles this booking: it has a deposit.'),
							).toBe(true)
						else expect(hasText('A manager handles this booking')).toBe(false)

						// Another day seats nobody and moves nobody.
						if (viewOnly) {
							for (const label of [
								'Choose a table',
								'Finished, clear table',
								'They’re here',
								'Move table',
								'+15 min',
							])
								expect(has(label)).toBe(false)
							expect(has(/^Seat at Table/)).toBe(false)
						}

						// Without the grant there is nothing to dial: no tel: and no sms: link, ever.
						if (!canReadGuest)
							expect(
								links().filter((href) => /^(tel|sms):/.test(href)),
							).toEqual([])
						else if (r.guest?.phone) {
							expect(links()).toContain('tel:+966551234567')
							expect(links()).toContain('sms:+966551234567')
						}
					})
				}

	it('offers a booked party today the steps in order, and a way to end it', () => {
		draw({ r: booking('booked'), now: NOW + 30 * MIN })
		expect(buttons()).toEqual(
			expect.arrayContaining([
				'Choose a table',
				'They’re here',
				'Mark confirmed',
				'Change size or time',
				'No-show',
				'Cancel booking',
			]),
		)
		expect(has('Move table')).toBe(false)
	})

	it('offers a seated party their table’s own steps', () => {
		draw({ r: booking('seated') })
		expect(buttons()).toEqual(
			expect.arrayContaining([
				'Finished, clear table',
				'Change party size',
				'Move table',
				'+15 min',
			]),
		)
		expect(has('Change size or time')).toBe(false)
		// Undoing a seating is only for the first half hour.
		expect(has('Undo seating')).toBe(false)
		draw({ r: booking('seated', { seatedAt: NOW - 5 * MIN }) })
		expect(has('Undo seating')).toBe(true)
	})

	it('sends the command each button stands for', () => {
		const sent: string[] = []
		draw({
			r: booking('seated'),
			onCommand: (_r, command) => sent.push(command.kind),
		})
		const press = (label: string) =>
			act(() =>
				[...dialog().querySelectorAll('button')]
					.find((b) => b.textContent?.trim() === label)!
					.click(),
			)
		press('Move table')
		press('+15 min')
		press('Change party size')
		expect(sent).toEqual(['move', 'extend', 'change'])
	})

	it('says where the stay stands: how long, and when the table should clear', () => {
		// Seated 40 minutes ago for a 90 minute stay that began at 1:00 PM: due 2:30 PM.
		draw({ r: booking('seated') })
		expect(hasText('Seated 40 min, expected clear about 2:30 PM')).toBe(true)
	})

	it('says so once they are over their time', () => {
		draw({ r: booking('seated'), now: at(14 * 60 + 42) })
		expect(hasText('12 min over (expected clear 2:30 PM)')).toBe(true)
	})

	it('offers one tap to the booked table only while it is free', () => {
		const arrived = booking('arrived', {
			tableIds: ['t3'],
			tableLabels: ['3'],
		})
		draw({ r: arrived, tableKindOf: () => 'open' })
		expect(has('Seat at Table 3')).toBe(true)
		draw({ r: arrived, tableKindOf: () => 'seated' })
		expect(has(/^Seat at Table/)).toBe(false)
		expect(has('Choose a table')).toBe(true)
		draw({ r: arrived, tableKindOf: () => 'blocked' })
		expect(has(/^Seat at Table/)).toBe(false)
	})

	describe('the allergy banner', () => {
		const note = () =>
			dialog().querySelector('[role="note"]')?.textContent ?? ''
		it('warns for a coded allergen, to whoever is signed in', () => {
			for (const canReadGuest of [true, false]) {
				draw({
					r: booking('booked', {
						hasAllergy: true,
						dietaryCodes: ['shellfish_allergy'],
					}),
					canReadGuest,
				})
				expect(note()).toContain('Allergy: shellfish')
			}
		})
		it('shows a diet as a quiet line, never a warning, for a manager', () => {
			draw({
				r: booking('booked', {
					hasAllergy: true,
					dietaryCodes: ['vegan'],
					dietaryNotes: 'vegan',
				}),
				canReadGuest: true,
			})
			expect(hasText('Dietary: Vegan')).toBe(true)
			expect(hasText('Allergy')).toBe(false)
			expect(dialog().querySelector('[role="note"]')).toBeNull()
		})
		it('says a dietary note is on file, not an allergy, to someone who cannot read it', () => {
			draw({
				r: booking('booked', { hasAllergy: true, dietaryNotes: 'Peanuts' }),
				canReadGuest: false,
			})
			expect(
				hasText('Dietary note on file. A manager can see the details.'),
			).toBe(true)
			expect(hasText('Allergy')).toBe(false)
			expect(hasText('Peanuts')).toBe(false)
		})
		it('reads out allergy text to a manager', () => {
			draw({
				r: booking('booked', {
					hasAllergy: true,
					guest: guest({ allergyNotes: 'Peanuts, severe' }),
				}),
				canReadGuest: true,
			})
			expect(note()).toContain('Allergy: Peanuts, severe')
		})
		it('says nothing when there is no flag', () => {
			draw({ r: booking('booked') })
			expect(dialog().querySelector('[role="note"]')).toBeNull()
			expect(hasText('Dietary')).toBe(false)
		})
	})

	it('shows the masked number as it came, and no call or text, without the grant', () => {
		draw({
			r: booking('booked', { guest: guest({ phone: '••••4567' }) }),
			canReadGuest: false,
		})
		expect(hasText('••••4567')).toBe(true)
		expect(links()).toEqual([])
	})
})

describe('a sheet that was never asked to open', () => {
	it('draws nothing for no booking', () => {
		const onCommand = vi.fn()
		draw({ r: null, onCommand })
		expect(host.querySelector('dialog')).toBeNull()
		expect(onCommand).not.toHaveBeenCalled()
	})
})
