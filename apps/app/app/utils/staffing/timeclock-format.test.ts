import { describe, expect, it } from 'vitest'
import {
	formatClockDateTime,
	formatClockTime,
	formatCountdown,
	formatDuration,
	formatRelativeTime,
	minutesBetween,
} from './timeclock-format.ts'

describe('timeclock format', () => {
	it('shows clock times in the workplace zone, not the viewer zone', () => {
		const at = Date.UTC(2026, 2, 2, 15, 3)
		expect(formatClockTime(at, 'America/Chicago', 'en-US')).toMatch(/9:03/)
		expect(formatClockTime(at, 'Asia/Riyadh', 'en-US')).toMatch(/6:03/)
	})

	it('survives an unknown zone name', () => {
		expect(() => formatClockTime(0, 'Not/AZone', 'en')).not.toThrow()
	})

	it('formats durations without negatives', () => {
		expect(formatDuration(192)).toBe('3h 12m')
		expect(formatDuration(45)).toBe('45m')
		expect(formatDuration(120)).toBe('2h')
		expect(formatDuration(-5)).toBe('0m')
		expect(formatDuration(90, { hour: 'س', minute: 'د' })).toBe('1س 30د')
		expect(minutesBetween(10_000, 5_000)).toBe(0)
		expect(minutesBetween(0, 125_000)).toBe(2)
	})

	it('formats relative time in both languages', () => {
		const now = 1_000_000_000
		expect(formatRelativeTime(now - 10_000, now, 'en')).toBe('now')
		expect(formatRelativeTime(now - 5 * 60_000, now, 'en')).toBe(
			'5 minutes ago',
		)
		expect(formatRelativeTime(now - 3 * 3600_000, now, 'en')).toBe(
			'3 hours ago',
		)
		expect(formatRelativeTime(now - 3 * 86_400_000, now, 'en')).toBe(
			'3 days ago',
		)
		expect(formatRelativeTime(now - 5 * 60_000, now, 'ar')).not.toBe('')
	})

	it('counts down to zero and no further', () => {
		expect(formatCountdown(9 * 60_000 + 41_000)).toBe('9:41')
		expect(formatCountdown(500)).toBe('0:01')
		expect(formatCountdown(-1000)).toBe('0:00')
	})

	it('names the weekday only when the moment is on another local day', () => {
		const now = Date.UTC(2026, 2, 2, 16, 0) // 10:00 in Chicago
		const sameDay = Date.UTC(2026, 2, 2, 15, 3)
		const yesterday = Date.UTC(2026, 2, 1, 21, 21)
		expect(formatClockDateTime(sameDay, now, 'America/Chicago', 'en-US')).toBe(
			formatClockTime(sameDay, 'America/Chicago', 'en-US'),
		)
		expect(
			formatClockDateTime(yesterday, now, 'America/Chicago', 'en-US'),
		).toMatch(/^Sun /)
		// 23:30 UTC is already the next day in Riyadh, so it names the weekday there.
		const late = Date.UTC(2026, 2, 2, 23, 30)
		expect(formatClockDateTime(late, now, 'Asia/Riyadh', 'en-US')).toMatch(
			/^Tue /,
		)
	})
})
