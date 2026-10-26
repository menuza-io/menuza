// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DayReservation } from './feed.ts'
import { at, day, MIN, rsv, SERVICES } from './testing.ts'
import { Timeline } from './Timeline.tsx'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const NOW = at(13 * 60 + 32)
let host: HTMLDivElement
let root: Root
beforeEach(() => {
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({ matches: false })),
	)
	Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
		configurable: true,
		value: vi.fn(),
	})
	localStorage.clear()
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
	vi.unstubAllGlobals()
})

function draw(
	reservations: DayReservation[],
	over: Partial<ComponentProps<typeof Timeline>> = {},
) {
	const props: ComponentProps<typeof Timeline> = {
		feed: day(reservations, { services: SERVICES }),
		now: NOW,
		isToday: true,
		bookable: true,
		serviceId: null,
		matchIds: null,
		picking: null,
		active: true,
		canReadGuest: true,
		formatTime: (ms) => new Date(ms).toISOString().slice(11, 16),
		formatShort: (ms) => new Date(ms).toISOString().slice(11, 16),
		onBar: vi.fn(),
		onTable: vi.fn(),
		onEmpty: vi.fn(),
		onRefused: vi.fn(),
		onPlace: vi.fn(),
		...over,
	}
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(h(I18nProvider, { i18n }, h(Timeline, props))))
	return props
}
const press = (el: Element | null | undefined) => {
	if (!el) throw new Error('nothing to press')
	act(() => (el as HTMLElement).click())
}
const strip = () => host.querySelector('.tl-none')!
const stripBars = () => [...strip().querySelectorAll('.tl-bar')]

/** Six bookings at the same time with no table: six lines tall if nothing caps them. */
const unplaced = (count = 6) =>
	Array.from({ length: count }, (_u, i) =>
		rsv({
			id: `u${i}`,
			start: 19 * 60,
			tableIds: [],
			guest: {
				id: `g${i}`,
				name: `Guest ${i}`,
				firstName: 'Guest',
				lastName: `N${i}`,
			},
		}),
	)

describe('the "No table" strip', () => {
	it('shows its first three lines and counts the rest behind a button', () => {
		draw(unplaced())
		expect(stripBars()).toHaveLength(3)
		const more = strip().querySelector('.tl-more')!
		expect(more.textContent).toBe('+3 to place')
		expect(more.getAttribute('aria-expanded')).toBe('false')
		// Collapsed it stays under the time header while the grid scrolls.
		expect(strip().getAttribute('data-open')).toBe('false')
	})
	it('opens to every booking, and closes again', () => {
		draw(unplaced())
		press(strip().querySelector('.tl-more'))
		expect(stripBars()).toHaveLength(6)
		expect(strip().getAttribute('data-open')).toBe('true')
		const fewer = strip().querySelector('.tl-more')!
		expect(fewer.textContent).toBe('Show fewer')
		press(fewer)
		expect(stripBars()).toHaveLength(3)
	})
	it('has no button when everything fits in three lines', () => {
		draw(unplaced(3))
		expect(strip().querySelector('.tl-more')).toBeNull()
	})
	it('leaves out bookings whose time has passed, so they take no height', () => {
		draw([
			rsv({ id: 'missed', start: 11 * 60 + 30, tableIds: [] }),
			rsv({ id: 'live', start: 15 * 60, tableIds: [] }),
		])
		expect(stripBars()).toHaveLength(1)
		const row = strip().querySelector<HTMLElement>('.tl-row')!
		expect(row.style.getPropertyValue('--lanes')).toBe('1')
	})
	it('sends a tap on a booking straight to choosing a table for it', () => {
		const list = unplaced(2)
		const props = draw(list)
		press(stripBars()[0])
		expect(props.onPlace).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'u0' }),
		)
		expect(props.onBar).not.toHaveBeenCalled()
	})
	it('opens the booking like any other bar when there is nothing to place it with', () => {
		const props = draw(unplaced(1), { onPlace: undefined })
		press(stripBars()[0])
		expect(props.onBar).toHaveBeenCalled()
	})
	it('does not take the bar of a booking that has a table to the strip', () => {
		const props = draw([
			rsv({ id: 'seated', start: 13 * 60, tableIds: ['t2'] }),
		])
		expect(host.querySelector('.tl-none')).toBeNull()
		const bar = host.querySelector('.tl-bar')!
		press(bar)
		expect(props.onBar).toHaveBeenCalled()
		expect(props.onPlace).not.toHaveBeenCalled()
	})
})

describe('what the bars say', () => {
	it('marks a late booking and a stay over its time with a hatch, and not one on time', () => {
		draw([
			rsv({ id: 'late', start: 12 * 60 + 40, tableIds: ['t1'] }),
			rsv({
				id: 'over',
				start: 11 * 60 + 30,
				status: 'seated',
				seatedAt: at(11 * 60 + 35),
				tableIds: ['t2'],
			}),
			rsv({ id: 'fine', start: 14 * 60, tableIds: ['t10'] }),
		])
		const bar = (name: string) =>
			[...host.querySelectorAll('.tl-bar')].find((b) =>
				b.getAttribute('aria-label')?.includes(name),
			)
		const tables = [...host.querySelectorAll('.tl-bar')]
		expect(
			tables.filter((b) => b.getAttribute('data-hatch') === 'true'),
		).toHaveLength(2)
		expect(bar('13:00')).toBeUndefined()
		expect(
			tables.find(
				(b) =>
					b.getAttribute('data-tone') === 'booked' &&
					b.getAttribute('data-hatch') !== 'true',
			),
		).toBeDefined()
	})
	it('says how long a seated party has left, or is over', () => {
		draw([
			rsv({
				id: 'left',
				start: 13 * 60,
				status: 'seated',
				seatedAt: at(13 * 60),
				tableIds: ['t1'],
			}),
			rsv({
				id: 'over',
				start: 11 * 60,
				durationMin: 150,
				status: 'seated',
				seatedAt: at(11 * 60),
				tableIds: ['t2'],
			}),
		])
		const said = [...host.querySelectorAll('.tl-bar-left')].map(
			(el) => el.textContent,
		)
		expect(said).toEqual(expect.arrayContaining(['~58m left', '2m over']))
	})
	it('carries a chevron for when its start is scrolled out of view', () => {
		draw([rsv({ id: 'early', start: 12 * 60, tableIds: ['t1'] })])
		const bar = host.querySelector('.tl-bar')!
		expect(bar.querySelector('.tl-clip')).not.toBeNull()
		expect(bar.querySelector('.tl-clip')!.getAttribute('aria-hidden')).toBe(
			'true',
		)
	})
	it('has a legend of what the colours mean, with the large party mark', () => {
		draw([])
		const legend = [...host.querySelectorAll('.bk-legend li')].map(
			(li) => li.textContent,
		)
		expect(legend).toEqual([
			'Booked',
			'Here',
			'Seated',
			'Late or over time',
			'Large party',
		])
	})
	it('flags the time at the top of the line', () => {
		draw([])
		expect(host.querySelector('.tl-now-flag')!.textContent).toBe('1:32')
		draw([], { isToday: false })
		expect(host.querySelector('.tl-now-flag')).toBeNull()
	})
	it('says what is missing when there are no tables', () => {
		draw([], {
			feed: day([], { tables: [], areas: [] }),
			noTables: 'Downtown has no tables yet.',
		})
		expect(host.textContent).toContain('Downtown has no tables yet.')
	})
})

void MIN
