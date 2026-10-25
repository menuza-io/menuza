// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { createElement as h, act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTE_MAX } from './booking.ts'
import { BookingSheet, type BookingPrefill } from './BookingSheet.tsx'
import { type Availability } from './feed.ts'
import { type Repeat } from './lookup.ts'
import { rsv } from './testing.ts'

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

const TODAY = '2026-03-02'
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

/** Open slots for a party: 6:00 PM, 7:00 PM and 8:00 PM, 8:00 PM only for two or three. */
const slotsFor = (size: number): Availability => ({
	businessDate: TODAY,
	closed: false,
	slots: [18 * 60, 19 * 60, 20 * 60].map((min) => ({
		localStartMin: min,
		time: `${Math.floor(min / 60)}:00`,
		available: min !== 20 * 60 || size <= 3,
		suggestedTableIds: [],
	})),
})

type Props = ComponentProps<typeof BookingSheet>
const base = (over: Partial<Props> = {}): Props => ({
	open: true,
	busy: false,
	locked: false,
	readBack: null,
	today: TODAY,
	prefill: null,
	loadSlots: async (_date, size) => slotsFor(size),
	repeatOf: () => null,
	checkedDay: TODAY,
	onOpenRepeat: () => undefined,
	formatTime: (ms) => String(ms),
	onBook: () => undefined,
	onClose: () => undefined,
	...over,
})

// React's own `act` around a root, not Testing Library's.
async function draw(props: Props) {
	// eslint-disable-next-line testing-library/no-unnecessary-act
	await act(async () => {
		root.render(h(I18nProvider, { i18n }, h(BookingSheet, props)))
	})
}
const dialog = () => host.querySelector('dialog')!
const button = (label: string | RegExp) =>
	[...dialog().querySelectorAll('button')].find((b) =>
		typeof label === 'string'
			? b.textContent?.trim() === label
			: label.test(b.textContent?.trim() ?? ''),
	)
const press = (label: string | RegExp) =>
	act(async () => {
		const target = button(label)
		if (!target) throw new Error(`no button "${String(label)}"`)
		target.click()
	})
const pressed = (label: string) => button(label)?.getAttribute('aria-pressed')
const hasText = (text: string) => dialog().textContent?.includes(text) ?? false
const field = (name: RegExp) =>
	[...dialog().querySelectorAll('label')]
		.find((label) => name.test(label.textContent ?? ''))!
		.querySelector('input, textarea') as HTMLInputElement
/** Types into a field the way a person does (React listens to the input event). */
const type = (el: HTMLInputElement, value: string) =>
	act(async () => {
		const set = Object.getOwnPropertyDescriptor(
			Object.getPrototypeOf(el),
			'value',
		)!.set!
		set.call(el, value)
		el.dispatchEvent(new Event('input', { bubbles: true }))
	})

const prefill = (over: Partial<BookingPrefill> = {}): BookingPrefill => ({
	date: TODAY,
	tableIds: [],
	tableLabel: '',
	maxCovers: 0,
	...over,
})

describe('the booking form is not started over by a redraw', () => {
	it('keeps what was typed when drawn again with the same prefill', async () => {
		const one = prefill({ guest: { first: 'Rana', last: '', phone: '' } })
		await draw(base({ prefill: one }))
		await type(field(/First name/), 'Rana Khalid')
		await draw(base({ prefill: one }))
		expect(field(/First name/).value).toBe('Rana Khalid')
		// An equal copy of it (a new object with the same content) is the same start.
		await draw(base({ prefill: structuredClone(one) }))
		expect(field(/First name/).value).toBe('Rana Khalid')
	})
	it('starts over for a prefill that is different', async () => {
		await draw(
			base({
				prefill: prefill({ guest: { first: 'A', last: '', phone: '' } }),
			}),
		)
		await type(field(/First name/), 'Typed')
		await draw(
			base({
				prefill: prefill({ guest: { first: 'B', last: '', phone: '' } }),
			}),
		)
		expect(field(/First name/).value).toBe('B')
	})
})

describe('the time the host picked', () => {
	it('survives a change of party size while it is still open', async () => {
		await draw(base())
		await press('7:00 PM')
		expect(pressed('7:00 PM')).toBe('true')
		await press('4')
		expect(pressed('4')).toBe('true')
		expect(pressed('7:00 PM')).toBe('true')
		expect(hasText('is not open')).toBe(false)
		await type(field(/First name/), 'Rana')
		expect(button(/^Book 4 at 7:00 PM/)).toBeDefined()
	})
	it('says it is not open when the new size has no room then, and picks nothing', async () => {
		await draw(base())
		await press('8:00 PM')
		expect(pressed('8:00 PM')).toBe('true')
		await press('4')
		expect(button('8:00 PM')).toBeUndefined()
		expect(hasText('8:00 PM is not open for 4. Choose another time.')).toBe(
			true,
		)
		expect(button(/^Choose a time/)).toBeDefined()
		// Going back to a size with room finds the time again.
		await press('2')
		expect(pressed('8:00 PM')).toBe('true')
		expect(hasText('is not open')).toBe(false)
	})
	it('is the one picked last, not the one the form began with', async () => {
		await draw(base({ prefill: prefill({ startMin: 18 * 60 }) }))
		expect(pressed('6:00 PM')).toBe('true')
		await press('7:00 PM')
		await press('3')
		expect(pressed('7:00 PM')).toBe('true')
		expect(pressed('6:00 PM')).toBe('false')
	})
})

