import { describe, expect, it } from 'vitest'
import { DUE_SOON_MIN, tableState } from './feed.ts'
import { heldFor } from './held.ts'
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

	it('cannot seat a party that is only partly here', () => {
		const state = stateOf([
			rsv({ start: 13 * 60, tableIds: ['t2'], status: 'partially_arrived' }),
		])
		expect(heldFor(state, NOW)).toMatchObject({ atStand: true, canSeat: false })
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
