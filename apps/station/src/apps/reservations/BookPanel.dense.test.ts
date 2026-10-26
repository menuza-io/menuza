// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { createElement as h, act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bookList } from './book.ts'
import { BookPanel } from './BookPanel.tsx'
import { type DayReservation } from './feed.ts'
import { FILTERS_KEY } from './listView.ts'
import { at, day, entry, MIN, rsv } from './testing.ts'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
	localStorage.clear()
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
	Element.prototype.scrollIntoView = vi.fn()
	window.matchMedia = ((query: string) => ({
		matches: false,
		media: query,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	})) as never
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	localStorage.clear()
})

const NOW = at(18 * 60)
const fmt = new Intl.DateTimeFormat('en', {
	hour: 'numeric',
	minute: '2-digit',
	timeZone: 'UTC',
})
const guest = (first: string, extra: Record<string, unknown> = {}) => ({
	id: `g-${first}`,
	name: `${first} Test`,
	firstName: first,
	lastName: 'Test',
	phone: null,
	...extra,
})

type Props = ComponentProps<typeof BookPanel>
function draw(
	reservations: DayReservation[],
	over: Partial<Props> & { waitlist?: ReturnType<typeof entry>[] } = {},
) {
	const { waitlist = [], ...rest } = over
	const feed = day(reservations)
	const props: Props = {
		list: bookList({
			feed,
			waitlist,
			now: NOW,
			isToday: true,
			query: rest.query ?? '',
		}),
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
		earlyOf: () => null,
		onPick: vi.fn(),
		onDetails: vi.fn(),
		onWaitlistDetails: vi.fn(),
		onAddWaitlist: vi.fn(),
		onBookFor: vi.fn(),
		onWaitlistFor: vi.fn(),
		...rest,
	}
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(h(I18nProvider, { i18n }, h(BookPanel, props))))
	return props
}
const rows = () => [...host.querySelectorAll('li.bk-row')] as HTMLElement[]
const rowOf = (who: string) =>
	rows().find((li) => li.textContent?.includes(who))!
const press = (el: Element | null | undefined) => {
	if (!el) throw new Error('nothing to press')
	act(() => (el as HTMLElement).click())
}
const chip = (label: string) =>
	[...host.querySelectorAll<HTMLButtonElement>('.bk-filter-chips button')].find(
		(b) => b.textContent?.startsWith(label),
	)

/** Twenty-one bookings still to seat: a dense day's list. */
const busy = (extra: DayReservation[] = []) => [
	...Array.from({ length: 20 }, (_u, i) =>
		rsv({
			start: 18 * 60 + 30 + i * 3,
			partySize: 2,
			tableIds: ['t1'],
			guest: guest(`Plain${i}`),
		}),
	),
	rsv({
		start: 19 * 60 + 10,
		partySize: 10,
		tableIds: [],
		channel: 'online',
		guest: guest('Big', { tags: [{ id: 'v', name: 'VIP' }] }),
	}),
	...extra,
]

describe('the list on a busy day', () => {
	it('has hour headers with how many parties and covers each holds', () => {
		draw(busy())
		const heads = [...host.querySelectorAll('.bk-hour')].map(
			(el) => el.textContent,
		)
		expect(heads).toEqual([
			'6:00 PM·10 parties·20 covers',
			'7:00 PM·11 parties·30 covers',
		])
	})
	it('turns an hour amber when a slot in it is near its cap', () => {
		draw(busy(), {
			pressure: new Map([
				[18, { level: 'high' as const, covers: 21, cap: 24 }],
			]),
		})
		const covers = host.querySelector('.bk-hour-covers[data-level]')!
		expect(covers.getAttribute('data-level')).toBe('high')
		expect(covers.getAttribute('title')).toBe('Busiest slot: 21 of 24 covers')
		expect(host.querySelectorAll('.bk-hour-covers[data-level]')).toHaveLength(1)
	})
	it('has no hour headers or chips on a quiet day', () => {
		draw(busy().slice(0, 3))
		expect(host.querySelector('.bk-hour')).toBeNull()
		expect(host.querySelector('.bk-filters')).toBeNull()
	})
})

