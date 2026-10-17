import { describe, expect, it } from 'vitest'
import {
	DEFAULT_DAY_START_MIN,
	serviceDayBusinessDate,
} from './business-date.ts'

describe('serviceDayBusinessDate', () => {
	it('stays on the previous day before the day start in Los Angeles', () => {
		// 2026-04-21 01:30 PDT (08:30 UTC): the UTC date is already the 21st.
		const nowMs = Date.UTC(2026, 3, 21, 8, 30)
		expect(serviceDayBusinessDate(nowMs, 'America/Los_Angeles', 240)).toBe(
			'2026-04-20',
		)
	})

	it('rolls over at the day start, not at midnight', () => {
		// 2026-04-21 04:00 PDT is exactly 11:00 UTC.
		expect(
			serviceDayBusinessDate(
				Date.UTC(2026, 3, 21, 10, 59),
				'America/Los_Angeles',
				240,
			),
		).toBe('2026-04-20')
		expect(
			serviceDayBusinessDate(
				Date.UTC(2026, 3, 21, 11, 0),
				'America/Los_Angeles',
				240,
			),
		).toBe('2026-04-21')
	})

	it('uses the local date east of UTC when the UTC date is still behind', () => {
		// 2026-04-21 22:30 in Riyadh (UTC+3) is 19:30 UTC on the same date.
		const evening = Date.UTC(2026, 3, 21, 19, 30)
		expect(serviceDayBusinessDate(evening, 'Asia/Riyadh', 240)).toBe(
			'2026-04-21',
		)
		// 2026-04-22 01:30 in Riyadh is 22:30 UTC on the 21st; still the 21st.
		const afterMidnight = Date.UTC(2026, 3, 21, 22, 30)
		expect(serviceDayBusinessDate(afterMidnight, 'Asia/Riyadh', 240)).toBe(
			'2026-04-21',
		)
		expect(serviceDayBusinessDate(afterMidnight, 'Asia/Riyadh', 0)).toBe(
			'2026-04-22',
		)
	})

	it('falls back to the default day start and UTC for unusable inputs', () => {
		const nowMs = Date.UTC(2026, 3, 21, 2, 0)
		expect(serviceDayBusinessDate(nowMs, 'Not/AZone', undefined)).toBe(
			serviceDayBusinessDate(nowMs, 'UTC', DEFAULT_DAY_START_MIN),
		)
		expect(serviceDayBusinessDate(nowMs, null, Number.NaN)).toBe('2026-04-20')
	})
})
