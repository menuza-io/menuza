import { describe, expect, it } from 'vitest'
import {
	ALTERNATIVE_DELTAS_MIN,
	MAX_ALTERNATIVES,
	MAX_CALENDAR_EXPANSIONS,
	calendarSummary,
	resolveTurnTimeMin,
	searchAvailability,
	searchExperienceAvailability,
	suggestAlternatives,
	type EngineDayConfig,
	type ExistingOccupancyInput,
} from './availability.ts'
import { localToInstant } from '../time.ts'

function makeBaseConfig(): EngineDayConfig {
	return {
		timeZone: 'America/New_York',
		settings: {
			enabled: true,
			onlineEnabled: true,
			dayStartMin: 240,
			intervalMin: 15,
			horizonDays: 30,
			releaseLocalMin: 540, // 09:00
			minNoticeMin: 30,
			sameDayCutoffMin: null,
			minParty: 1,
			maxOnlineParty: 6,
			maxParty: 12,
			largePartyMode: 'request',
			seatingPreferenceMode: 'any',
			defaultTurnMin: 90,
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
				minSeats: 2,
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
				priority: 0,
				isPatio: true,
				active: true,
			},
		],
		combinations: [
			{
				id: 'combo_12',
				name: 'T1+T2',
				minSeats: 5,
				maxSeats: 6,
				priority: 0,
				onlineBookable: true,
				active: true,
				tableIds: ['t1', 't2'],
			},
		],
		services: [
			{
				id: 'srv_dinner',
				name: 'Dinner',
				slug: 'dinner',
				color: '#2563EB',
				daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
				startMin: 17 * 60, // 17:00 (1020)
				endMin: 22 * 60, // 22:00 (1320)
				lastSeatingMin: 20 * 60 + 30, // 20:30 (1230)
				onlineBookable: true,
				sortOrder: 0,
				active: true,
			},
		],
		turnTimeBuckets: [
			{
				id: 'tt_small',
				serviceId: 'srv_dinner',
				minParty: 1,
				maxParty: 2,
				durationMin: 60,
			},
			{
				id: 'tt_med',
				serviceId: 'srv_dinner',
				minParty: 3,
				maxParty: 4,
				durationMin: 90,
			},
			{
				id: 'tt_large',
				serviceId: 'srv_dinner',
				minParty: 5,
				maxParty: 8,
				durationMin: 120,
			},
		],
		pacingRules: [],
		serviceTableModes: [],
		specialDays: [],
	}
}