describe('the filter chips', () => {
	it('count what each would show, and a chip narrows the list', () => {
		draw(busy())
		expect(chip('VIP')!.textContent).toContain('1')
		expect(chip('Large')!.textContent).toContain('1')
		expect(chip('No table')!.textContent).toContain('1')
		expect(chip('Online')!.textContent).toContain('1')
		expect(rows()).toHaveLength(21)
		press(chip('VIP'))
		expect(rows()).toHaveLength(1)
		expect(rows()[0]!.textContent).toContain('Big')
		// The hour headers follow what is left.
		expect(host.querySelector('.bk-hour')!.textContent).toBe(
			'7:00 PM·1 party·10 covers',
		)
		press(chip('VIP'))
		expect(rows()).toHaveLength(21)
	})
	it('are remembered on this device, and a chip with nothing behind it cannot be chosen', () => {
		draw(busy())
		press(chip('Large'))
		expect(localStorage.getItem(FILTERS_KEY)).toBe('["large"]')
		// Drawn again (a new visit): the chip is still on.
		act(() => root.unmount())
		root = createRoot(host)
		draw(busy())
		expect(chip('Large')!.getAttribute('aria-pressed')).toBe('true')
		expect(rows()).toHaveLength(1)
		expect(chip('Late')!.disabled).toBe(true)
	})
	it('say when nothing matches, and can be put away', () => {
		draw(busy())
		press(chip('VIP'))
		press(chip('No table'))
		// Any of them: the big VIP party with no table.
		expect(rows()).toHaveLength(1)
		localStorage.clear()
		const props = draw(busy(), {
			onlyIds: new Set(['nothing']),
			onClearOnly: vi.fn(),
		})
		expect(host.textContent).toContain('Nothing matches these filters.')
		press(
			[...host.querySelectorAll('.bk-filter-chips button')].find((b) =>
				b.textContent?.includes('Just changed'),
			),
		)
		expect(props.onClearOnly).toHaveBeenCalled()
	})
	it('can show only what the last update changed', () => {
		const list = busy()
		draw(list, { onlyIds: new Set([list[1]!.id, list[2]!.id]) })
		expect(rows()).toHaveLength(2)
	})
})

describe('Now', () => {
	it('goes to the next party due', () => {
		draw(busy())
		const now = [...host.querySelectorAll('.bk-now')].find((b) =>
			b.textContent?.includes('Now'),
		)!
		press(now)
		expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
			block: 'start',
			behavior: 'smooth',
		})
	})
	it('is not offered when nobody is still to come', () => {
		draw(
			busy().map((r) => ({
				...r,
				startAt: NOW - 5 * MIN,
				endAt: NOW + 60 * MIN,
			})),
		)
		expect(host.querySelector('.bk-now')).toBeNull()
	})
})

describe('searching', () => {
	it('says how many it found, where it can be seen', () => {
		draw(busy(), { query: 'Plain' })
		expect(host.querySelector('[role="status"]')!.textContent).toBe(
			'20 results',
		)
		draw(busy(), { query: 'zzz' })
		expect(host.querySelector('[role="status"]')!.textContent).toBe(
			'No one matches the search.',
		)
	})
	it('says nothing when nothing is typed', () => {
		draw(busy())
		expect(host.querySelector('[role="status"]')!.textContent).toBe('')
	})
})

describe('a long waitlist', () => {
	const line = (count: number) =>
		Array.from({ length: count }, (_u, i) =>
			entry({
				displayName: `Wait${i}`,
				firstName: `Wait${i}`,
				partySize: 2,
				joinedAt: NOW - (10 + i) * MIN,
				quotedMin: 5,
			}),
		)
	it('is one summary row past three: how many, the longest wait, who is next', () => {
		const props = draw([], { waitlist: line(4) })
		const summary = host.querySelector('.bk-wl-summary')!
		expect(summary.textContent).toContain('Longest wait 13 min')
		expect(host.querySelectorAll('li.bk-row')).toHaveLength(0)
		const next = [...summary.querySelectorAll('button')].find((b) =>
			b.textContent?.startsWith('Seat next'),
		)!
		expect(next.textContent).toBe('Seat next: Wait0')
		press(next)
		expect(props.onPick).toHaveBeenCalledWith({
			kind: 'waitlist',
			entry: expect.objectContaining({ displayName: 'Wait0' }),
		})
	})
	it('opens to every party, and closes again', () => {
		draw([], { waitlist: line(5) })
		press(
			[...host.querySelectorAll('.bk-wl-summary button')].find((b) =>
				b.textContent?.includes('Show all'),
			),
		)
		expect(host.querySelector('.bk-wl-summary')).toBeNull()
		expect(host.querySelectorAll('li.bk-row')).toHaveLength(5)
		press(host.querySelector('.bk-wl-less'))
		expect(host.querySelector('.bk-wl-summary')).not.toBeNull()
	})
	it('is the whole list, with no summary or Show less, as a column of the List view', () => {
		draw([], { waitlist: line(6), columns: true })
		expect(host.querySelector('.bk-wl-summary')).toBeNull()
		expect(host.querySelector('.bk-wl-less')).toBeNull()
		expect(host.querySelectorAll('li.bk-row')).toHaveLength(6)
		// The line, who is still to come and who is here, side by side.
		expect(host.querySelector('.bk-columns')!.children).toHaveLength(3)
	})
	it('is the whole list for three or fewer, and while searching', () => {
		draw([], { waitlist: line(3) })
		expect(host.querySelector('.bk-wl-summary')).toBeNull()
		expect(host.querySelectorAll('li.bk-row')).toHaveLength(3)
		draw([], { waitlist: line(6), query: 'Wait' })
		expect(host.querySelector('.bk-wl-summary')).toBeNull()
		expect(host.querySelectorAll('li.bk-row')).toHaveLength(6)
	})
})

