// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { createElement as h, act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { earlyArrival, type EarlyArrival } from './arrival.ts'
import { bookList } from './book.ts'
import { BookPanel } from './BookPanel.tsx'
import { type DayReservation } from './feed.ts'
import { at, day, entry, MIN, rsv } from './testing.ts'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

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

const NOW = at(18 * 60)
const fmt = new Intl.DateTimeFormat('en', {
	hour: 'numeric',
	minute: '2-digit',
	timeZone: 'UTC',
})

type Props = ComponentProps<typeof BookPanel>
function draw(
	reservations: DayReservation[],
	over: Partial<Props> & { waitlist?: ReturnType<typeof entry>[] } = {},
) {
	const { waitlist = [], ...rest } = over
	const feed = day(reservations)
	const props: Props = {
		list: bookList({ feed, waitlist, now: NOW, isToday: true }),
		query: '',
		onQuery: () => undefined,
		placing: null,
		now: NOW,
		formatTime: (ms) => fmt.format(ms),
		isToday: true,
		waitlistOn: true,
		single: false,
		fresh: new Set(),
		canReadGuest: true,
		textedBy: new Map(),
		earlyOf: (r) => earlyArrival(r, feed, NOW),
		onPick: () => undefined,
		onDetails: () => undefined,
		onWaitlistDetails: () => undefined,
		onAddWaitlist: () => undefined,
		onBookFor: () => undefined,
		onWaitlistFor: () => undefined,
		...rest,
	}
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(h(I18nProvider, { i18n }, h(BookPanel, props))))
}
const text = () => host.textContent ?? ''
const rowOf = (who: string) =>
	[...host.querySelectorAll('li.bk-row')].find((li) =>
		li.textContent?.includes(who),
	) as HTMLElement
/** The innermost span with these words: the one that carries the tone. */
const leaf = (row: Element, words: string) =>
	[...row.querySelectorAll('span')].find(
		(s) => s.children.length === 0 && s.textContent?.includes(words),
	)!
const guest = (first: string, last = 'Test') => ({
	id: `g-${first}`,
	name: `${first} ${last}`,
	firstName: first,
	lastName: last,
	phone: null,
})

describe('a party at the stand', () => {
	it('says how long they have waited, and turns to a warning from ten minutes', () => {
		draw([
			rsv({
				start: 17 * 60 + 50,
				status: 'arrived',
				arrivedAt: NOW - 12 * MIN,
				guest: guest('Slow'),
			}),
			rsv({
				start: 17 * 60 + 55,
				status: 'arrived',
				arrivedAt: NOW - 3 * MIN,
				guest: guest('Quick'),
			}),
		])
		expect(rowOf('Slow')!.textContent).toContain('At the stand · 12 min')
		expect(rowOf('Quick')!.textContent).toContain('At the stand · 3 min')
		expect(leaf(rowOf('Slow')!, 'At the stand').className).toContain(
			'text-warning',
		)
		expect(leaf(rowOf('Quick')!, 'At the stand').className).toContain(
			'text-success',
		)
	})
	it('says how many of a partly arrived party are here (an arrived booking short of its size)', () => {
		draw([
			rsv({
				start: 17 * 60 + 55,
				status: 'arrived',
				partySize: 5,
				arrivedCovers: 3,
				arrivedAt: NOW - 8 * MIN,
				guest: guest('Dina'),
			}),
		])
		expect(rowOf('Dina')!.textContent).toContain(
			'At the stand · 8 min · 3 of 5 here',
		)
	})
	it('says how early an early arrival is and that a table is free now', () => {
		const early = rsv({
			start: 18 * 60 + 28,
			status: 'arrived',
			partySize: 3,
			arrivedAt: NOW - 2 * MIN,
			guest: guest('Karim'),
		})
		draw([early])
		expect(rowOf('Karim')!.textContent).toContain('28 min early · table')
		expect(rowOf('Karim')!.textContent).toContain('free now')
	})
	it('says when a table is free for an early arrival who must wait for one', () => {
		const early = rsv({
			start: 18 * 60 + 28,
			status: 'arrived',
			arrivedAt: NOW - 2 * MIN,
			guest: guest('Karim'),
		})
		const none: EarlyArrival = {
			earlyMin: 28,
			table: { kind: 'free_in', minutes: 12, label: '8' },
		}
		draw([early], { earlyOf: () => none })
		expect(rowOf('Karim')!.textContent).toContain(
			'28 min early · table 8 free in 12 min',
		)
		draw([early], {
			earlyOf: () => ({
				earlyMin: 28,
				table: { kind: 'free_in', minutes: 12, label: null },
			}),
		})
		expect(rowOf('Karim')!.textContent).toContain(
			'28 min early · table free in 12 min',
		)
		draw([early], { earlyOf: () => ({ earlyMin: 28, table: null }) })
		expect(rowOf('Karim')!.textContent).toContain('28 min early')
	})
	it('says nothing about being early for a party that is on time', () => {
		draw([
			rsv({
				start: 18 * 60,
				status: 'arrived',
				arrivedAt: NOW - 2 * MIN,
				guest: guest('Prompt'),
			}),
		])
		expect(rowOf('Prompt')!.textContent).not.toContain('early')
	})
})

