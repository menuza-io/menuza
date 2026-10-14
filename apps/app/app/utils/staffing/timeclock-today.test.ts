import { describe, expect, it } from 'vitest'
import {
	filterTodayRows,
	minutesSinceClockIn,
	needsAttention,
	sortTodayRows,
	summarizeToday,
} from './timeclock-today.ts'
import { type TodayRow } from './timeclock-types.ts'

function row(overrides: Partial<TodayRow> = {}): TodayRow {
	return {
		entryId: 'e1',
		staffId: 's1',
		firstName: 'Rana',
		lastName: 'Khalid',
		scopeId: 'loc-1',
		timeZone: 'America/Chicago',
		positionId: null,
		positionName: null,
		positionNameAr: null,
		state: 'in',
		clockInAt: 1_000,
		breakStartAt: null,
		issues: [],
		late: false,
		missingClockOut: false,
		...overrides,
	}
}

describe('today list', () => {
	const rows = [
		row({ entryId: 'a', firstName: 'Ana', clockInAt: 3_000 }),
		row({
			entryId: 'b',
			firstName: 'Ben',
			clockInAt: 1_000,
			state: 'on_break',
		}),
		row({ entryId: 'c', firstName: 'Cy', clockInAt: 2_000, late: true }),
		row({
			entryId: 'd',
			firstName: 'Di',
			clockInAt: 4_000,
			missingClockOut: true,
		}),
	]

	it('puts attention first, then the longest on the clock', () => {
		expect(sortTodayRows(rows).map((r) => r.entryId)).toEqual([
			'c',
			'd',
			'b',
			'a',
		])
	})

	it('does not mutate its input', () => {
		const copy = [...rows]
		sortTodayRows(rows)
		expect(rows).toEqual(copy)
	})

	it('filters by state and attention', () => {
		expect(filterTodayRows(rows, 'all')).toHaveLength(4)
		expect(filterTodayRows(rows, 'on_break').map((r) => r.entryId)).toEqual([
			'b',
		])
		expect(filterTodayRows(rows, 'in')).toHaveLength(3)
		expect(filterTodayRows(rows, 'attention').map((r) => r.entryId)).toEqual([
			'c',
			'd',
		])
	})

	it('summarizes counts', () => {
		expect(summarizeToday(rows)).toEqual({
			total: 4,
			working: 3,
			onBreak: 1,
			attention: 2,
		})
		expect(summarizeToday([])).toEqual({
			total: 0,
			working: 0,
			onBreak: 0,
			attention: 0,
		})
	})

	it('counts minutes since clock-in and never goes negative', () => {
		expect(minutesSinceClockIn(row({ clockInAt: 0 }), 125_000)).toBe(2)
		expect(minutesSinceClockIn(row({ clockInAt: 10_000 }), 0)).toBe(0)
		expect(needsAttention(row())).toBe(false)
	})
})
