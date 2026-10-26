import { i18n } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import {
	createSelfMarks,
	dayNotices,
	daySnapshot,
	NEWS_FRESH_MS,
	newArrivals,
	SELF_MARK_MS,
	snapshotToCompare,
} from './book.ts'
import {
	CHANGE_TAG_MS,
	liveTags,
	MAX_NAMED,
	MAX_SPOKEN,
	newsOf,
} from './news.ts'
import { at, day, rsv } from './testing.ts'

const _ = i18n._.bind(i18n)
const NOW = at(13 * 60)
const formatTime = (ms: number) =>
	new Intl.DateTimeFormat('en', {
		hour: 'numeric',
		minute: '2-digit',
		timeZone: 'UTC',
	}).format(ms)
const guest = (first: string, last: string) => ({
	id: first,
	name: `${first} ${last}`,
	firstName: first,
	lastName: last,
})

const before = day([
	rsv({
		id: 'a',
		start: 1200,
		status: 'booked',
		partySize: 2,
		guest: guest('Priya', 'Nair'),
	}),
	rsv({
		id: 'b',
		start: 1215,
		status: 'confirmed',
		partySize: 4,
		guest: guest('Omar', 'Rashid'),
	}),
	rsv({
		id: 'c',
		start: 1230,
		status: 'booked',
		partySize: 2,
		guest: guest('Chris', 'Tanaka'),
	}),
])

function news(later: ReturnType<typeof day>) {
	const snapshot = daySnapshot(before)
	return newsOf(_, {
		arrivals: newArrivals(snapshot, later),
		notices: dayNotices(snapshot, later, { now: NOW }),
		formatTime,
	})
}

describe('what the stand says about a change', () => {
	it('says nothing when nothing changed', () => {
		expect(news(before)).toEqual({
			items: [],
			toast: null,
			summary: false,
			highlight: false,
			ids: [],
			tags: new Map(),
		})
	})
	it('says a new online booking with who, how many and when', () => {
		const later = day([
			...before.reservations,
			rsv({
				start: 19 * 60 + 30,
				channel: 'online',
				partySize: 4,
				createdAt: NOW - 60_000,
				guest: guest('Omar', 'Said'),
			}),
		])
		expect(news(later).toast).toBe('Omar S. booked 4 for 7:30 PM')
	})
	it('says a cancellation and a changed party size', () => {
		const cancelled = day([
			rsv({
				id: 'a',
				start: 1200,
				status: 'cancelled',
				partySize: 2,
				guest: guest('Priya', 'Nair'),
			}),
			before.reservations[1]!,
			before.reservations[2]!,
		])
		expect(news(cancelled).toast).toBe('Priya N. cancelled')
		const resized = day([
			before.reservations[0]!,
			rsv({
				id: 'b',
				start: 1215,
				status: 'confirmed',
				partySize: 6,
				guest: guest('Omar', 'Rashid'),
			}),
			before.reservations[2]!,
		])
		expect(news(resized).toast).toBe('Omar R. changed from 4 to 6')
	})
	it('says an arrival, a VIP by name, and counts several changes', () => {
		const arrived = day([
			rsv({
				id: 'a',
				start: 1200,
				status: 'arrived',
				partySize: 2,
				guest: guest('Priya', 'Nair'),
			}),
			before.reservations[1]!,
			before.reservations[2]!,
		])
		expect(news(arrived).toast).toBe('Priya N. has arrived')
		const vip = day([
			before.reservations[0]!,
			before.reservations[1]!,
			rsv({
				id: 'c',
				start: 1230,
				status: 'arrived',
				guest: {
					...guest('Chris', 'Tanaka'),
					tags: [{ id: 'v', name: 'VIP' }],
				},
			}),
		])
		expect(news(vip).toast).toBe('VIP: Chris T. has arrived')
		expect(news(vip).highlight).toBe(true)
		const several = day([
			rsv({
				id: 'a',
				start: 1200,
				status: 'arrived',
				guest: guest('Priya', 'Nair'),
			}),
			rsv({
				id: 'b',
				start: 1215,
				status: 'cancelled',
				partySize: 4,
				guest: guest('Omar', 'Rashid'),
			}),
			before.reservations[2]!,
		])
		const result = news(several)
		// One or two are named, not counted.
		expect(MAX_NAMED).toBe(2)
		expect(result.summary).toBe(false)
		expect(result.toast).toBe('Priya N. has arrived · Omar R. cancelled')
		expect(result.items).toEqual(['Priya N. has arrived', 'Omar R. cancelled'])
	})
})

