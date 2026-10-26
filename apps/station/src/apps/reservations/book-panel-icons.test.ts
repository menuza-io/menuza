// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bookList } from './book.ts'
import { BookPanel } from './BookPanel.tsx'
import { type DayReservation } from './feed.ts'
import { at, day, entry, MIN, rsv } from './testing.ts'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const NOW = at(18 * 60)
const issues: unknown[][] = []
let host: HTMLDivElement
let root: Root
beforeEach(() => {
	issues.length = 0
	vi.spyOn(console, 'error').mockImplementation((...args) => {
		// The shared scroll area measures its thumb after mount, outside act: not what this suite checks.
		if (args.includes('ScrollAreaRoot')) return
		issues.push(args)
	})
	vi.spyOn(console, 'warn').mockImplementation((...args) => {
		issues.push(args)
	})
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	try {
		expect(issues).toEqual([])
	} finally {
		vi.restoreAllMocks()
	}
})

function draw(
	reservations: DayReservation[],
	over: Partial<ComponentProps<typeof BookPanel>> = {},
) {
	const props: ComponentProps<typeof BookPanel> = {
		list: bookList({
			feed: day(reservations),
			waitlist: [],
			now: NOW,
			isToday: true,
		}),
		// Search mode opens finished/missed sections too, without bypassing the real list.
		query: 'Guest',
		onQuery: vi.fn(),
		placing: null,
		now: NOW,
		formatTime: (ms) => new Date(ms).toISOString().slice(11, 16),
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
		...over,
	}
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(h(I18nProvider, { i18n }, h(BookPanel, props))))
	expect(
		host.querySelector(
			'smartphone,crown,globe,cake,footprints,armchair,clock-3,badge-check',
		),
	).toBeNull()
	return props
}
const hashes = (element: Element) =>
	[...element.querySelectorAll('svg > use')].map(
		(use) => use.getAttribute('href')?.split('#')[1],
	)
const guest = {
	id: 'guest',
	name: 'Guest Test',
	firstName: 'Guest',
	lastName: 'Test',
}

