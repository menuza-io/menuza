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
import { MAX_SPOKEN, newsOf } from './news.ts'
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
		expect(news(before)).toEqual({ items: [], toast: null })
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
		expect(news(later).toast).toBe('New online booking: Omar S., 4 at 7:30 PM')
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
		expect(news(cancelled).toast).toBe('Cancelled: Priya N., 8:00 PM')
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
		expect(news(resized).toast).toBe('Party size changed: Omar R., 4 to 6')
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
		expect(news(arrived).toast).toBe('Priya N. has arrived.')
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
		expect(news(vip).toast).toBe('VIP guest has arrived: Chris T..')
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
		expect(result.toast).toBe('2 updates at the stand')
		expect(result.items).toEqual([
			'Priya N. has arrived.',
			'Cancelled: Omar R., 8:15 PM',
		])
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
		expect(said.items.slice(0, MAX_SPOKEN).join(' ')).toContain(
			'New online booking',
		)
		// The toast is one count, not fifty lines.
		expect(said.toast).toBe('50 updates at the stand')
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
			}),
		).toEqual({ items: [], toast: null })
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