describe('what the accent bar and the table chip say', () => {
	it('limits the bar to due soon, late, here and seated', () => {
		draw(
			[
				rsv({ start: 18 * 60 + 20, guest: guest('Soon') }),
				rsv({ start: 17 * 60 + 40, guest: guest('Late') }),
				rsv({ start: 17 * 60 + 55, status: 'arrived', guest: guest('Here') }),
				rsv({ start: 21 * 60, guest: guest('Later') }),
				rsv({ start: 21 * 60, status: 'confirmed', guest: guest('Sure') }),
			],
			{ query: 'e' },
		)
		const stripe = (who: string) => rowOf(who).getAttribute('data-stripe')
		expect(stripe('Soon')).toBe('soon')
		expect(stripe('Late')).toBe('late')
		expect(stripe('Here')).toBe('here')
		expect(stripe('Later')).toBeNull()
		expect(stripe('Sure')).toBeNull()
	})
	it('says seated as a solid chip and a table only assigned as an outline', () => {
		draw(
			[
				rsv({
					start: 18 * 60 + 40,
					tableIds: ['t2'],
					tableLabels: ['P4'],
					guest: guest('Assigned'),
				}),
				rsv({
					start: 16 * 60,
					status: 'seated',
					seatedAt: NOW - 120 * MIN,
					tableIds: ['t10'],
					tableLabels: ['7'],
					guest: guest('Seatedd'),
				}),
			],
			{ query: 'd' },
		)
		const badge = (who: string) => rowOf(who).querySelector('.bk-badge')!
		expect(badge('Assigned').getAttribute('data-solid')).toBe('false')
		expect(badge('Seatedd').getAttribute('data-solid')).toBe('true')
		// A seated party running over its time carries the late bar.
		expect(rowOf('Seatedd').getAttribute('data-stripe')).toBe('late')
	})
})

describe('what changed a moment ago', () => {
	it('tags a new or changed booking beside its name', () => {
		const list = busy()
		draw(list, {
			tags: new Map([
				[list[0]!.id, 'new' as const],
				[list[1]!.id, 'changed' as const],
			]),
		})
		expect(rowOf('Plain0').querySelector('.bk-tag')!.textContent).toBe('New')
		expect(rowOf('Plain1').querySelector('.bk-tag')!.textContent).toBe(
			'Changed',
		)
		expect(rowOf('Plain2').querySelector('.bk-tag')).toBeNull()
	})
})

describe('while the connection is down', () => {
	it('shows picking a party up as unavailable, with the reason, and does nothing', () => {
		const props = draw([rsv({ start: 18 * 60 + 40, guest: guest('Ready') })], {
			writesBlocked: 'Offline: this waits for the connection.',
			waitlist: [entry({ displayName: 'Wait', firstName: 'Wait' })],
		})
		const main =
			rowOf('Ready').querySelector<HTMLButtonElement>('.bk-row-main')!
		expect(main.getAttribute('aria-disabled')).toBe('true')
		expect(main.title).toBe('Offline: this waits for the connection.')
		press(main)
		expect(props.onPick).not.toHaveBeenCalled()
		const wait = rowOf('Wait').querySelector<HTMLButtonElement>('.bk-row-main')!
		expect(wait.getAttribute('aria-disabled')).toBe('true')
		press(wait)
		expect(props.onPick).not.toHaveBeenCalled()
		// Details stay open: reading is not a change.
		press(rowOf('Ready').querySelector('.bk-row-info'))
		expect(props.onDetails).toHaveBeenCalled()
	})
})