describe('"Open it" on a repeat booking', () => {
	const existing = rsv({
		start: 13 * 60,
		status: 'booked',
		guest: {
			id: 'g',
			name: 'Rana Khalid',
			firstName: 'Rana',
			lastName: 'Khalid',
		},
	})
	const repeat: Repeat = { kind: 'booking', reservation: existing }
	const found = { repeatOf: () => repeat }

	it('asks before it throws away what was typed, and keeps the form on "Keep editing"', async () => {
		const onOpenRepeat = vi.fn()
		await draw(base({ ...found, onOpenRepeat }))
		await type(field(/First name/), 'Rana')
		await press('Open it')
		expect(onOpenRepeat).not.toHaveBeenCalled()
		expect(hasText('Discard this booking?')).toBe(true)
		await press('Keep editing')
		expect(onOpenRepeat).not.toHaveBeenCalled()
		expect(field(/First name/).value).toBe('Rana')
	})
	it('opens it after "Discard"', async () => {
		const onOpenRepeat = vi.fn()
		const onClose = vi.fn()
		await draw(base({ ...found, onOpenRepeat, onClose }))
		await type(field(/First name/), 'Rana')
		await press('Open it')
		await press('Discard')
		expect(onOpenRepeat).toHaveBeenCalledTimes(1)
		expect(onOpenRepeat).toHaveBeenCalledWith(repeat)
		expect(onClose).not.toHaveBeenCalled()
	})
	it('opens it at once when the form holds only what it started with', async () => {
		const onOpenRepeat = vi.fn()
		await draw(
			base({
				...found,
				onOpenRepeat,
				prefill: prefill({
					guest: { first: 'Rana', last: 'Khalid', phone: '' },
				}),
			}),
		)
		await press('Open it')
		expect(onOpenRepeat).toHaveBeenCalledTimes(1)
		expect(hasText('Discard this booking?')).toBe(false)
	})
	it('does not leave a pending "open" behind when the host keeps editing and later closes', async () => {
		const onOpenRepeat = vi.fn()
		const onClose = vi.fn()
		await draw(base({ ...found, onOpenRepeat, onClose }))
		await type(field(/First name/), 'Rana')
		await press('Open it')
		await press('Keep editing')
		// Now close the sheet by the close button and discard: that closes, it does not open the repeat.
		await act(async () => {
			dialog()
				.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
				.click()
		})
		await press('Discard')
		expect(onOpenRepeat).not.toHaveBeenCalled()
		expect(onClose).toHaveBeenCalledTimes(1)
	})
})

describe('quick notes', () => {
	it('say so when the note is full, and leave what was typed exactly as it was', async () => {
		await draw(base())
		const typed = `Allergic;  to figs${'x'.repeat(NOTE_MAX - 18)}`
		await type(field(/Note for the team/), typed)
		expect(typed).toHaveLength(NOTE_MAX)
		await press('Quiet')
		expect(field(/Note for the team/).value).toBe(typed)
		expect(hasText(`The note is full (${NOTE_MAX} characters)`)).toBe(true)
		// Typing again clears it.
		await type(field(/Note for the team/), typed.slice(0, 100))
		expect(hasText('The note is full')).toBe(false)
	})
	it('add and take back a phrase without rewriting the rest', async () => {
		await draw(base())
		await type(field(/Note for the team/), 'wants  the corner;  cake')
		await press('Quiet')
		expect(field(/Note for the team/).value).toBe(
			'wants  the corner;  cake, Quiet',
		)
		await press('Quiet')
		expect(field(/Note for the team/).value).toBe('wants  the corner;  cake')
	})
})

describe('the duplicate check', () => {
	it('says plainly that it covers today only, when the day picked is another', async () => {
		await draw(base({ checkedDay: TODAY }))
		await type(field(/First name/), 'Rana')
		expect(hasText('Duplicates are checked')).toBe(false)
		const tomorrow = field(/First name/)
			.closest('dialog')!
			.querySelector('input[type="date"]')
		expect(tomorrow).toBeNull()
		await press('Tomorrow')
		expect(hasText('Duplicates are checked for today only.')).toBe(true)
	})
	it('names the day when the stand has loaded another day', async () => {
		await draw(
			base({
				checkedDay: '2026-03-03',
				prefill: prefill({ date: '2026-03-03' }),
			}),
		)
		await type(field(/First name/), 'Rana')
		expect(hasText('Duplicates are checked')).toBe(false)
		await press('Today')
		expect(hasText('Duplicates are checked for Tue, Mar 3 only.')).toBe(true)
	})
	it('says nothing before a name or number is typed', async () => {
		await draw(base({ checkedDay: TODAY }))
		await press('Tomorrow')
		expect(hasText('Duplicates are checked')).toBe(false)
	})
})