describe('availability engine, pacing, alternatives, calendar, and experiences', () => {
	const nowMs = localToInstant(
		'2026-06-10',
		10 * 60,
		'America/New_York',
	).instantMs

	it('resolves turn times by service bucket, fallback bucket, and defaultTurnMin', () => {
		const config = makeBaseConfig()
		expect(resolveTurnTimeMin(config, 'srv_dinner', 2)).toBe(60)
		expect(resolveTurnTimeMin(config, 'srv_dinner', 4)).toBe(90)
		expect(resolveTurnTimeMin(config, 'srv_dinner', 6)).toBe(120)
		expect(resolveTurnTimeMin(config, 'srv_other', 4)).toBe(90)
	})

	it('generates candidate slots on interval_min up to min(last_seating_min, end_min - turn_min)', () => {
		const config = makeBaseConfig()
		// For partySize = 2: turnMin = 60, endMin - turnMin = 1320 - 60 = 1260 (21:00).
		// min(lastSeatingMin=1230, 1260) = 1230 (20:30).
		const res = searchAvailability({
			config,
			businessDate: '2026-06-12',
			partySize: 2,
			nowMs,
			channel: 'online',
		})
		expect(res.status).toBe('available')
		expect(res.slots[0]?.slotMin).toBe(17 * 60)
		expect(res.slots[res.slots.length - 1]?.slotMin).toBe(20 * 60 + 30)

		// For partySize = 6: turnMin = 120, endMin - turnMin = 1320 - 120 = 1200 (20:00).
		// min(lastSeatingMin=1230, 1200) = 1200 (20:00).
		const resLarge = searchAvailability({
			config,
			businessDate: '2026-06-12',
			partySize: 6,
			nowMs,
			channel: 'online',
		})
		expect(resLarge.status).toBe('available')
		expect(resLarge.slots[resLarge.slots.length - 1]?.slotMin).toBe(20 * 60)
	})

	it('enforces party bounds, largePartyMode, horizon + releaseLocalMin, minNoticeMin, and sameDayCutoffMin', () => {
		const config = makeBaseConfig()

		// Large party (partySize 8 > maxOnlineParty 6, <= maxParty 12)
		const large = searchAvailability({
			config,
			businessDate: '2026-06-12',
			partySize: 8,
			nowMs,
			channel: 'online',
		})
		expect(large.status).toBe('large_party')
		expect(large.largePartyMode).toBe('request')
		expect(large.slots).toHaveLength(0)

		// Beyond horizon (31 days ahead > horizonDays 30)
		const beyond = searchAvailability({
			config,
			businessDate: '2026-07-11',
			partySize: 2,
			nowMs,
			channel: 'online',
		})
		expect(beyond.status).toBe('beyond_horizon')

		// On the 30th day (2026-07-10) before releaseLocalMin (08:30 < 09:00)
		const beforeReleaseNow = localToInstant(
			'2026-06-10',
			8 * 60 + 30,
			'America/New_York',
		).instantMs
		const notReleasedYet = searchAvailability({
			config,
			businessDate: '2026-07-10',
			partySize: 2,
			nowMs: beforeReleaseNow,
			channel: 'online',
		})
		expect(notReleasedYet.status).toBe('beyond_horizon')

		// Same day with minNoticeMin = 60 when now is 17:10 -> first slot is 18:15
		const sameDayNow = localToInstant(
			'2026-06-10',
			17 * 60 + 10,
			'America/New_York',
		).instantMs
		const sameDay = searchAvailability({
			config: {
				...config,
				settings: { ...config.settings, minNoticeMin: 60 },
			},
			businessDate: '2026-06-10',
			partySize: 2,
			nowMs: sameDayNow,
			channel: 'online',
		})
		expect(sameDay.slots[0]?.slotMin).toBe(18 * 60 + 15)

		// Same day cutoff exceeded
		const cutoffBlocked = searchAvailability({
			config: {
				...config,
				settings: { ...config.settings, sameDayCutoffMin: 16 * 60 },
			},
			businessDate: '2026-06-10',
			partySize: 2,
			nowMs: sameDayNow,
			channel: 'online',
		})
		expect(cutoffBlocked.slots).toHaveLength(0)
	})

	it('enforces location-wide and area-specific pacing caps (maxCoversPerSlot, maxPartiesPerSlot, maxOnlineCoversForService)', () => {
		const config = makeBaseConfig()
		config.pacingRules = [
			{
				id: 'pace_global',
				serviceId: 'srv_dinner',
				areaId: null,
				windowStartMin: null,
				windowEndMin: null,
				maxCoversPerSlot: 4,
				maxPartiesPerSlot: 2,
				maxOnlineCoversForService: 6,
			},
		]

		const slot1800 = localToInstant(
			'2026-06-12',
			18 * 60,
			'America/New_York',
		).instantMs
		const slot1930 = localToInstant(
			'2026-06-12',
			19 * 60 + 30,
			'America/New_York',
		).instantMs

		// Existing 4-top at 18:00 (online) consumes 4 covers in the 18:00 slot
		const occupancies: ExistingOccupancyInput[] = [
			{
				id: 'res_1',
				kind: 'reservation',
				status: 'booked',
				channel: 'online',
				serviceId: 'srv_dinner',
				areaId: 'area_main',
				partySize: 4,
				localStartMin: 18 * 60,
				startAt: slot1800,
				endAt: slot1800 + 105 * 60_000,
				tableIds: ['t2'],
			},
		]

		// Requesting partySize 2 at 18:00 exceeds maxCoversPerSlot=4 (4 + 2 = 6 > 4)
		const avail1 = searchAvailability({
			config,
			businessDate: '2026-06-12',
			partySize: 2,
			nowMs,
			channel: 'online',
			occupancies,
		})
		expect(avail1.slots.some((s) => s.slotMin === 18 * 60)).toBe(false)
		expect(avail1.slots.some((s) => s.slotMin === 18 * 60 + 15)).toBe(true)

		// Add another 2-top online booking at 19:30 -> total online covers in service = 6 = maxOnlineCoversForService
		occupancies.push({
			id: 'res_2',
			kind: 'reservation',
			status: 'booked',
			channel: 'online',
			serviceId: 'srv_dinner',
			areaId: 'area_main',
			partySize: 2,
			localStartMin: 19 * 60 + 30,
			startAt: slot1930,
			endAt: slot1930 + 75 * 60_000,
			tableIds: ['t1'],
		})
		const avail2 = searchAvailability({
			config,
			businessDate: '2026-06-12',
			partySize: 2,
			nowMs,
			channel: 'online',
			occupancies,
		})
		expect(avail2.slots).toHaveLength(0)

		// Staff channels (phone, host, walk_in, waitlist) surface pacing breaches as warnings rather than hiding slots (VAL-FND-006)
		for (const staffChannel of [
			'phone',
			'host',
			'walk_in',
			'waitlist',
		] as const) {
			const staffAvail = searchAvailability({
				config,
				businessDate: '2026-06-12',
				partySize: 2,
				nowMs,
				channel: staffChannel,
				occupancies,
			})
			const slot1800Item = staffAvail.slots.find((s) => s.slotMin === 18 * 60)
			expect(slot1800Item).toBeDefined()
			expect(slot1800Item?.warnings).toContain('slot_covers_exceeded')
		}
	})

	it('allows walk_in_only tables only for walk_in and waitlist channels, and skips spring-forward gap slots (VAL-FND-003, VAL-FND-006)', () => {
		const config = makeBaseConfig()
		config.tables = [
			{
				id: 't_walkin',
				name: 'Bar Walk-In',
				areaId: 'area_main',
				minSeats: 1,
				maxSeats: 4,
				onlineBookable: true,
				walkInOnly: true,
				combinable: false,
				priority: 10,
				active: true,
			},
		]
		config.combinations = []

		for (const ch of [
			'online',
			'native',
			'voice_agent',
			'phone',
			'host',
		] as const) {
			const res = searchAvailability({
				config,
				businessDate: '2026-06-12',
				partySize: 2,
				nowMs,
				channel: ch,
			})
			expect(res.slots).toHaveLength(0)
		}

		for (const ch of ['walk_in', 'waitlist'] as const) {
			const res = searchAvailability({
				config,
				businessDate: '2026-06-12',
				partySize: 2,
				nowMs,
				channel: ch,
			})
			expect(res.slots.length).toBeGreaterThan(0)
		}

		// Spring-forward gap on 2027-03-14 in America/New_York: 02:00..02:59 slots must be skipped
		const dstConfig = makeBaseConfig()
		dstConfig.services = [
			{
				id: 'srv_overnight',
				name: 'Late Night',
				slug: 'late-night',
				daysMask: 0b1111111,
				startMin: 1 * 60,
				firstSeatingMin: 1 * 60 + 30,
				lastSeatingMin: 3 * 60 + 30,
				endMin: 5 * 60,
				slotIntervalMin: 30,
				onlineBookable: true,
			},
		]
		const dstAvail = searchAvailability({
			config: dstConfig,
			businessDate: '2027-03-14',
			partySize: 2,
			nowMs: localToInstant('2027-03-13', 12 * 60, 'America/New_York')
				.instantMs,
			channel: 'online',
		})
		const returnedMins = dstAvail.slots.map((s) => s.slotMin)
		expect(returnedMins).toContain(1 * 60 + 30)
		expect(returnedMins).not.toContain(2 * 60)
		expect(returnedMins).not.toContain(2 * 60 + 30)
		expect(returnedMins).toContain(3 * 60)
		expect(returnedMins).toContain(3 * 60 + 30)
	})

	it('suggests up to 6 nearest alternatives at ±15..±120 minutes when preferred slot is full', () => {
		expect(ALTERNATIVE_DELTAS_MIN).toEqual([
			-15, 15, -30, 30, -45, 45, -60, 60, -90, 90, -120, 120,
		])
		expect(MAX_ALTERNATIVES).toBe(6)

		const config = makeBaseConfig()
		// Block all tables at 19:00..20:15 so 19:00 is unavailable
		const slot1900 = localToInstant(
			'2026-06-12',
			19 * 60,
			'America/New_York',
		).instantMs
		const occupancies: ExistingOccupancyInput[] = ['t1', 't2', 't3'].map(
			(tid, idx) => ({
				id: `occ_${idx}`,
				kind: 'reservation',
				status: 'booked',
				channel: 'online',
				serviceId: 'srv_dinner',
				partySize: 2,
				localStartMin: 19 * 60,
				startAt: slot1900,
				endAt: slot1900 + 75 * 60_000,
				tableIds: [tid],
			}),
		)

		const avail = searchAvailability({
			config,
			businessDate: '2026-06-12',
			partySize: 2,
			preferredSlotMin: 19 * 60,
			nowMs,
			channel: 'online',
			occupancies,
		})
		expect(avail.slots.some((s) => s.slotMin === 19 * 60)).toBe(false)
		expect(avail.alternatives.length).toBeGreaterThan(0)
		expect(avail.alternatives.length).toBeLessThanOrEqual(6)

		const directAlts = suggestAlternatives(avail.slots, 19 * 60)
		expect(directAlts.length).toBeLessThanOrEqual(6)
		// Every returned alternative must be within 120 minutes of 19:00
		expect(directAlts.every((s) => Math.abs(s.slotMin - 19 * 60) <= 120)).toBe(
			true,
		)
	})

	it('computes calendarSummary across a date range within MAX_CALENDAR_EXPANSIONS', () => {
		expect(MAX_CALENDAR_EXPANSIONS).toBe(5_000)
		const config = makeBaseConfig()
		config.specialDays = [
			{
				id: 'sd_closed',
				businessDate: '2026-06-14',
				type: 'closed',
				name: 'Closed Sunday',
				customServices: null,
			},
			{
				id: 'sd_online_closed',
				businessDate: '2026-06-15',
				type: 'online_closed',
				name: 'Walk-in Monday',
				customServices: null,
			},
		]

		const summary = calendarSummary({
			config,
			fromDate: '2026-06-12',
			toDate: '2026-06-16',
			partySize: 2,
			nowMs,
			channel: 'online',
		})
		expect(summary.expansionsUsed).toBeLessThanOrEqual(MAX_CALENDAR_EXPANSIONS)
		expect(summary.days).toHaveLength(5)
		expect(
			summary.days.find((d) => d.businessDate === '2026-06-12')?.status,
		).toBe('available')
		expect(
			summary.days.find((d) => d.businessDate === '2026-06-14')?.status,
		).toBe('closed')
		expect(
			summary.days.find((d) => d.businessDate === '2026-06-15')?.status,
		).toBe('online_closed')
	})

	it('evaluates searchExperienceAvailability with coversCapPerSeating and usesTables checks', () => {
		const config = makeBaseConfig()
		const seatStart = localToInstant(
			'2026-06-13',
			19 * 60,
			'America/New_York',
		).instantMs

		const expResult = searchExperienceAvailability({
			config,
			businessDate: '2026-06-13', // Saturday (dow = 6)
			partySize: 4,
			nowMs,
			channel: 'online',
			experiences: [
				{
					id: 'exp_published',
					title: "Chef's Counter",
					slug: 'chefs-counter',
					status: 'published',
					paymentMode: 'prepay',
					pricePerCoverMinor: 7500,
					currency: 'USD',
					minParty: 2,
					maxParty: 6,
					durationMin: 120,
					usesTables: true,
					areaId: 'area_main',
					coversCapPerSeating: 6,
					schedule: {
						daysOfWeek: [6],
						seatings: [19 * 60],
					},
				},
				{
					id: 'exp_draft',
					title: 'Secret Draft',
					slug: 'secret-draft',
					status: 'draft',
					paymentMode: 'prepay',
					pricePerCoverMinor: 5000,
					currency: 'USD',
					minParty: 2,
					maxParty: 6,
					durationMin: 90,
					usesTables: false,
					areaId: null,
					coversCapPerSeating: 10,
					schedule: {
						daysOfWeek: [6],
						seatings: [19 * 60],
					},
				},
			],
			occupancies: [
				{
					id: 'res_exp_existing',
					kind: 'reservation',
					status: 'booked',
					channel: 'online',
					experienceId: 'exp_published',
					partySize: 2,
					localStartMin: 19 * 60,
					startAt: seatStart,
					endAt: seatStart + 135 * 60_000,
					tableIds: ['t1'],
				},
			],
		})

		// Draft experience is excluded from online search; published experience has 6 - 2 = 4 covers remaining and t2 (2..4) is free in area_main
		expect(expResult).toHaveLength(1)
		expect(expResult[0]?.experienceId).toBe('exp_published')
		expect(expResult[0]?.seatings).toHaveLength(1)
		expect(expResult[0]?.seatings[0]?.remainingCovers).toBe(4)
	})
})
