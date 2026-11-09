import { describe, expect, it } from 'vitest'
import {
	hijriMonth,
	isRamadan,
	MAX_DEMAND_BP,
	MIN_DEMAND_BP,
	NEUTRAL_DEMAND_BP,
	suggestPrepAmount,
	weekdayDemand,
	type DailyUnits,
} from './prep.ts'

const FRIDAY = '2026-02-06'

/** The 28 days before `FRIDAY` (a Friday outside Ramadan): Fridays sell `fridayUnits`, other days `otherUnits`. */
function history(fridayUnits: number, otherUnits: number): DailyUnits[] {
	return Array.from({ length: 28 }, (_, index) => {
		const date = new Date(Date.UTC(2026, 1, 6 - (index + 1)))
			.toISOString()
			.slice(0, 10)
		return {
			date,
			units:
				new Date(`${date}T12:00:00Z`).getUTCDay() === 5
					? fridayUnits
					: otherUnits,
		}
	})
}

describe('Ramadan', () => {
	it('reads the Hijri month of a date', () => {
		// Ramadan 1447 ran from 18 February to 19 March 2026.
		expect(isRamadan('2026-02-25')).toBe(true)
		expect(isRamadan('2026-03-01')).toBe(true)
		expect(isRamadan('2026-01-15')).toBe(false)
		expect(isRamadan('2026-04-10')).toBe(false)
		expect(hijriMonth('2026-02-25')).toBe(9)
	})

	it('answers null for something that is not a date', () => {
		expect(hijriMonth('nope')).toBeNull()
		expect(isRamadan('')).toBe(false)
	})
})

describe('weekdayDemand', () => {
	const friday = FRIDAY

	it('is above normal on a day that usually sells more', () => {
		const result = weekdayDemand({
			date: friday,
			history: history(240, 100),
		})
		expect(result.known).toBe(true)
		expect(result.samples).toBe(4)
		// Friday sells 240 against a mean of (4*240 + 24*100) / 28 = 120: +100%, capped.
		expect(result.bp).toBe(MAX_DEMAND_BP)
	})

	it('is a modest nudge for a modest difference', () => {
		const result = weekdayDemand({ date: friday, history: history(120, 100) })
		// mean = (4*120+24*100)/28 = 102.86 -> 120/102.86 = 1.1667
		expect(result.bp).toBe(11_667)
	})

	it('never goes below half', () => {
		expect(weekdayDemand({ date: friday, history: history(5, 100) }).bp).toBe(
			MIN_DEMAND_BP,
		)
	})

	it('says nothing with too little history, and ignores days with no sales', () => {
		expect(weekdayDemand({ date: friday, history: [] })).toMatchObject({
			bp: NEUTRAL_DEMAND_BP,
			known: false,
		})
		const sparse = history(200, 0).filter((entry) => entry.units > 0)
		// Only four Fridays, no other days: not enough days to compare with.
		expect(weekdayDemand({ date: friday, history: sparse }).known).toBe(false)
	})

	it('only looks at the last 28 days and never at the day itself or later', () => {
		const old = [{ date: '2025-01-03', units: 9_999 }]
		const future = [{ date: friday, units: 9_999 }]
		const base = history(120, 100)
		expect(
			weekdayDemand({ date: friday, history: [...base, ...old, ...future] }),
		).toEqual(weekdayDemand({ date: friday, history: base }))
	})

	it('compares Ramadan days with Ramadan days, and other days with other days', () => {
		const ramadanDate = '2026-03-06' // a Friday in Ramadan
		const ramadanDays: DailyUnits[] = Array.from({ length: 28 }, (_, n) => {
			const date = new Date(Date.UTC(2026, 1, 6 + n)).toISOString().slice(0, 10)
			return { date, units: 100 }
		})
		const result = weekdayDemand({
			date: ramadanDate,
			history: ramadanDays,
		})
		expect(result.ramadan).toBe(true)
		// Only the days in Ramadan count, and they are all equal: normal.
		expect(result.bp).toBe(NEUTRAL_DEMAND_BP)
		// A normal-month Friday ignores the Ramadan days entirely.
		const outside = weekdayDemand({
			date: '2026-05-01',
			history: ramadanDays.map((entry) => ({ ...entry, units: 500 })),
		})
		expect(outside.ramadan).toBe(false)
		expect(outside.known).toBe(false)
	})
})

describe('suggestPrepAmount', () => {
	it('fills up to the level and rounds up to whole batches', () => {
		// Fill up to 6 L, have 2 L, a batch is 4 L: needs 4 L, one batch.
		expect(
			suggestPrepAmount({
				fillUpTo: 6_000_000,
				onHand: 2_000_000,
				demandBp: NEUTRAL_DEMAND_BP,
				batchSize: 4_000_000,
			}),
		).toEqual({ amount: 4_000_000, batches: 1, target: 6_000_000 })
		// Needs 4.5 L: two batches.
		expect(
			suggestPrepAmount({
				fillUpTo: 6_500_000,
				onHand: 2_000_000,
				demandBp: NEUTRAL_DEMAND_BP,
				batchSize: 4_000_000,
			}),
		).toMatchObject({ amount: 8_000_000, batches: 2 })
	})

	it('scales the level by how busy the day is', () => {
		expect(
			suggestPrepAmount({
				fillUpTo: 6_000_000,
				onHand: 0,
				demandBp: 12_000,
				batchSize: null,
			}),
		).toEqual({ amount: 7_200_000, batches: null, target: 7_200_000 })
	})

	it('makes nothing when there is enough, and treats negative stock as none', () => {
		expect(
			suggestPrepAmount({
				fillUpTo: 6_000_000,
				onHand: 6_000_000,
				demandBp: NEUTRAL_DEMAND_BP,
				batchSize: 4_000_000,
			}),
		).toEqual({ amount: 0, batches: 0, target: 6_000_000 })
		expect(
			suggestPrepAmount({
				fillUpTo: 3_000_000,
				onHand: -2_000_000,
				demandBp: NEUTRAL_DEMAND_BP,
				batchSize: null,
			}).amount,
		).toBe(3_000_000)
	})
})
