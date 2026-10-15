import { describe, expect, it } from 'vitest'
import {
	MAX_DAY_EXPANSIONS,
	MAX_REPAIR_EXPANSIONS,
	assignTables,
	reflowDay,
} from '../assign.ts'
import {
	MAX_CALENDAR_EXPANSIONS,
	calendarAvailabilitySummary,
	searchAvailability,
} from '../engine.ts'
import { buildScaleRestaurantFixture } from '../testing/index.ts'
import { localToInstant } from '../time.ts'

describe('reservations engine scale and bounded expansion budget tests', () => {
	it('handles 120 tables, 80 combinations, and 900 bookings/day within expansion budgets and < 50ms per day', () => {
		const fixture = buildScaleRestaurantFixture({
			tableCount: 120,
			combinationCount: 80,
			bookingCount: 900,
			businessDate: '2026-06-12',
		})

		expect(fixture.config.tables).toHaveLength(120)
		expect(fixture.config.combinations).toHaveLength(80)
		expect(fixture.existingBookings).toHaveLength(900)

		const slot1170Start = localToInstant(
			'2026-06-12',
			1170,
			fixture.config.timeZone,
		).instantMs
		const slot1170End = slot1170Start + 75 * 60_000

		// 1. Single-slot repair expansion cap (MAX_REPAIR_EXPANSIONS = 200)
		const t0 = performance.now()
		const assignment = assignTables({
			config: fixture.config,
			request: {
				serviceId: 'srv_dinner',
				startAt: slot1170Start,
				endAt: slot1170End,
				partySize: 4,
				channel: 'online',
			},
			existingBookings: fixture.existingBookings,
			nowMs: fixture.nowMs,
		})
		const assignElapsedMs = performance.now() - t0
		expect(assignment.expansions).toBeLessThanOrEqual(MAX_REPAIR_EXPANSIONS)
		expect(assignElapsedMs).toBeLessThan(50)

		// 2. Full-day availability search latency (< 50ms) and expansion cap (MAX_DAY_EXPANSIONS = 2,000)
		const t1 = performance.now()
		const dayAvail = searchAvailability({
			config: fixture.config,
			businessDate: '2026-06-12',
			partySize: 4,
			preferredSlotMin: 1170,
			channel: 'online',
			existingBookings: fixture.existingBookings,
			nowMs: fixture.nowMs,
		})
		const availElapsedMs = performance.now() - t1
		expect(dayAvail.slots.length).toBeGreaterThan(0)
		expect(dayAvail.expansionsUsed).toBeLessThanOrEqual(MAX_DAY_EXPANSIONS)
		expect(availElapsedMs).toBeLessThan(50)

		// 3. Soft-booking day reflow expansion cap (MAX_DAY_EXPANSIONS = 2,000)
		const blkStart = localToInstant(
			'2026-06-12',
			1080,
			fixture.config.timeZone,
		).instantMs
		const blkEnd = localToInstant(
			'2026-06-12',
			1320,
			fixture.config.timeZone,
		).instantMs
		const reflow = reflowDay({
			config: fixture.config,
			existingBookings: fixture.existingBookings,
			tableBlocks: [
				{
					id: 'blk_scale_1',
					tableIds: [fixture.config.tables[0]!.id],
					startAt: blkStart,
					endAt: blkEnd,
				},
			],
			nowMs: fixture.nowMs,
		})
		expect(reflow.expansions).toBeLessThanOrEqual(MAX_DAY_EXPANSIONS)

		// 4. Calendar summary expansion cap (MAX_CALENDAR_EXPANSIONS = 5,000)
		const cal = calendarAvailabilitySummary({
			config: fixture.config,
			fromDate: '2026-06-12',
			toDate: '2026-06-18',
			partySize: 4,
			bookingsByDate: {
				'2026-06-12': fixture.existingBookings,
			},
			nowMs: fixture.nowMs,
		})
		expect(cal.days).toHaveLength(7)
		expect(cal.expansionsUsed).toBeLessThanOrEqual(MAX_CALENDAR_EXPANSIONS)
		expect(MAX_CALENDAR_EXPANSIONS).toBe(5_000)
	})
})
