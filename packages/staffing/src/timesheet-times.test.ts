import { describe, expect, it } from 'vitest'
import {
	localTimeToInstant,
	resolveLocalBreakTimes,
	resolveLocalCardTimes,
} from './timesheet-times.ts'
import { localParts } from './tz.ts'

const CHI = 'America/Chicago'
const RUH = 'Asia/Riyadh'

const wall = (ms: number, tz: string) => {
	const p = localParts(ms, tz)
	return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

describe('resolveLocalCardTimes', () => {
	it('keeps a same-day shift on its day', () => {
		const t = resolveLocalCardTimes(
			{ date: '2026-03-02', startTime: '09:00', endTime: '17:30' },
			CHI,
		)
		expect(wall(t.clockInAt, CHI)).toBe('2026-03-02 09:00')
		expect(wall(t.clockOutAt, CHI)).toBe('2026-03-02 17:30')
		expect(t.clockOutAt - t.clockInAt).toBe(8.5 * 3_600_000)
	})

	it('rolls an overnight shift to the next day', () => {
		const t = resolveLocalCardTimes(
			{ date: '2026-03-02', startTime: '22:00', endTime: '02:00' },
			CHI,
		)
		expect(wall(t.clockOutAt, CHI)).toBe('2026-03-03 02:00')
		expect(t.clockOutAt - t.clockInAt).toBe(4 * 3_600_000)
	})

	it('treats equal start and end as a full 24 hours, never zero', () => {
		const t = resolveLocalCardTimes(
			{ date: '2026-03-02', startTime: '08:00', endTime: '08:00' },
			CHI,
		)
		expect(t.clockOutAt - t.clockInAt).toBe(24 * 3_600_000)
	})

	it('uses the scope zone, not the machine zone (Riyadh has no DST)', () => {
		const t = resolveLocalCardTimes(
			{ date: '2026-03-08', startTime: '20:00', endTime: '04:00' },
			RUH,
		)
		expect(t.clockInAt).toBe(Date.UTC(2026, 2, 8, 17, 0))
		expect(t.clockOutAt - t.clockInAt).toBe(8 * 3_600_000)
	})

	it('is DST-correct: a night shift over spring-forward is one hour short', () => {
		// 2026-03-08 02:00 Chicago does not exist; clocks jump to 03:00.
		const t = resolveLocalCardTimes(
			{ date: '2026-03-07', startTime: '22:00', endTime: '06:00' },
			CHI,
		)
		expect(t.clockOutAt - t.clockInAt).toBe(7 * 3_600_000)
	})

	it('is DST-correct: a night shift over fall-back is one hour long', () => {
		const t = resolveLocalCardTimes(
			{ date: '2026-10-31', startTime: '22:00', endTime: '06:00' },
			CHI,
		)
		expect(t.clockOutAt - t.clockInAt).toBe(9 * 3_600_000)
	})
})

describe('resolveLocalBreakTimes', () => {
	it('places a break inside the card, including after midnight', () => {
		const card = resolveLocalCardTimes(
			{ date: '2026-03-02', startTime: '22:00', endTime: '06:00' },
			CHI,
		)
		const early = resolveLocalBreakTimes(
			{ startTime: '23:30', endTime: '00:00' },
			card.clockInAt,
			CHI,
		)
		expect(wall(early.startAt, CHI)).toBe('2026-03-02 23:30')
		expect(wall(early.endAt, CHI)).toBe('2026-03-03 00:00')
		const late = resolveLocalBreakTimes(
			{ startTime: '02:00', endTime: '02:30' },
			card.clockInAt,
			CHI,
		)
		expect(wall(late.startAt, CHI)).toBe('2026-03-03 02:00')
		expect(late.endAt - late.startAt).toBe(30 * 60_000)
	})
})

describe('localTimeToInstant', () => {
	it('resolves a time inside a spring-forward gap to the instant after it', () => {
		const ms = localTimeToInstant('2026-03-08', '02:30', CHI)
		expect(wall(ms, CHI)).toBe('2026-03-08 03:30')
	})
})
