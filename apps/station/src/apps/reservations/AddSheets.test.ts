// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { createElement as h, act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JoinWaitlistSheet, WalkInSheet } from './AddSheets.tsx'
import { findLateGuests } from './lookup.ts'
import { at, MIN, rsv } from './testing.ts'

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

const NOW = at(13 * 60 + 30)
const fmt = new Intl.DateTimeFormat('en', {
	hour: 'numeric',
	minute: '2-digit',
	timeZone: 'UTC',
})
const formatTime = (ms: number) => fmt.format(ms)

const guest = (first: string, last: string) => ({
	id: `g-${first}`,
	name: `${first} ${last}`,
	firstName: first,
	lastName: last,
	phone: null,
})
const reservations = [
	rsv({
		start: 12 * 60 + 55,
		status: 'confirmed',
		partySize: 2,
		guest: guest('Yusuf', 'Barakat'),
	}),
	rsv({
		start: 12 * 60 + 40,
		status: 'no_show',
		partySize: 3,
		noShowAt: NOW - 6 * MIN,
		guest: guest('Mariam', 'Qadri'),
	}),
]
const lateGuests = (typed: string) =>
	findLateGuests(reservations, typed, NOW, 30 * MIN)

const dialog = () => host.querySelector('dialog')!
const text = () => dialog().textContent ?? ''
const type = (el: HTMLInputElement, value: string) =>
	act(async () => {
		const set = Object.getOwnPropertyDescriptor(
			Object.getPrototypeOf(el),
			'value',
		)!.set!
		set.call(el, value)
		el.dispatchEvent(new Event('input', { bubbles: true }))
	})
const nameField = () =>
	[...dialog().querySelectorAll('label')]
		.find((label) => /Name/.test(label.textContent ?? ''))!
		.querySelector('input') as HTMLInputElement

describe('a walk-in who has a booking', () => {
	type Props = ComponentProps<typeof WalkInSheet>
	const draw = (over: Partial<Props> = {}) =>
		// eslint-disable-next-line testing-library/no-unnecessary-act
		act(() => {
			root.render(
				h(
					I18nProvider,
					{ i18n },
					h(WalkInSheet, {
						open: true,
						lateGuests,
						formatTime,
						onUseLate: () => undefined,
						onPlace: () => undefined,
						onClose: () => undefined,
						...over,
					}),
				),
			)
		})
	it('offers nothing before a name is typed', () => {
		draw()
		expect(text()).not.toContain('Already booked?')
	})
	it('offers a late party whose name the typed letters start, and seats their booking', async () => {
		const onUseLate = vi.fn()
		draw({ onUseLate })
		await type(nameField(), 'yus')
		expect(text()).toContain('Seat Yusuf B. (booked 12:55 PM)')
		expect(text()).toContain('Party of 2, not here yet.')
		const row = [...dialog().querySelectorAll('button')].find((b) =>
			b.textContent?.includes('Seat Yusuf B.'),
		)!
		act(() => row.click())
		expect(onUseLate).toHaveBeenCalledTimes(1)
		expect(onUseLate.mock.calls[0]![0]).toMatchObject({
			kind: 'seat',
			reservation: { id: reservations[0]!.id },
		})
	})
	it('says a no-show is one, and offers to take it back', async () => {
		draw()
		await type(nameField(), 'mar')
		expect(text()).toContain('Seat Mariam Q. (booked 12:40 PM)')
		expect(text()).toContain(
			'Party of 3, marked as a no-show. Taken back first.',
		)
	})
	it('says an older no-show is marked here first, which the server may refuse', async () => {
		const old = rsv({
			start: 11 * 60,
			status: 'no_show',
			partySize: 2,
			noShowAt: NOW - 100 * MIN,
			guest: guest('Faisal', 'Rahman'),
		})
		draw({
			lateGuests: (typed) => findLateGuests([old], typed, NOW, 30 * MIN),
		})
		await type(nameField(), 'fai')
		expect(text()).toContain('Seat Faisal R. (booked 11:00 AM)')
		expect(text()).toContain(
			'Party of 2, marked as a no-show. Marked here, then seated.',
		)
	})
	it('offers nothing for a name nobody booked under', async () => {
		draw()
		await type(nameField(), 'zed')
		expect(text()).not.toContain('Already booked?')
	})
	it('offers nothing when the stand has no late guests to look through', async () => {
		draw({ lateGuests: undefined })
		await type(nameField(), 'yus')
		expect(text()).not.toContain('Already booked?')
	})
})

describe('a party added to the waitlist', () => {
	type Props = ComponentProps<typeof JoinWaitlistSheet>
	const draw = (over: Partial<Props> = {}) =>
		// eslint-disable-next-line testing-library/no-unnecessary-act
		act(() => {
			root.render(
				h(
					I18nProvider,
					{ i18n },
					h(JoinWaitlistSheet, {
						open: true,
						busy: false,
						loadQuote: async () => ({ quotedMin: 35, position: 4 }),
						lateGuests,
						formatTime,
						onUseLate: () => undefined,
						onJoin: () => undefined,
						onClose: () => undefined,
						...over,
					}),
				),
			)
		})
	it('also finds a late guest by name', async () => {
		draw()
		await type(nameField(), 'yus')
		expect(text()).toContain('Seat Yusuf B. (booked 12:55 PM)')
	})
	it('starts with the size of a party that found no table', async () => {
		draw({ prefill: { displayName: 'Walk-in', phone: '', partySize: 9 } })
		await act(async () => undefined)
		const selected = [...dialog().querySelectorAll('button')].filter(
			(b) => b.getAttribute('aria-pressed') === 'true',
		)
		expect(selected.map((b) => b.textContent?.trim())).toContain('9+')
		expect(text()).toContain('9')
		expect(nameField().value).toBe('Walk-in')
	})
})