describe('BookPanel renders real shared glyphs without HTML-tag or null-component warnings', () => {
	it.each([
		{ status: 'booked', tone: 'booked' },
		{ status: 'confirmed', tone: 'confirmed' },
		{ status: 'arrived', tone: 'here' },
		{ status: 'partially_arrived', tone: 'here' },
		{ status: 'seated', tone: 'seated' },
		{ status: 'partially_seated', tone: 'seated' },
		{ status: 'pending_payment', tone: 'awaiting' },
		{ status: 'finished', tone: 'finished' },
		{ status: 'no_show', tone: 'no_show' },
		{ status: 'booked', tone: 'running', runningLateMin: 15 },
		{ status: 'booked', tone: 'late', start: 17 * 60 + 55 },
	])('renders $status as $tone', ({ status, tone, ...over }) => {
		draw([
			rsv({
				start: 18 * 60 + 10,
				status,
				guest,
				seatedAt: NOW - 5 * MIN,
				noShowAt: NOW,
				...over,
			}),
		])
		const row = host.querySelector('.bk-row')!
		expect(row).not.toBeNull()
		expect(row.getAttribute('data-tone')).toBe(tone)
		expect(hashes(row)).toContain('users')
		expect(hashes(row)).toContain('info')
		expect(hashes(row)).not.toContain('crown')
		expect(hashes(row)).not.toContain('cake')
		expect(hashes(row)).not.toContain('globe')
		expect(hashes(row)).not.toContain('smartphone')
		if (tone === 'awaiting') expect(hashes(row)).toContain('credit-card')
		if (tone === 'no_show') expect(hashes(row)).toContain('user-x')
	})

	it.each(['finished', 'no_show'])(
		'omits channel, deposit and running-late badges for %s',
		(status) => {
			const props = draw([
				rsv({
					start: 17 * 60,
					status,
					guest,
					channel: 'native',
					paymentStatus: 'paid',
					runningLateMin: 15,
					noShowAt: NOW,
				}),
			])
			const row = host.querySelector('.bk-row')!
			expect(hashes(row)).not.toContain('smartphone')
			expect(hashes(row)).not.toContain('badge-check')
			expect(hashes(row)).not.toContain('clock-3')
			act(() => row.querySelector<HTMLButtonElement>('.bk-row-main')!.click())
			expect(props.onDetails).toHaveBeenCalled()
			expect(props.onPick).not.toHaveBeenCalled()
		},
	)

	it.each(['online', 'native', 'voice_agent'])(
		'renders every Mark branch for %s bookings and keeps callbacks',
		(channel) => {
			const reservation = rsv({
				start: 18 * 60 + 10,
				channel,
				partySize: 8,
				runningLateMin: 15,
				guest: { ...guest, tags: [{ id: 'vip', name: 'VIP' }] },
				occasion: 'birthday',
				guestRequests: 'A quiet table',
				dietaryCodes: ['nut_allergy'],
				paymentStatus: 'paid',
			})
			const props = draw([reservation])
			const row = host.querySelector('.bk-row')!
			expect(hashes(row)).toEqual(
				expect.arrayContaining([
					'crown',
					'cake',
					'sticky-note',
					'alert-triangle',
					'badge-check',
					'clock-3',
					channel === 'online' ? 'globe' : 'smartphone',
				]),
			)
			expect(row.textContent).toContain('Large party')
			for (const svg of row.querySelectorAll('svg')) {
				expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg')
				expect(svg.getAttribute('aria-hidden')).toBe('true')
				expect(svg.querySelector('use')?.getAttribute('href')).toMatch(
					/sprite\.svg.*#[a-z0-9-]+$/,
				)
			}
			act(() => row.querySelector<HTMLButtonElement>('.bk-row-main')!.click())
			expect(props.onPick).toHaveBeenCalledWith({
				kind: 'reservation',
				reservation,
			})
			act(() => row.querySelector<HTMLButtonElement>('.bk-row-info')!.click())
			expect(props.onDetails).toHaveBeenCalledWith(reservation)
			expect(props.onPick).toHaveBeenCalledTimes(1)
		},
	)

	it('renders online/told/noted waitlist marks and preserves selection and detail callbacks', () => {
		const waiting = entry({
			firstName: 'Guest',
			displayName: 'Guest Waiting',
			channel: 'remote',
			status: 'notified',
			notifiedAt: NOW - MIN,
			responseDeadlineAt: NOW + 5 * MIN,
			notes: 'Near a window',
		})
		const list = bookList({
			feed: day([]),
			waitlist: [waiting],
			now: NOW,
			isToday: true,
		})
		const props = draw([], { list })
		const row = host.querySelector('.bk-row')!
		expect(hashes(row)).toEqual(
			expect.arrayContaining(['smartphone', 'bell-ring', 'sticky-note']),
		)
		act(() => row.querySelector<HTMLButtonElement>('.bk-row-main')!.click())
		expect(props.onPick).toHaveBeenCalledWith({
			kind: 'waitlist',
			entry: waiting,
		})
		act(() => row.querySelector<HTMLButtonElement>('.bk-row-info')!.click())
		expect(props.onWaitlistDetails).toHaveBeenCalledWith(waiting)
	})

	it.each(['waiting', 'no_response'] as const)(
		'renders plain %s waitlist rows without optional marks',
		(status) => {
			const waiting = entry({
				firstName: 'Guest',
				displayName: 'Guest Waiting',
				status,
			})
			const list = bookList({
				feed: day([]),
				waitlist: [waiting],
				now: NOW,
				isToday: true,
			})
			const props = draw([], { list })
			const row = host.querySelector('.bk-row')!
			expect(hashes(row)).not.toContain('smartphone')
			expect(hashes(row)).not.toContain('bell-ring')
			expect(hashes(row)).not.toContain('sticky-note')
			act(() => row.querySelector<HTMLButtonElement>('.bk-row-main')!.click())
			if (status === 'waiting') {
				expect(props.onPick).toHaveBeenCalledWith({
					kind: 'waitlist',
					entry: waiting,
				})
			} else {
				expect(props.onWaitlistDetails).toHaveBeenCalledWith(waiting)
				expect(props.onPick).not.toHaveBeenCalled()
			}
		},
	)
})
