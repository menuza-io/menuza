import { i18n } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import { dayNotices, daySnapshot, newArrivals } from './book.ts'
import { newsOf } from './news.ts'
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
