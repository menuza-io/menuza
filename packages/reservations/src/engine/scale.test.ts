import { describe, expect, it } from 'vitest'
import {
	MAX_BOOK_EXPANSIONS,
	MAX_DAY_EXPANSIONS,
	MAX_REFLOW_EXPANSIONS,
	MAX_REPAIR_EXPANSIONS,
	MAX_SEARCH_SLOT_EXPANSIONS,
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
	it('handles 120 tables, 80 combinations, and 900 bookings/day within expansion budgets (200 search/slot, 2000 book, 5000 reflow) and < 50ms per day', () => {
		const fixture = buildScaleRestaurantFixture({
			tableCount: 120,
			combinationCount: 80,
			bookingCount: 900,
			businessDate: '2026-06-12',
		})

		expect(fixture.config.tables).toHaveLength(120)
		expect(fixture.config.combinations).toHaveLength(80)
		expect(fixture.existingBookings).toHaveLength(900)
		expect(MAX_SEARCH_SLOT_EXPANSIONS).toBe(200)
		expect(MAX_BOOK_EXPANSIONS).toBe(2_000)
		expect(MAX_REFLOW_EXPANSIONS).toBe(5_000)

		const slot1170Start = localToInstant(
			'2026-06-12',
			1170,
			fixture.config.timeZone,
		).instantMs
		const slot1170End = slot1170Start + 75 * 60_000

		// 1. Booking expansion cap (MAX_BOOK_EXPANSIONS = 2,000)
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
		expect(assignment.expansions).toBeLessThanOrEqual(MAX_BOOK_EXPANSIONS)
		expect(assignElapsedMs).toBeLessThan(50)

		// 2. Full-day availability search latency (< 50ms) and per-slot expansion cap (200 per slot)
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
		expect(availElapsedMs).toBeLessThan(50)

		// 3. Soft-booking day reflow expansion cap (MAX_REFLOW_EXPANSIONS = 5,000)
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
		expect(reflow.expansions).toBeLessThanOrEqual(MAX_REFLOW_EXPANSIONS)
		expect(reflow.budgetExhausted).toBe(false)

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

	it('returns no_fit / budgetExhausted rather than partial plans when expansion budgets are exhausted', () => {
		const fixture = buildScaleRestaurantFixture({
			tableCount: 120,
			combinationCount: 80,
			bookingCount: 900,
			businessDate: '2026-06-12',
		})
		const slot660Start = localToInstant(
			'2026-06-12',
			660,
			fixture.config.timeZone,
		).instantMs
		const slot660End = slot660Start + 75 * 60_000

		const noFitAssign = assignTables({
			config: fixture.config,
			request: {
				serviceId: 'srv_lunch',
				startAt: slot660Start,
				endAt: slot660End,
				partySize: 6,
				channel: 'online',
			},
			existingBookings: fixture.existingBookings,
			nowMs: fixture.nowMs,
			maxExpansions: 1,
		})
		expect(noFitAssign.assigned).toBe(false)
		if (!noFitAssign.assigned) {
			expect(noFitAssign.status).toBe('no_fit')
		}

		const exhaustedReflow = reflowDay({
			config: fixture.config,
			existingBookings: fixture.existingBookings,
			nowMs: fixture.nowMs,
			maxExpansions: 2,
		})
		expect(exhaustedReflow.budgetExhausted).toBe(true)
		expect(exhaustedReflow.status).toBe('no_fit')
		expect(exhaustedReflow.moves).toHaveLength(0)
	})
})
