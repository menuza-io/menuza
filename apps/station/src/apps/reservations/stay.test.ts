import { describe, expect, it } from 'vitest'
import {
	canExtendStay,
	EXTEND_STEP_MIN,
	MAX_TILL_STAY_MIN,
	stayOf,
} from './stay.ts'
import { at, MIN, rsv } from './testing.ts'

const NOW = at(13 * 60 + 30)
// Seated at 12:00 for a 90 minute stay.
const sitting = (over: Record<string, unknown> = {}) =>
	rsv({
		start: 12 * 60,
		status: 'seated',
		seatedAt: at(12 * 60),
		durationMin: 90,
		...over,
	})

describe('a seated party’s stay', () => {
	it('says how long they have sat and when the table should clear', () => {
		const stay = stayOf(sitting(), at(12 * 60 + 62))
		expect(stay).toMatchObject({
			seatedMin: 62,
			clearAt: at(13 * 60 + 30),
			leftMin: 28,
			overMin: 0,
			over: false,
		})
		expect(stay!.ratio).toBeCloseTo(62 / 90)
	})
	it('rounds the time left up: 20 seconds is still "1m left"', () => {
		expect(stayOf(sitting(), NOW - 20_000)!.leftMin).toBe(1)
		expect(stayOf(sitting(), NOW - 61_000)!.leftMin).toBe(2)
	})
	it('is over from the minute it is due, and says by how much', () => {
		expect(stayOf(sitting(), NOW)).toMatchObject({
			over: true,
			leftMin: 0,
			overMin: 0,
		})
		expect(stayOf(sitting(), NOW + 12 * MIN + 5000)).toMatchObject({
			over: true,
			overMin: 12,
		})
		expect(stayOf(sitting(), NOW + 12 * MIN)!.ratio).toBeGreaterThan(1)
	})
	it('counts a "+15 min" in the booking’s own end', () => {
		const longer = sitting({
			durationMin: 105,
			endAt: at(12 * 60 + 105),
		})
		expect(stayOf(longer, at(13 * 60 + 30))).toMatchObject({
			over: false,
			leftMin: 15,
		})
	})
	it('is nothing for a party that is not seated, or has no seating time', () => {
		expect(stayOf(rsv({ start: 600, status: 'booked' }), NOW)).toBeNull()
		expect(stayOf(rsv({ start: 600, status: 'finished' }), NOW)).toBeNull()
		expect(stayOf(sitting({ seatedAt: null }), NOW)).toBeNull()
	})
	it('never reads below zero minutes seated (a clock behind the server)', () => {
		expect(stayOf(sitting(), at(11 * 60 + 50))!.seatedMin).toBe(0)
	})
})

describe('a longer stay from a till', () => {
	it('adds a quarter hour at a time, up to what a till may set', () => {
		expect(EXTEND_STEP_MIN).toBe(15)
		expect(canExtendStay({ durationMin: 90 })).toBe(true)
		expect(canExtendStay({ durationMin: MAX_TILL_STAY_MIN - 15 })).toBe(true)
		expect(canExtendStay({ durationMin: MAX_TILL_STAY_MIN - 14 })).toBe(false)
		expect(canExtendStay({ durationMin: MAX_TILL_STAY_MIN })).toBe(false)
	})
})
