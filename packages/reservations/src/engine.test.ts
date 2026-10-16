import { describe, expect, it } from 'vitest'
import { planBooking } from './assign.ts'
import {
	MAX_CALENDAR_EXPANSIONS,
	type EngineDayConfig,
	alternatives,
	calendarSummary,
	quoteWaitlistMin,
	searchAvailability,
	searchExperienceAvailability,
	suggestAlternatives,
} from './engine.ts'
import { localToInstant } from './time.ts'

function makeTestConfig(): EngineDayConfig {
	return {
		timeZone: 'America/New_York',
		settings: {
			enabled: true,
			onlineEnabled: true,
			dayStartMin: 240,
			intervalMin: 15,
			horizonDays: 60,
			releaseLocalMin: 0,
			minNoticeMin: 30,
			sameDayCutoffMin: null,
			minParty: 1,
			maxOnlineParty: 6,
			maxParty: 10,
			largePartyMode: 'request',
			seatingPreferenceMode: 'indoor_outdoor',
			defaultTurnMin: 60,
			bufferMin: 15,
			holdTtlSec: 300,
			assignmentFreezeMin: 60,
			graceMin: 15,
			autoNoShowMin: null,
			maxActivePerPhone: 3,
			modifyCutoffMin: 120,
			waitlistEnabled: true,
			notifyMeEnabled: true,
		},
		areas: [
			{
				id: 'area_main',
				name: 'Main Dining',
				color: '#2563EB',
				isOutdoor: false,
				sortOrder: 0,
				active: true,
			},
			{
				id: 'area_patio',
				name: 'Patio',
				color: '#10B981',
				isOutdoor: true,
				sortOrder: 1,
				active: true,
			},
		],
		tables: [
			{
				id: 't1',
				areaId: 'area_main',
				label: 'T1',
				minSeats: 1,
				maxSeats: 2,
				onlineBookable: true,
				combinable: true,
				priority: 10,
				active: true,
			},
			{
				id: 't2',
				areaId: 'area_main',
				label: 'T2',
				minSeats: 2,
				maxSeats: 4,
				onlineBookable: true,
				combinable: true,
				priority: 5,
				active: true,
			},
			{
				id: 't3',
				areaId: 'area_patio',
				label: 'P1',
				minSeats: 2,
				maxSeats: 4,
				onlineBookable: true,
				combinable: false,
				priority: 8,
				active: true,
			},
		],
		combinations: [],
		services: [
			{
				id: 'srv_dinner',
				name: 'Dinner',
				slug: 'dinner',
				color: '#2563EB',
				daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
				startMin: 17 * 60,
				endMin: 21 * 60,
				firstSeatingMin: 17 * 60,
				lastSeatingMin: 19 * 60,
				onlineBookable: true,
				sortOrder: 0,
				active: true,
			},
		],
		turnTimeBuckets: [],
		pacingRules: [],
		serviceTableModes: [],
		specialDays: [],
	}
}

const nowMs = localToInstant(
	'2026-06-10',
	12 * 60,
	'America/New_York',
).instantMs

