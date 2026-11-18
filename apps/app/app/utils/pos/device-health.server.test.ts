import { describe, expect, it } from 'vitest'
import { buildHealthWindow } from './device-health.server.ts'

const week = (open: boolean) =>
	JSON.stringify(
		[
			'monday',
			'tuesday',
			'wednesday',
			'thursday',
			'friday',
			'saturday',
			'sunday',
		].map((day) => ({
			day,
			isOpen: open,
			slots: open ? [{ start: '09:00', end: '22:00' }] : [],
		})),
	)

describe('buildHealthWindow', () => {
	const now = Date.UTC(2026, 10, 18, 15, 0) // Wednesday 15:00 UTC

	it('lists the last seven local days, today last, and the hours the location was open', () => {
		const window = buildHealthWindow(
			{
				timezone: 'UTC',
				isActive: true,
				storeHours: week(true),
				onlineHours: null,
				specialHours: null,
			},
			now,
		)
		expect(window.days.map((d) => d.date)).toEqual([
			'2026-11-12',
			'2026-11-13',
			'2026-11-14',
			'2026-11-15',
			'2026-11-16',
			'2026-11-17',
			'2026-11-18',
		])
		expect(window.days[6]).toEqual({
			date: '2026-11-18',
			startMs: Date.UTC(2026, 10, 18),
			endMs: Date.UTC(2026, 10, 19),
		})
		expect(window.open).toHaveLength(7)
		expect(window.open![6]).toEqual({
			startMs: Date.UTC(2026, 10, 18, 9),
			endMs: Date.UTC(2026, 10, 18, 22, 0) + 60_000,
		})
	})

	it('counts days in the location’s own time zone', () => {
		const window = buildHealthWindow(
			{
				timezone: 'America/New_York',
				isActive: true,
				storeHours: week(true),
				onlineHours: null,
				specialHours: null,
			},
			Date.UTC(2026, 10, 18, 3, 0), // still the 17th in New York
		)
		expect(window.days.at(-1)?.date).toBe('2026-11-17')
		expect(window.days.at(-1)?.startMs).toBe(Date.UTC(2026, 10, 17, 5))
	})

	it('knows no hours for a terminal with no location, or a location with none set', () => {
		expect(buildHealthWindow(null, now).open).toBeNull()
		expect(
			buildHealthWindow(
				{
					timezone: 'UTC',
					isActive: true,
					storeHours: null,
					onlineHours: null,
					specialHours: null,
				},
				now,
			).open,
		).toBeNull()
	})

	it('has no open time for a location that is closed all week', () => {
		expect(
			buildHealthWindow(
				{
					timezone: 'UTC',
					isActive: true,
					storeHours: week(false),
					onlineHours: null,
					specialHours: null,
				},
				now,
			).open,
		).toEqual([])
	})
})