describe('a party that is late', () => {
	const booked = (lateMin: number, who: string) =>
		rsv({
			start: 18 * 60 - lateMin,
			status: 'booked',
			guest: guest(who),
		})
	it('is nudged at fifteen minutes to text them or mark a no-show', () => {
		draw([booked(15, 'Fifteen')])
		expect(rowOf('Fifteen')!.textContent).toContain(
			'15 min late: text or mark no-show',
		)
	})
	it('is nudged louder at thirty', () => {
		draw([booked(30, 'Thirty')])
		expect(
			leaf(rowOf('Thirty')!, '30 min late: text or mark no-show').className,
		).toContain('font-semibold')
		draw([booked(20, 'Twenty')])
		expect(leaf(rowOf('Twenty')!, '20 min late').className).not.toContain(
			'font-semibold',
		)
	})
	it('is only "late" under fifteen minutes', () => {
		draw([booked(10, 'Ten')])
		expect(rowOf('Ten')!.textContent).toContain('10 min late')
		expect(rowOf('Ten')!.textContent).not.toContain('text or mark no-show')
	})
	it('is not nudged for a guest who called to say how late they would be', () => {
		draw([
			rsv({
				start: 18 * 60 - 20,
				status: 'booked',
				runningLateMin: 30,
				guest: guest('Called'),
			}),
		])
		expect(rowOf('Called')!.textContent).not.toContain('text or mark no-show')
	})
})

describe('a party partly seated', () => {
	it('says how many of them sit at the table, in the Seated list', () => {
		draw([
			rsv({
				start: 17 * 60 + 30,
				status: 'seated',
				partySize: 5,
				seatedCovers: 3,
				seatedAt: NOW - 20 * MIN,
				guest: guest('Half'),
			}),
		])
		expect(rowOf('Half')!.textContent).toContain('seated 3 of 5')
	})
})

describe('a large party', () => {
	it('carries a "Large party" chip from eight', () => {
		draw([
			rsv({ start: 19 * 60, partySize: 8, guest: guest('Eight') }),
			rsv({ start: 19 * 60, partySize: 7, guest: guest('Seven') }),
		])
		expect(rowOf('Eight')!.textContent).toContain('Large party')
		expect(rowOf('Seven')!.textContent).not.toContain('Large party')
	})
})

describe('the waitlist', () => {
	const told = (over: Parameters<typeof entry>[0] = {}) =>
		entry({
			status: 'notified',
			phone: '+14155550132',
			smsOptIn: true,
			displayName: 'Amira Saad',
			firstName: 'Amira',
			notifiedAt: NOW - 4 * MIN,
			responseDeadlineAt: NOW + 6 * MIN,
			...over,
		})
	it('says a text is on its way, never that one was sent', () => {
		draw([], {
			waitlist: [told()],
			textedBy: new Map(),
		})
		// No answer from the notify call here: the party was only told.
		expect(rowOf('Amira')!.textContent).toContain('Told, holds 6 min')
		const entryId = told().id
		draw([], {
			waitlist: [told({ id: entryId })],
			textedBy: new Map([[entryId, true]]),
		})
		expect(rowOf('Amira')!.textContent).toContain(
			'Text on its way, holds 6 min',
		)
		expect(text()).not.toMatch(/Texted/)
	})
	it('lists a party whose hold ran out apart from the line, to be put back', () => {
		const onWaitlistDetails = vi.fn()
		const gone = entry({
			status: 'no_response',
			displayName: 'Jamal Hussein',
			firstName: 'Jamal',
			notifiedAt: NOW - 14 * MIN,
			responseDeadlineAt: NOW - 4 * MIN,
		})
		draw([], { waitlist: [gone], onWaitlistDetails })
		expect(text()).toContain('Did not respond')
		expect(text()).toContain('tap to put back in line')
		const row = rowOf('Jamal')!
		expect(row.textContent).toContain('Did not respond')
		// Not offered to seat: a tap opens them, where "Back in line" is.
		expect(row.textContent).not.toContain('Seat')
		act(() => (row.querySelector('.bk-row-main') as HTMLButtonElement).click())
		expect(onWaitlistDetails).toHaveBeenCalledWith(gone)
	})
	it('does not count a party that did not respond among those waiting', () => {
		const gone = entry({
			status: 'no_response',
			responseDeadlineAt: NOW - 4 * MIN,
		})
		const waiting = entry()
		draw([], { waitlist: [gone, waiting] })
		const head = [...host.querySelectorAll('.bk-section-head')].find((s) =>
			s.textContent?.includes('Waitlist'),
		)!
		expect(head.querySelector('[aria-label="1 party"]')).not.toBeNull()
	})
})