describe('a burst of changes', () => {
	const many = (count: number) =>
		day([
			...before.reservations,
			...Array.from({ length: count }, (_unused, index) =>
				rsv({
					id: `new-${index}`,
					start: 19 * 60 + index,
					channel: 'online',
					partySize: 2,
					createdAt: NOW - 60_000,
					guest: guest('Guest', `N${index}`),
				}),
			),
		])
	it('is read out as the first few, then "and N more"', () => {
		const said = news(many(50))
		expect(said.items).toHaveLength(MAX_SPOKEN + 1)
		expect(said.items[MAX_SPOKEN]).toBe('and 47 more')
		expect(said.items.slice(0, MAX_SPOKEN).join(' ')).toContain('booked 2')
		// The toast is one summary, not fifty lines; it can be tapped to see them.
		expect(said.toast).toBe('50 new')
		expect(said.summary).toBe(true)
		expect(said.ids).toHaveLength(50)
	})
	it('reads out a few changes in full, with no "and more"', () => {
		const said = news(many(MAX_SPOKEN))
		expect(said.items).toHaveLength(MAX_SPOKEN)
		expect(said.items.join(' ')).not.toContain('more')
		expect(news(many(MAX_SPOKEN + 1)).items.at(-1)).toBe('and 1 more')
	})
})

describe('how old a look may be and still be news', () => {
	const seen = (at: number) => ({
		date: before.businessDate,
		snapshot: daySnapshot(before),
		at,
	})
	it('compares with a recent look', () => {
		expect(
			snapshotToCompare(seen(NOW), before.businessDate, NOW + 30_000),
		).not.toBeNull()
		expect(
			snapshotToCompare(seen(NOW), before.businessDate, NOW + NEWS_FRESH_MS),
		).not.toBeNull()
	})
	it('drops a look older than a few minutes: a backlog is not announced', () => {
		expect(
			snapshotToCompare(
				seen(NOW),
				before.businessDate,
				NOW + NEWS_FRESH_MS + 1,
			),
		).toBeNull()
		// A tablet that slept for an hour comes back to a first look: nothing said.
		const later = day([
			...before.reservations,
			rsv({
				start: 19 * 60,
				channel: 'online',
				createdAt: NOW + 30 * 60_000,
				guest: guest('Omar', 'Said'),
			}),
		])
		const base = snapshotToCompare(
			seen(NOW),
			before.businessDate,
			NOW + 60 * 60_000,
		)
		expect(
			newsOf(_, {
				arrivals: newArrivals(base, later),
				notices: dayNotices(base, later, { now: NOW + 60 * 60_000 }),
				formatTime,
			}).toast,
		).toBeNull()
	})
	it('is no basis for another day, or for no look at all', () => {
		expect(snapshotToCompare(seen(NOW), '2030-01-01', NOW)).toBeNull()
		expect(snapshotToCompare(null, before.businessDate, NOW)).toBeNull()
		// A clock that went back: not a look from the future.
		expect(
			snapshotToCompare(seen(NOW), before.businessDate, NOW - 1),
		).toBeNull()
	})
})

