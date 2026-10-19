import { describe, expect, it } from 'vitest'
import {
	bookingCovers,
	computePacingSlots,
	configuredTurnMinutes,
	isBookedStatus,
	type PacingInputRow,
} from './rsv-report-shared.ts'

describe('bookingCovers', () => {
	it('uses the actual covers when recorded, otherwise the party size', () => {
		expect(bookingCovers({ partySize: 6, coversActual: 4 })).toBe(4)
		expect(bookingCovers({ partySize: 6, coversActual: null })).toBe(6)
		expect(bookingCovers({ partySize: 6, coversActual: 0 })).toBe(0)
	})

	it('never reads the seated count, even for a finished party', () => {
		const finished = {
			status: 'finished',
			partySize: 6,
			coversActual: null,
			seatedCovers: 3,
		}
		expect(bookingCovers(finished)).toBe(6)
	})
})

describe('isBookedStatus', () => {
	it('leaves out cancelled, declined and expired only', () => {
		for (const status of ['cancelled', 'declined', 'expired']) {
			expect(isBookedStatus(status)).toBe(false)
		}
		for (const status of ['booked', 'no_show', 'finished', 'seated']) {
			expect(isBookedStatus(status)).toBe(true)
		}
	})
})

describe('computePacingSlots', () => {
	const row = (patch: Partial<PacingInputRow>): PacingInputRow => ({
		businessDate: '2031-03-10',
		localStartMin: 1140,
		serviceId: 'svc',
		partySize: 2,
		coversActual: null,
		status: 'booked',
		locationId: 'loc',
		...patch,
	})
	const rule = {
		serviceId: 'svc',
		channel: 'all',
		fromMin: null,
		toMin: null,
		maxCovers: 6,
		maxParties: null,
	}

	it('counts bookings and covers per slot against the limit', () => {
		const slots = computePacingSlots(
			[
				row({}),
				row({ partySize: 5, coversActual: 5 }),
				row({ status: 'cancelled' }),
				row({ localStartMin: 1200 }),
			],
			[rule],
		)
		expect(slots).toHaveLength(2)
		expect(slots[0]).toMatchObject({
			bookings: 2,
			covers: 7,
			maxCovers: 6,
			overLimit: true,
		})
		expect(slots[1]).toMatchObject({ bookings: 1, covers: 2, overLimit: false })
	})

	it('keeps locations apart and ignores limits on other channels', () => {
		const slots = computePacingSlots(
			[row({}), row({ locationId: 'other' })],
			[{ ...rule, channel: 'online', maxCovers: 1 }],
		)
		expect(slots).toHaveLength(2)
		expect(slots.every((slot) => slot.maxCovers === null)).toBe(true)
	})
})

describe('configuredTurnMinutes', () => {
	it('prefers a service rule over a general one and honors the weekday mask', () => {
		const rules = [
			{
				serviceId: null,
				partyMin: 1,
				partyMax: 4,
				minutes: 60,
				daysMask: null,
			},
			{
				serviceId: 's1',
				partyMin: 1,
				partyMax: 4,
				minutes: 45,
				daysMask: null,
			},
		]
		expect(configuredTurnMinutes(rules, 2, 's1', '2031-03-10')).toBe(45)
		expect(configuredTurnMinutes(rules, 2, 's2', '2031-03-10')).toBe(60)
		expect(configuredTurnMinutes(rules, 9, 's1', '2031-03-10')).toBeNull()
		// 2031-03-10 is a Monday. The mask is Monday-first: bit 0 = Monday, bit 6 = Sunday.
		const mondayOnly = [
			{ serviceId: null, partyMin: 1, partyMax: 4, minutes: 30, daysMask: 1 },
		]
		expect(configuredTurnMinutes(mondayOnly, 2, null, '2031-03-10')).toBe(30)
		expect(configuredTurnMinutes(mondayOnly, 2, null, '2031-03-11')).toBeNull()
		const sundayOnly = [
			{ serviceId: null, partyMin: 1, partyMax: 4, minutes: 30, daysMask: 64 },
		]
		expect(configuredTurnMinutes(sundayOnly, 2, null, '2031-03-10')).toBeNull()
		expect(configuredTurnMinutes(sundayOnly, 2, null, '2031-03-09')).toBe(30)
	})
})