describe('engine barrel exports and VAL-FND-006 / I3 unit tests', () => {
	it('re-exports searchAvailability, suggestAlternatives, alternatives, calendarSummary, searchExperienceAvailability, and quoteWaitlistMin', () => {
		expect(MAX_CALENDAR_EXPANSIONS).toBe(5_000)
		expect(typeof searchAvailability).toBe('function')
		expect(typeof suggestAlternatives).toBe('function')
		expect(typeof alternatives).toBe('function')
		expect(typeof calendarSummary).toBe('function')
		expect(typeof searchExperienceAvailability).toBe('function')
		expect(typeof quoteWaitlistMin).toBe('function')
	})

	it('enforces online_cap_per_interval, concurrent_covers_cap, and rolling_min/rolling_max_covers (filtering guest slots and warning on staff slots)', () => {
		const config = makeTestConfig()
		config.serviceTableModes = [
			{
				id: 'sa_1',
				serviceId: 'srv_dinner',
				areaId: 'area_main',
				mode: 'online',
				onlineCapPerInterval: 2,
				concurrentCoversCap: 4,
			},
		]
		config.pacingRules = [
			{
				id: 'pr_rolling',
				serviceId: 'srv_dinner',
				rollingMin: 30,
				rollingMaxCovers: 4,
			},
		]

		const slot1800 = localToInstant(
			'2026-06-12',
			18 * 60,
			'America/New_York',
		).instantMs
		const occupancies = [
			{
				id: 'occ_1800',
				kind: 'reservation' as const,
				status: 'booked',
				channel: 'online' as const,
				serviceId: 'srv_dinner',
				areaId: 'area_main',
				partySize: 2,
				localStartMin: 18 * 60,
				startAt: slot1800,
				endAt: slot1800 + 75 * 60_000,
				tableIds: ['t1'],
			},
		]

		// 1. online_cap_per_interval = 2 in area_main: another online party of 2 at 18:00 in area_main exceeds cap (2 + 2 = 4 > 2)
		const onlineAreaMain = searchAvailability({
			config,
			businessDate: '2026-06-12',
			partySize: 2,
			areaId: 'area_main',
			nowMs,
			channel: 'online',
			occupancies,
		})
		expect(onlineAreaMain.slots.some((s) => s.slotMin === 18 * 60)).toBe(false)

		// 2. rolling_min = 30 / rolling_max_covers = 4: at 18:15 (within 30m of 18:00), a party of 4 exceeds rolling cap (2 + 4 = 6 > 4)
		const onlineRolling = searchAvailability({
			config,
			businessDate: '2026-06-12',
			partySize: 4,
			nowMs,
			channel: 'online',
			occupancies,
		})
		expect(onlineRolling.slots.some((s) => s.slotMin === 18 * 60 + 15)).toBe(
			false,
		)

		// 3. concurrent_covers_cap = 4 in area_main: at 18:30 (outside 30m rolling window, inside 18:00..19:15 occupancy), party of 4 in area_main has 2 + 4 = 6 > 4 concurrent covers
		const onlineConcurrent = searchAvailability({
			config,
			businessDate: '2026-06-12',
			partySize: 4,
			areaId: 'area_main',
			nowMs,
			channel: 'online',
			occupancies,
		})
		expect(onlineConcurrent.slots.some((s) => s.slotMin === 18 * 60 + 30)).toBe(
			false,
		)

		// 4. Staff channel receives slots with warnings instead of filtering them out
		const hostAvail = searchAvailability({
			config,
			businessDate: '2026-06-12',
			partySize: 4,
			areaId: 'area_main',
			nowMs,
			channel: 'host',
			occupancies,
		})
		const hostSlot1800 = hostAvail.slots.find((s) => s.slotMin === 18 * 60)
		expect(hostSlot1800).toBeDefined()
		expect(hostSlot1800?.warnings).toContain('rolling_covers_exceeded')
		expect(hostSlot1800?.warnings).toContain('concurrent_covers_exceeded')

		// 5. planBooking enforces the same caps (rejecting online, warning on host)
		const onlinePlan = planBooking({
			partySize: 4,
			slotMin: 18 * 60,
			startAt: slot1800,
			endAt: slot1800 + 75 * 60_000,
			channel: 'online',
			serviceId: 'srv_dinner',
			areaId: 'area_main',
			tables: config.tables,
			areas: config.areas,
			combinations: config.combinations,
			serviceTableModes: config.serviceTableModes,
			pacingRules: config.pacingRules,
			bookings: occupancies.map((o) => ({
				...o,
				tableIds: [...(o.tableIds ?? [])],
			})),
			nowMs,
		})
		expect(onlinePlan.assigned).toBe(false)

		const hostPlan = planBooking({
			partySize: 4,
			slotMin: 18 * 60,
			startAt: slot1800,
			endAt: slot1800 + 75 * 60_000,
			channel: 'host',
			serviceId: 'srv_dinner',
			areaId: 'area_main',
			tables: config.tables,
			areas: config.areas,
			combinations: config.combinations,
			serviceTableModes: config.serviceTableModes,
			pacingRules: config.pacingRules,
			bookings: occupancies.map((o) => ({
				...o,
				tableIds: [...(o.tableIds ?? [])],
			})),
			nowMs,
		})
		expect(hostPlan.assigned).toBe(true)
		if (hostPlan.assigned) {
			expect(hostPlan.warnings).toContain('rolling_covers_exceeded')
			expect(hostPlan.warnings).toContain('concurrent_covers_exceeded')
		}
	})

	it('enforces per-table reset_buffer_min overriding location bufferMin', () => {
		const config = makeTestConfig()
		// Keep only t2 (capacity 2..4) with a 30m resetBufferMin (vs location bufferMin = 15m)
		config.tables = [
			{
				id: 't2',
				areaId: 'area_main',
				label: 'T2',
				minSeats: 2,
				maxSeats: 4,
				resetBufferMin: 30,
				onlineBookable: true,
				combinable: false,
				priority: 5,
				active: true,
			},
		]
		const slot1700 = localToInstant(
			'2026-06-12',
			17 * 60,
			'America/New_York',
		).instantMs
		// A 18:15 booking starts 75m after 17:00. With default 60m turn + 15m location buffer, 17:00..18:15 wouldn't overlap 18:15,
		// but with t2.resetBufferMin = 30m, 17:00 requires [17:00, 18:30), which overlaps the 18:15 booking!
		const slot1815 = localToInstant(
			'2026-06-12',
			18 * 60 + 15,
			'America/New_York',
		).instantMs
		const avail = searchAvailability({
			config,
			businessDate: '2026-06-12',
			partySize: 2,
			nowMs,
			channel: 'online',
			occupancies: [
				{
					id: 'occ_1815',
					kind: 'reservation',
					status: 'booked',
					channel: 'online',
					serviceId: 'srv_dinner',
					partySize: 2,
					localStartMin: 18 * 60 + 15,
					startAt: slot1815,
					endAt: slot1815 + 90 * 60_000,
					tableIds: ['t2'],
				},
			],
		})
		expect(avail.slots.some((s) => s.slotMin === 17 * 60)).toBe(false)
		expect(avail.slots.some((s) => s.slotMin === 16 * 60 + 45)).toBe(false)
		expect(slot1700).toBeLessThan(slot1815)
	})

	it('counts staff overbook rows as occupying their tables so online never borrows capacity from staff overbook (Invariant I3)', () => {
		const config = makeTestConfig()
		config.tables = [
			{
				id: 't1',
				areaId: 'area_main',
				label: 'T1',
				minSeats: 1,
				maxSeats: 2,
				onlineBookable: true,
				combinable: false,
				priority: 10,
				active: true,
			},
		]
		const slot1800 = localToInstant(
			'2026-06-12',
			18 * 60,
			'America/New_York',
		).instantMs
		const overbookOcc = [
			{
				id: 'occ_overbook',
				kind: 'reservation' as const,
				status: 'booked',
				channel: 'host' as const,
				serviceId: 'srv_dinner',
				partySize: 2,
				localStartMin: 18 * 60,
				startAt: slot1800,
				endAt: slot1800 + 75 * 60_000,
				tableIds: ['t1'],
				overbook: true,
			},
		]

		const onlineAvail = searchAvailability({
			config,
			businessDate: '2026-06-12',
			partySize: 2,
			nowMs,
			channel: 'online',
			occupancies: overbookOcc,
		})
		// 18:00 is occupied by the staff overbook on t1, so online must NOT see 18:00 as available
		expect(onlineAvail.slots.some((s) => s.slotMin === 18 * 60)).toBe(false)
	})

	it('excludes staff_only and unavailable tables on guest channels and unavailable tables on all channels', () => {
		const config = makeTestConfig()
		config.tables = [
			{
				id: 't_staff',
				areaId: 'area_main',
				label: 'TS',
				minSeats: 1,
				maxSeats: 4,
				onlineBookable: true,
				combinable: false,
				active: true,
			},
			{
				id: 't_unavail',
				areaId: 'area_main',
				label: 'TU',
				minSeats: 1,
				maxSeats: 4,
				onlineBookable: true,
				combinable: false,
				active: true,
			},
		]
		config.serviceTableModes = [
			{
				id: 'm1',
				serviceId: 'srv_dinner',
				tableId: 't_staff',
				mode: 'staff_only',
			},
			{
				id: 'm2',
				serviceId: 'srv_dinner',
				tableId: 't_unavail',
				mode: 'unavailable',
			},
		]

		const guestAvail = searchAvailability({
			config,
			businessDate: '2026-06-12',
			partySize: 2,
			nowMs,
			channel: 'online',
		})
		expect(guestAvail.slots).toHaveLength(0)

		const staffAvail = searchAvailability({
			config,
			businessDate: '2026-06-12',
			partySize: 2,
			nowMs,
			channel: 'host',
		})
		expect(staffAvail.slots.length).toBeGreaterThan(0)
		expect(
			staffAvail.slots.every(
				(s) =>
					s.tableIds.includes('t_staff') && !s.tableIds.includes('t_unavail'),
			),
		).toBe(true)
	})

	it('returns { sameDay, otherDates } from alternatives()', () => {
		const config = makeTestConfig()
		const alts = alternatives({
			config,
			businessDate: '2026-06-12',
			partySize: 2,
			preferredSlotMin: 18 * 60,
			nowMs,
			channel: 'online',
			dayOffsets: [-1, 1],
		})
		expect(Array.isArray(alts.sameDay)).toBe(true)
		expect(alts.sameDay.length).toBeGreaterThan(0)
		expect(Array.isArray(alts.otherDates)).toBe(true)
		expect(alts.otherDates.length).toBe(2)
		expect(alts.otherDates[0]).toEqual(
			expect.objectContaining({
				date: '2026-06-11',
				firstLocalMin: expect.any(Number),
			}),
		)
		expect(alts.otherDates[1]).toEqual(
			expect.objectContaining({
				date: '2026-06-13',
				firstLocalMin: expect.any(Number),
			}),
		)
	})
})
