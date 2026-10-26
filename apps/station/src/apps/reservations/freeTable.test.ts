import { describe, expect, it } from 'vitest'
import { type TableKind } from './feed.ts'
import {
	FREE_OFFER_MS,
	newlyFree,
	offerKey,
	pickOffer,
	tableKinds,
} from './freeTable.ts'
import { at, day, entry, MIN, rsv } from './testing.ts'

const NOW = at(13 * 60)
const kinds = (pairs: Record<string, TableKind>) =>
	new Map(Object.entries(pairs))

describe('a table that has just freed up', () => {
	it('is one that was seated or being reset and is free now', () => {
		const before = kinds({
			t1: 'seated',
			t2: 'resetting',
			t3: 'open',
			t4: 'blocked',
		})
		const after = kinds({ t1: 'open', t2: 'soon', t3: 'open', t4: 'open' })
		expect(newlyFree(before, after)).toEqual(['t1', 't2'])
	})
	it('is nothing on a first look, or for a table still taken', () => {
		const after = kinds({ t1: 'open', t2: 'seated' })
		expect(newlyFree(null, after)).toEqual([])
		expect(newlyFree(kinds({ t1: 'seated', t2: 'seated' }), after)).toEqual([
			't1',
		])
		// A party seated here moves to being reset: still taken, not newly free.
		expect(
			newlyFree(kinds({ t1: 'seated' }), kinds({ t1: 'resetting' })),
		).toEqual([])
		// A table blocked, then unblocked, was never someone's.
		expect(newlyFree(kinds({ t1: 'blocked' }), kinds({ t1: 'open' }))).toEqual(
			[],
		)
	})
	it('reads each live table’s kind from the day', () => {
		const feed = day([
			rsv({
				start: 12 * 60,
				status: 'seated',
				tableIds: ['t2'],
				seatedAt: at(12 * 60),
			}),
		])
		const map = tableKinds(feed, NOW)
		expect(map.get('t2')).toBe('seated')
		expect(map.get('t1')).toBe('open')
		expect(map.size).toBe(4)
	})
})

