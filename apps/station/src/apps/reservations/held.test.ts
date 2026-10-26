import { describe, expect, it } from 'vitest'
import { DUE_SOON_MIN, tableState } from './feed.ts'
import {
	bigTableFor,
	freeForMin,
	heldFor,
	heldLead,
	runsIntoNext,
} from './held.ts'
import { at, day, MIN, rsv } from './testing.ts'

const NOW = at(13 * 60)
const stateOf = (reservations: ReturnType<typeof rsv>[]) => {
	const feed = day(reservations)
	return tableState(
		feed.tables.find((t) => t.id === 't2')!,
		feed,
		NOW,
	)
}

describe('a table held for the next party', () => {
	it('is held once the party is due within the half hour', () => {
		const state = stateOf([
			rsv({ start: 13 * 60 + DUE_SOON_MIN, tableIds: ['t2'], partySize: 2 }),
		])
		expect(heldFor(state, NOW)).toMatchObject({
			lateMin: 0,
			atStand: false,
			canSeat: true,
		})
		// A minute further out, the table is simply open.
		expect(
			heldFor(
				stateOf([rsv({ start: 13 * 60 + DUE_SOON_MIN + 1, tableIds: ['t2'] })]),
				NOW,
			),
		).toBeNull()
	})

	it('says how late a party is that has not come', () => {
		const state = stateOf([
			rsv({ start: 13 * 60 - 35, tableIds: ['t2'], status: 'confirmed' }),
		])
		const held = heldFor(state, NOW)
		expect(held).toMatchObject({ lateMin: 35, canSeat: true })
		expect(held!.reservation.startAt).toBe(NOW - 35 * MIN)
	})

	it('knows a party at the stand, and seats from there too', () => {
		const state = stateOf([
			rsv({ start: 13 * 60 - 5, tableIds: ['t2'], status: 'arrived' }),
		])
		expect(heldFor(state, NOW)).toMatchObject({ atStand: true, canSeat: true })
	})

	it('can seat a party that is only partly here (the ones who are, as the stand picks them up)', () => {
		const state = stateOf([
			rsv({
				start: 13 * 60,
				tableIds: ['t2'],
				status: 'arrived',
				partySize: 4,
				arrivedCovers: 2,
			}),
		])
		expect(heldFor(state, NOW)).toMatchObject({ atStand: true, canSeat: true })
	})

	it('is nothing for an open, seated or blocked table', () => {
		expect(heldFor(stateOf([]), NOW)).toBeNull()
		expect(
			heldFor(
				stateOf([rsv({ start: 12 * 60, tableIds: ['t2'], status: 'seated' })]),
				NOW,
			),
		).toBeNull()
		const feed = day([], {
			blocks: [
				{
					id: 'b',
					tableId: 't2',
					startAt: NOW - MIN,
					endAt: NOW + 60 * MIN,
					reason: 'Leak',
				},
			],
		})
		const blocked = tableState(
			feed.tables.find((t) => t.id === 't2')!,
			feed,
			NOW,
		)
		expect(heldFor(blocked, NOW)).toBeNull()
	})
})

describe('what a held table leads with', () => {
	it('leads with the party when they are at the stand', () => {
		const held = heldFor(
			stateOf([
				rsv({ start: 13 * 60 - 5, tableIds: ['t2'], status: 'arrived' }),
			]),
			NOW,
		)!
		expect(heldLead(held)).toBe('party')
	})
	it('leads with the party when they are late, whatever else they are', () => {
		const held = heldFor(
			stateOf([
				rsv({ start: 13 * 60 - 1, tableIds: ['t2'], status: 'confirmed' }),
			]),
			NOW,
		)!
		expect(held.lateMin).toBe(1)
		expect(heldLead(held)).toBe('party')
	})
	it('leads with the walk-in for a party that is only due', () => {
		for (const minutes of [0, 10, DUE_SOON_MIN]) {
			const held = heldFor(
				stateOf([
					rsv({ start: 13 * 60 + minutes, tableIds: ['t2'], status: 'booked' }),
				]),
				NOW,
			)!
			expect(held.lateMin).toBe(0)
			expect(heldLead(held)).toBe('walk_in')
		}
	})
	it('leads with the walk-in when the till cannot seat the party at all', () => {
		const held = heldFor(
			stateOf([
				rsv({ start: 13 * 60 - 5, tableIds: ['t2'], status: 'arrived' }),
			]),
			NOW,
		)!
		expect(heldLead({ ...held, canSeat: false })).toBe('walk_in')
		const late = heldFor(
			stateOf([
				rsv({ start: 13 * 60 - 20, tableIds: ['t2'], status: 'booked' }),
			]),
			NOW,
		)!
		expect(heldLead({ ...late, canSeat: false })).toBe('walk_in')
	})
})

describe('how long a free table stays free', () => {
	it('is the minutes to the next booking, less the table’s reset', () => {
		const state = stateOf([
			rsv({ start: 13 * 60 + 28, tableIds: ['t2'], partySize: 2 }),
		])
		expect(freeForMin(state, { resetBufferMin: 0 }, NOW)).toBe(28)
		expect(freeForMin(state, { resetBufferMin: 10 }, NOW)).toBe(18)
		expect(freeForMin(state, {}, NOW)).toBe(28)
	})
	it('is zero for a booking already due, and never negative', () => {
		const state = stateOf([
			rsv({ start: 13 * 60 - 5, tableIds: ['t2'], partySize: 2 }),
		])
		expect(freeForMin(state, { resetBufferMin: 10 }, NOW)).toBe(0)
		const near = stateOf([
			rsv({ start: 13 * 60 + 8, tableIds: ['t2'], partySize: 2 }),
		])
		expect(freeForMin(near, { resetBufferMin: 10 }, NOW)).toBe(0)
	})
	it('is nothing for a table with nothing booked, or one that is not free', () => {
		expect(freeForMin(stateOf([]), {}, NOW)).toBeNull()
		const seated = stateOf([
			rsv({ start: 12 * 60, tableIds: ['t2'], status: 'seated' }),
		])
		expect(freeForMin(seated, {}, NOW)).toBeNull()
	})
	it('is short for a party when it is less than their stay', () => {
		expect(runsIntoNext(28, 90)).toBe(true)
		expect(runsIntoNext(90, 90)).toBe(false)
		expect(runsIntoNext(null, 90)).toBe(false)
	})
})

describe('a party much smaller than the table', () => {
	it('is under half its seats', () => {
		expect(bigTableFor(2, 10)).toBe(true)
		expect(bigTableFor(4, 8)).toBe(false)
		expect(bigTableFor(5, 10)).toBe(false)
		expect(bigTableFor(1, 2)).toBe(false)
		expect(bigTableFor(1, 3)).toBe(true)
	})
})