describe('changes this tablet made itself', () => {
	const resized = day(
		before.reservations.map((r) => (r.id === 'a' ? { ...r, partySize: 5 } : r)),
	)
	const cancelled = day(
		before.reservations.map((r) =>
			r.id === 'a' ? { ...r, status: 'cancelled' } : r,
		),
	)
	it('are not announced to it', () => {
		const marks = createSelfMarks()
		marks.mark('a', NOW)
		expect(
			dayNotices(daySnapshot(before), resized, {
				now: NOW,
				byUs: marks.live(NOW),
			}),
		).toEqual([])
	})
	it('are announced after all when the change failed', () => {
		const marks = createSelfMarks()
		marks.mark('a', NOW)
		// The write was refused: whoever else changed it is news.
		marks.unmark('a')
		expect(
			dayNotices(daySnapshot(before), resized, {
				now: NOW,
				byUs: marks.live(NOW),
			}),
		).toHaveLength(1)
	})
	it('are forgotten once the day shows them', () => {
		const marks = createSelfMarks()
		marks.mark('a', NOW)
		marks.settle(daySnapshot(before), resized)
		expect(marks.size()).toBe(0)
		// Another host cancels it a while later: that is news.
		expect(
			dayNotices(daySnapshot(resized), cancelled, {
				now: NOW + 5 * 60_000,
				byUs: marks.live(NOW + 5 * 60_000),
			}),
		).toEqual([expect.objectContaining({ kind: 'cancelled' })])
	})
	it('are kept while the day has not shown them yet', () => {
		const marks = createSelfMarks()
		marks.mark('a', NOW)
		marks.settle(daySnapshot(before), before)
		expect(marks.size()).toBe(1)
	})
	it('are forgotten after a while, so a cancel after a long gap is still news', () => {
		const marks = createSelfMarks()
		marks.mark('a', NOW)
		expect(marks.live(NOW + SELF_MARK_MS).has('a')).toBe(true)
		const gap = NOW + SELF_MARK_MS + 1
		expect(marks.live(gap).has('a')).toBe(false)
		expect(
			dayNotices(daySnapshot(before), cancelled, {
				now: gap,
				byUs: marks.live(gap),
			}),
		).toEqual([expect.objectContaining({ kind: 'cancelled' })])
	})
})

describe('a summary of more than two changes', () => {
	const online = (id: string, over: Record<string, unknown> = {}) =>
		rsv({
			id,
			start: 19 * 60,
			channel: 'online',
			partySize: 2,
			createdAt: NOW - 60_000,
			guest: guest('Guest', id),
			...over,
		})
	it('counts what kind of change each is, in a fixed order', () => {
		const later = day([
			{ ...before.reservations[0]!, status: 'cancelled' },
			{ ...before.reservations[1]!, partySize: 6 },
			before.reservations[2]!,
			online('n1'),
			online('n2'),
			online('n3'),
		])
		const said = news(later)
		expect(said.summary).toBe(true)
		expect(said.toast).toBe('3 new, 1 cancelled, 1 changed')
	})
	it('says how many were VIPs or large parties, and stands out', () => {
		const later = day([
			...before.reservations,
			online('x1', { partySize: 12 }),
			online('x2', {
				guest: { ...guest('Vi', 'Pee'), tags: [{ id: 'v', name: 'VIP' }] },
			}),
			online('x3'),
		])
		const said = news(later)
		expect(said.toast).toBe('3 new · 2 VIPs or large parties')
		expect(said.highlight).toBe(true)
		expect(
			news(
				day([...before.reservations, online('x1'), online('x2'), online('x3')]),
			).highlight,
		).toBe(false)
	})
	it('names a large party and a VIP, one or two at a time', () => {
		const said = news(
			day([...before.reservations, online('x1', { partySize: 12 })]),
		)
		expect(said.toast).toBe('Large party: Guest X. booked 12 for 7:00 PM')
		expect(said.highlight).toBe(true)
		const both = news(
			day([
				...before.reservations,
				online('x2', {
					partySize: 9,
					guest: { ...guest('Vi', 'Pee'), tags: [{ id: 'v', name: 'VIP' }] },
				}),
			]),
		)
		expect(both.items[0]).toBe('VIP, large party: Vi P. booked 9 for 7:00 PM')
	})
	it('lists every booking that changed, and tags a new one and a resized one', () => {
		const said = news(
			day([
				before.reservations[0]!,
				{ ...before.reservations[1]!, partySize: 6 },
				before.reservations[2]!,
				online('n1'),
			]),
		)
		expect(said.ids).toEqual(['b', 'n1'])
		expect(said.tags).toEqual(
			new Map([
				['b', 'changed'],
				['n1', 'new'],
			]),
		)
	})
})

describe('the tags a changed row carries', () => {
	it('last a minute', () => {
		const tagged = new Map<string, { tag: 'new' | 'changed'; at: number }>([
			['a', { tag: 'new', at: NOW }],
			['b', { tag: 'changed', at: NOW - 30_000 }],
			['c', { tag: 'new', at: NOW - CHANGE_TAG_MS - 1 }],
		])
		expect(liveTags(tagged, NOW)).toEqual(
			new Map([
				['a', 'new'],
				['b', 'changed'],
			]),
		)
		expect(liveTags(tagged, NOW + CHANGE_TAG_MS).has('a')).toBe(true)
		expect(liveTags(tagged, NOW + CHANGE_TAG_MS + 1).has('a')).toBe(false)
	})
})
