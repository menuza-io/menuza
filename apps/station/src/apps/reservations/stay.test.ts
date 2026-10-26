import { describe, expect, it } from 'vitest'
import {
	canExtendStay,
	clearAtOf,
	EXTEND_STEP_MIN,
	extendPlan,
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

describe('a party seated late', () => {
	// Booked at 7:00 for 90 minutes, seated at 7:50: the booking ends at 8:30.
	const late = (over: Record<string, unknown> = {}) =>
		rsv({
			start: 19 * 60,
			status: 'seated',
			seatedAt: at(19 * 60 + 50),
			durationMin: 90,
			...over,
		})
	it('clears when their own stay is up, not at the booking’s end', () => {
		expect(clearAtOf(late())).toBe(at(21 * 60 + 20))
		const stay = stayOf(late(), at(20 * 60 + 30))!
		expect(stay.over).toBe(false)
		expect(stay.clearAt).toBe(at(21 * 60 + 20))
		expect(stay.leftMin).toBe(50)
		// 40 minutes into a 90 minute stay.
		expect(stay.ratio).toBeCloseTo(40 / 90)
	})
	it('is over only once that later time has passed', () => {
		expect(stayOf(late(), at(21 * 60 + 20))).toMatchObject({ over: true })
		expect(stayOf(late(), at(21 * 60 + 35))).toMatchObject({
			over: true,
			overMin: 15,
		})
		expect(stayOf(late(), at(21 * 60 + 35))!.ratio).toBeGreaterThan(1)
	})
	it('keeps the booking’s end for a party seated on time or early', () => {
		const early = late({ seatedAt: at(18 * 60 + 55) })
		expect(clearAtOf(early)).toBe(at(20 * 60 + 30))
	})
})

describe('a longer stay from a till', () => {
	it('is at most what a till may set', () => {
		expect(EXTEND_STEP_MIN).toBe(15)
		const r = (durationMin: number) =>
			sitting({ durationMin, endAt: at(12 * 60 + durationMin) })
		expect(canExtendStay(r(90), NOW)).toBe(true)
		expect(canExtendStay(r(MAX_TILL_STAY_MIN - 15), at(12 * 60))).toBe(true)
		expect(canExtendStay(r(MAX_TILL_STAY_MIN - 14), at(12 * 60))).toBe(false)
		expect(canExtendStay(r(MAX_TILL_STAY_MIN), at(12 * 60))).toBe(false)
	})
	it('adds a quarter hour to a stay that is not up yet', () => {
		const plan = extendPlan(sitting(), at(13 * 60))
		expect(plan).toEqual({
			ok: true,
			durationMin: 105,
			clearAt: at(13 * 60 + 45),
		})
	})
	it('gives a party over their time a quarter hour from now, not from a time long past', () => {
		// 12:00 for 90 minutes; at 14:10 they are 40 minutes over.
		const plan = extendPlan(sitting(), at(14 * 60 + 10))
		expect(plan).toEqual({
			ok: true,
			// Until 14:25, counted from 12:00.
			durationMin: 145,
			clearAt: at(14 * 60 + 25),
		})
		if (plan.ok) expect(plan.clearAt).toBeGreaterThan(at(14 * 60 + 10))
	})
	it('extends a late seating from its own clear time', () => {
		const lateParty = rsv({
			start: 19 * 60,
			status: 'seated',
			seatedAt: at(19 * 60 + 50),
			durationMin: 90,
		})
		const plan = extendPlan(lateParty, at(20 * 60))
		// The booking now ends at 8:45 (105 minutes); the stay from 7:50 ends 9:35.
		expect(plan).toEqual({
			ok: true,
			durationMin: 105,
			clearAt: at(21 * 60 + 35),
		})
	})
	it('refuses what would pass the longest stay, and says so', () => {
		const long = sitting({ durationMin: 350, endAt: at(12 * 60 + 350) })
		expect(extendPlan(long, at(13 * 60))).toEqual({
			ok: false,
			why: 'too_long',
		})
		// An overdue party's quarter hour is counted from now: it can cross the cap too.
		const overdue = sitting({ durationMin: 300, endAt: at(12 * 60 + 300) })
		expect(extendPlan(overdue, at(12 * 60 + 355))).toEqual({
			ok: false,
			why: 'too_long',
		})
	})
})