describe('who a freed table is offered to', () => {
	const waiting = (over: Parameters<typeof entry>[0]) =>
		entry({ status: 'waiting', joinedAt: NOW - 5 * MIN, ...over })
	const offer = (
		reservations: ReturnType<typeof rsv>[],
		waitlist: ReturnType<typeof entry>[],
		extra: { freed?: string[]; dismissed?: string[] } = {},
	) =>
		pickOffer({
			freed: extra.freed ?? ['t2'],
			feed: day(reservations),
			waitlist,
			now: NOW,
			dismissed: new Set(extra.dismissed ?? []),
		})

	it('is the waitlist party who has waited longest and fits', () => {
		const a = waiting({ id: 'a', partySize: 4, joinedAt: NOW - 13 * MIN })
		const b = waiting({ id: 'b', partySize: 2, joinedAt: NOW - 20 * MIN })
		const made = offer([], [a, b])!
		// Table 2 seats 4: both fit, and b has waited longest.
		expect(made.placing).toMatchObject({ kind: 'waitlist', entry: { id: 'b' } })
		expect(made).toMatchObject({ size: 2, waitedMin: 20, table: { id: 't2' } })
		expect(made.key).toBe(offerKey('t2', 'w:b'))
	})
	it('passes over a party too big for the table, to the next', () => {
		const big = waiting({ id: 'big', partySize: 6, joinedAt: NOW - 30 * MIN })
		const small = waiting({ id: 'small', partySize: 3 })
		expect(offer([], [big, small])!.placing).toMatchObject({
			entry: { id: 'small' },
		})
		expect(offer([], [big])).toBeNull()
	})
	it('is a good match for the table: not a party so small that its minimum goes to waste', () => {
		// Table 10 seats four to eight.
		const two = waiting({ id: 'two', partySize: 2, joinedAt: NOW - 30 * MIN })
		const five = waiting({ id: 'five', partySize: 5, joinedAt: NOW - 5 * MIN })
		expect(offer([], [two, five], { freed: ['t10'] })!.placing).toMatchObject({
			entry: { id: 'five' },
		})
		expect(offer([], [two], { freed: ['t10'] })).toBeNull()
		// The same goes for a booked party at the stand.
		const small = rsv({ start: 12 * 60 + 50, status: 'arrived', partySize: 2 })
		expect(offer([small], [], { freed: ['t10'] })).toBeNull()
		expect(offer([small], [], { freed: ['t2'] })).not.toBeNull()
		// A party exactly at the minimum, or the maximum, is a match.
		for (const partySize of [4, 8])
			expect(
				offer([], [waiting({ partySize })], { freed: ['t10'] }),
			).not.toBeNull()
		expect(
			offer([], [waiting({ partySize: 9 })], { freed: ['t10'] }),
		).toBeNull()
	})
	it('counts a party told their table is ready, but not one seated or gone', () => {
		const told = waiting({
			id: 'told',
			status: 'notified',
			joinedAt: NOW - 25 * MIN,
		})
		expect(offer([], [told])!.placing).toMatchObject({ entry: { id: 'told' } })
		for (const status of [
			'seated',
			'left',
			'cancelled',
			'no_response',
		] as const)
			expect(offer([], [waiting({ status })])).toBeNull()
	})
	it('falls back to a booked party already at the stand', () => {
		const here = rsv({ start: 12 * 60 + 50, status: 'arrived', partySize: 3 })
		const made = offer([here], [])!
		expect(made.placing).toMatchObject({
			kind: 'reservation',
			reservation: { id: here.id },
		})
		expect(made.waitedMin).toBeNull()
		// The waitlist comes first when both could take it.
		const w = waiting({ id: 'w', partySize: 2 })
		expect(offer([here], [w])!.placing.kind).toBe('waitlist')
	})
	it('does not offer a party who is only expected, late, or already seated', () => {
		for (const status of ['booked', 'confirmed', 'seated', 'finished'])
			expect(
				offer([rsv({ start: 12 * 60 + 40, status, partySize: 2 })], []),
			).toBeNull()
	})
	it('does not offer a table that is taken again, or a party who would clash with a booking', () => {
		const sitting = rsv({
			start: 13 * 60,
			status: 'seated',
			tableIds: ['t2'],
			seatedAt: NOW,
		})
		expect(offer([sitting], [waiting({})])).toBeNull()
		// A booking on the table in 30 minutes: a turn of 90 does not fit before it.
		const next = rsv({
			start: 13 * 60 + 30,
			tableIds: ['t2'],
			status: 'confirmed',
		})
		expect(offer([next], [waiting({})])).toBeNull()
		// An hour and a half, plus: it does.
		const later = rsv({
			start: 14 * 60 + 30,
			tableIds: ['t2'],
			status: 'confirmed',
		})
		expect(offer([later], [waiting({})])).not.toBeNull()
	})
	it('is never made twice for the same table and party, once put away', () => {
		const a = waiting({ id: 'a', partySize: 2, joinedAt: NOW - 20 * MIN })
		const b = waiting({ id: 'b', partySize: 2, joinedAt: NOW - 10 * MIN })
		const key = offerKey('t2', 'w:a')
		// A is put away: the table goes to B, not A again.
		expect(offer([], [a, b], { dismissed: [key] })!.placing).toMatchObject({
			entry: { id: 'b' },
		})
		expect(offer([], [a], { dismissed: [key] })).toBeNull()
		// Another table freeing is a new offer for A.
		expect(offer([], [a], { freed: ['p1'], dismissed: [key] })!.table.id).toBe(
			'p1',
		)
	})
	it('goes through the freed tables in the order given, and skips one that is gone', () => {
		const w = waiting({ id: 'w', partySize: 2 })
		expect(offer([], [w], { freed: ['nope', 'p1', 't2'] })!.table.id).toBe('p1')
		expect(offer([], [w], { freed: [] })).toBeNull()
	})
	it('stays on offer for a quarter hour', () => {
		expect(FREE_OFFER_MS).toBe(15 * MIN)
	})
})
