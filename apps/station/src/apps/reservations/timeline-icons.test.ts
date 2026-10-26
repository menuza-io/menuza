// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DayReservation } from './feed.ts'
import { at, day, MIN, rsv } from './testing.ts'
import { Timeline } from './Timeline.tsx'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const NOW = at(18 * 60)
const issues: unknown[][] = []
const scroll = vi.fn()
let oldScroll: PropertyDescriptor | undefined
let host: HTMLDivElement
let root: Root
beforeEach(() => {
	issues.length = 0
	scroll.mockClear()
	vi.spyOn(console, 'error').mockImplementation((...args) => {
		issues.push(args)
	})
	vi.spyOn(console, 'warn').mockImplementation((...args) => {
		issues.push(args)
	})
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({ matches: false })),
	)
	oldScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
	Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
		configurable: true,
		value: scroll,
	})
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
		width: 960,
		height: 56,
		x: 0,
		y: 0,
		top: 0,
		left: 0,
		right: 960,
		bottom: 56,
		toJSON: () => ({}),
	})
	localStorage.clear()
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	if (oldScroll)
		Object.defineProperty(HTMLElement.prototype, 'scrollTo', oldScroll)
	else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
	try {
		expect(issues).toEqual([])
	} finally {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	}
})

function draw(
	reservations: DayReservation[],
	over: Partial<ComponentProps<typeof Timeline>> = {},
) {
	const props: ComponentProps<typeof Timeline> = {
		feed: day(reservations),
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
		...over,
	}
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(h(I18nProvider, { i18n }, h(Timeline, props))))
	expect(
		host.querySelector(
			'smartphone,crown,globe,cake,footprints,armchair,clock-3,circle-check,credit-card',
		),
	).toBeNull()
	return props
}
const hashes = (element: Element) =>
	[...element.querySelectorAll('svg > use')].map(
		(use) => use.getAttribute('href')?.split('#')[1],
	)

describe('Timeline renders real shared status glyphs and safely omits null glyphs', () => {
	it.each([
		{ status: 'booked', tone: 'booked', icon: null },
		{ status: 'confirmed', tone: 'confirmed', icon: 'circle-check' },
		{ status: 'arrived', tone: 'here', icon: 'footprints' },
		{ status: 'partially_arrived', tone: 'here', icon: 'footprints' },
		{ status: 'seated', tone: 'seated', icon: 'armchair' },
		{ status: 'partially_seated', tone: 'seated', icon: 'armchair' },
		{ status: 'pending_payment', tone: 'awaiting', icon: 'credit-card' },
		{ status: 'finished', tone: 'finished', icon: 'circle-check' },
		{ status: 'booked', tone: 'running', icon: 'clock-3', runningLateMin: 15 },
		{ status: 'booked', tone: 'late', icon: 'clock-3', start: 17 * 60 + 55 },
	])('renders $status as $tone ($icon)', ({ status, tone, icon, ...over }) => {
		const reservation = rsv({
			start: 18 * 60 + 10,
			status,
			tableIds: ['t1'],
			seatedAt: NOW - 5 * MIN,
			...over,
		})
		draw([reservation])
		const bar = host.querySelector('.tl-bar')!
		expect(bar).not.toBeNull()
		expect(bar.getAttribute('data-tone')).toBe(tone)
		expect(hashes(bar)).toEqual(icon ? [icon, 'users'] : ['users'])
		expect(scroll).toHaveBeenCalled()
	})

	it.each(['no_show', 'cancelled', 'requested'])(
		'keeps %s off the grid without a null-element crash',
		(status) => {
			draw([
				rsv({ start: 18 * 60 + 10, status, tableIds: ['t1'], noShowAt: NOW }),
			])
			// The real layout excludes these states. Booked above exercises the rendered null glyph.
			expect(host.querySelector('.tl-bar')).toBeNull()
		},
	)

	it.each([true, false])(
		'renders VIP/occasion/note/allergy/large-party branches, active=%s',
		(active) => {
			const reservation = rsv({
				start: 18 * 60 + 10,
				status: 'arrived',
				tableIds: ['t1'],
				partySize: 8,
				guest: {
					id: 'g',
					firstName: 'Guest',
					name: 'Guest Test',
					tags: [{ id: 'vip', name: 'VIP' }],
				},
				occasion: 'birthday',
				guestRequests: 'Quiet table',
				dietaryCodes: ['nut_allergy'],
			})
			const props = draw([reservation], { active })
			const bar = host.querySelector<HTMLButtonElement>('.tl-bar')!
			expect(hashes(bar)).toEqual([
				'footprints',
				'crown',
				'alert-triangle',
				'cake',
				'sticky-note',
				'users-round',
				'users',
			])
			for (const svg of bar.querySelectorAll('svg')) {
				expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg')
				expect(svg.getAttribute('aria-hidden')).toBe('true')
				expect(svg.querySelector('use')?.getAttribute('href')).toMatch(
					/sprite\.svg.*#[a-z0-9-]+$/,
				)
			}
			act(() => bar.click())
			expect(props.onBar).toHaveBeenCalledWith(reservation)
			expect(props.onEmpty).not.toHaveBeenCalled()
			act(() =>
				host.querySelector<HTMLButtonElement>('button.tl-label')!.click(),
			)
			expect(props.onTable).toHaveBeenCalledWith(
				props.feed.tables[0],
				expect.objectContaining({ kind: 'soon' }),
			)
			act(() => host.querySelector<HTMLButtonElement>('.tl-book-key')!.click())
			expect(props.onEmpty).toHaveBeenCalledWith(props.feed.tables[0], 18 * 60)
			expect(props.onRefused).not.toHaveBeenCalled()
			const before = scroll.mock.calls.length
			for (const label of ['Earlier', 'Now']) {
				const button = [...host.querySelectorAll('button')].find(
					(b) => b.textContent === label,
				)!
				act(() => button.click())
			}
			expect(scroll.mock.calls).toHaveLength(before + 2)
			expect(scroll.mock.lastCall?.[0]).toEqual(
				expect.objectContaining({
					left: expect.any(Number),
					behavior: 'smooth',
				}),
			)
		},
	)
})
