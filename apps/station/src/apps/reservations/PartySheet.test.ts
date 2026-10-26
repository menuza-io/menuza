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
				'Confirm',
				'Size or time',
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
				'Party size',
				'Move table',
				'+15 min',
			]),
		)
		expect(has('Size or time')).toBe(false)
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
		press('Party size')
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

describe('a party that is only partly here', () => {
	const press = (label: string | RegExp) =>
		act(() => {
			const target = [...dialog().querySelectorAll('button')].find((b) => {
				const words =
					b.getAttribute('aria-label') ?? b.textContent?.trim() ?? ''
				return typeof label === 'string' ? words === label : label.test(words)
			})
			if (!target) throw new Error(`no button ${String(label)}`)
			target.click()
		})
	const group = () =>
		dialog().querySelector('[role="group"][aria-label="Some are here"]')

	it('offers to mark some of a booked party here, starting at all but one', () => {
		const onCommand = vi.fn()
		const r = booking('booked', { partySize: 5 })
		draw({ r, onCommand })
		expect(group()).not.toBeNull()
		expect(hasText('4 of 5')).toBe(true)
		press('One fewer')
		expect(hasText('3 of 5')).toBe(true)
		press('Mark 3 here')
		// The server has no partial status: it is `arrived` with the count.
		expect(onCommand).toHaveBeenCalledWith(r, {
			kind: 'status',
			to: 'arrived',
			arrivedCovers: 3,
		})
		// Not yet at the stand: nothing to seat now.
		expect(has(/^Seat \d now$/)).toBe(false)
	})
	it('never goes below one, nor up to the whole party', () => {
		draw({ r: booking('booked', { partySize: 3 }) })
		for (let i = 0; i < 5; i += 1) press('One fewer')
		expect(hasText('1 of 3')).toBe(true)
		for (let i = 0; i < 5; i += 1) press('One more')
		expect(hasText('2 of 3')).toBe(true)
	})
	it('says how many are here, and seats the ones who are, with a stepper', () => {
		const onCommand = vi.fn()
		const r = booking('arrived', { partySize: 5, arrivedCovers: 3 })
		draw({ r, onCommand })
		expect(hasText('3 of 5 here')).toBe(true)
		// One badge for it, not "At the stand" as well.
		expect(hasText('At the stand')).toBe(false)
		// The count cannot be marked again: there is no step for it.
		expect(group()).toBeNull()
		// The plain seating is for a party that is all here.
		expect(has('Choose a table')).toBe(false)
		press('Seat 3 now')
		expect(onCommand).toHaveBeenCalledWith(r, { kind: 'seatPart', covers: 3 })
	})
	it('lets more sit than the count said, up to the whole party, but never fewer than one', () => {
		const onCommand = vi.fn()
		const r = booking('arrived', { partySize: 5, arrivedCovers: 3 })
		draw({ r, onCommand })
		press('One more')
		press('One more')
		press('One more')
		expect(has('Seat 5 now')).toBe(true)
		press('Seat 5 now')
		expect(onCommand).toHaveBeenLastCalledWith(r, {
			kind: 'seatPart',
			covers: 5,
		})
		for (let i = 0; i < 9; i += 1) press('One fewer')
		expect(has('Seat 1 now')).toBe(true)
	})
	it('seats a party that is all here the plain way, with no stepper', () => {
		draw({ r: booking('arrived', { partySize: 5, arrivedCovers: 5 }) })
		expect(has('Choose a table')).toBe(true)
		expect(has(/^Seat \d now$/)).toBe(false)
	})
	it('has no way to say they are all here once some are: nothing to press for it', () => {
		draw({ r: booking('arrived', { partySize: 5, arrivedCovers: 3 }) })
		expect(has('They’re all here')).toBe(false)
		expect(has('They’re here')).toBe(false)
	})
	it('says "seated 3 of 5" for a party that sat down short of its size, with nothing more to seat', () => {
		const r = booking('seated', {
			partySize: 5,
			seatedCovers: 3,
			arrivedCovers: 5,
			seatedAt: NOW - 10 * MIN,
			tableIds: ['t3'],
			tableLabels: ['3'],
		})
		draw({ r })
		expect(hasText('seated 3 of 5')).toBe(true)
		expect(has('Choose a table')).toBe(false)
		expect(has(/^Seat /)).toBe(false)
		expect(has('Finished, clear table')).toBe(true)
	})
	it('is not offered for a party of one, a party that is seated, or another day', () => {
		draw({ r: booking('booked', { partySize: 1 }) })
		expect(group()).toBeNull()
		draw({ r: booking('seated', { partySize: 4 }) })
		expect(group()).toBeNull()
		draw({ r: booking('booked', { partySize: 4 }), viewOnly: true })
		expect(group()).toBeNull()
	})
})

describe('a longer stay', () => {
	it('is not offered for a booking with money on it, or an experience', () => {
		draw({ r: booking('seated', { paymentStatus: 'paid' }) })
		expect(has('+15 min')).toBe(false)
		draw({ r: booking('seated', { experienceId: 'exp_1' }) })
		expect(has('+15 min')).toBe(false)
		draw({ r: booking('seated') })
		expect(has('+15 min')).toBe(true)
	})
})
