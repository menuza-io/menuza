import { describe, expect, it } from 'vitest'
import {
	COMBINATION_TYPES,
	DECOR_ELEMENT_KINDS,
	INTERVAL_MIN_VALUES,
	LARGE_PARTY_MODES,
	SEATING_PREFERENCES,
	SERVICE_TABLE_MODES,
	SPECIAL_DAY_TYPES,
	TABLE_SHAPES,
	canonicalCombinationSignature,
	combinationSchema,
	decorElementSchema,
	diningAreaSchema,
	floorPlanSaveSchema,
	locationSettingsSchema,
	pacingRuleSchema,
	serviceSchema,
	specialDaySchema,
	tableSchema,
	turnTimeBucketSchema,
	validateConfig,
} from '../config.ts'

describe('reservations configuration schemas and validateConfig', () => {
	it('validates locationSettingsSchema constraints (interval_min, horizon_days, party bounds, non-negative timers)', () => {
		expect(INTERVAL_MIN_VALUES).toEqual([5, 10, 15, 20, 30, 60])
		expect(LARGE_PARTY_MODES).toEqual(['disabled', 'request', 'call_only'])
		expect(SEATING_PREFERENCES).toEqual(['any', 'indoor', 'outdoor', 'bar'])

		const valid = locationSettingsSchema.safeParse({
			enabled: true,
			onlineEnabled: true,
			dayStartMin: 240,
			intervalMin: 15,
			horizonDays: 60,
			releaseLocalMin: 540,
			minNoticeMin: 30,
			sameDayCutoffMin: null,
			minParty: 1,
			maxOnlineParty: 8,
			maxParty: 16,
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
		})
		expect(valid.success).toBe(true)

		// Invalid intervalMin (12 not in {5,10,15,20,30,60})
		expect(
			locationSettingsSchema.safeParse({
				...valid.data!,
				intervalMin: 12,
			}).success,
		).toBe(false)

		// Invalid horizonDays (400 > 365)
		expect(
			locationSettingsSchema.safeParse({
				...valid.data!,
				horizonDays: 400,
			}).success,
		).toBe(false)

		// Invalid party bounds (minParty > maxOnlineParty)
		expect(
			locationSettingsSchema.safeParse({
				...valid.data!,
				minParty: 6,
				maxOnlineParty: 4,
				maxParty: 10,
			}).success,
		).toBe(false)

		// Invalid party bounds (maxOnlineParty > maxParty)
		expect(
			locationSettingsSchema.safeParse({
				...valid.data!,
				minParty: 2,
				maxOnlineParty: 12,
				maxParty: 10,
			}).success,
		).toBe(false)

		// Negative bufferMin or holdTtlSec
		expect(
			locationSettingsSchema.safeParse({
				...valid.data!,
				bufferMin: -5,
			}).success,
		).toBe(false)
	})

	it('validates areas, tables, combinations, services, turn-time buckets, pacing, special days, and floor-plan decor', () => {
		expect(TABLE_SHAPES).toEqual(['round', 'square', 'rect', 'booth', 'bar'])
		expect(COMBINATION_TYPES).toEqual(['adjacent', 'manual'])
		expect(SERVICE_TABLE_MODES).toEqual([
			'online',
			'staff_only',
			'walk_in_only',
			'unavailable',
		])
		expect(SPECIAL_DAY_TYPES).toEqual([
			'closed',
			'online_closed',
			'modified',
			'replace',
		])
		expect(DECOR_ELEMENT_KINDS).toEqual([
			'wall',
			'bar',
			'door',
			'window',
			'label',
			'plant',
			'zone',
		])

		expect(
			diningAreaSchema.safeParse({
				id: 'area_main',
				name: 'Main Dining',
				color: '#2563EB',
				isOutdoor: false,
				sortOrder: 0,
				active: true,
			}).success,
		).toBe(true)

		expect(
			diningAreaSchema.safeParse({
				id: 'area_bad_color',
				name: 'Bad Color',
				color: 'blue',
				isOutdoor: false,
				sortOrder: 0,
				active: true,
			}).success,
		).toBe(false)

		expect(
			tableSchema.safeParse({
				id: 't1',
				areaId: 'area_main',
				label: 'T1',
				shape: 'round',
				minSeats: 2,
				maxSeats: 4,
				onlineBookable: true,
				combinable: true,
				priority: 10,
				isAccessible: true,
				isHighTop: false,
				isWindow: true,
				isBooth: false,
				isPatio: false,
				isBar: false,
				x: 100,
				y: 120,
				width: 60,
				height: 60,
				rotation: 0,
				active: true,
			}).success,
		).toBe(true)

		// Rejects minSeats > maxSeats
		expect(
			tableSchema.safeParse({
				id: 't_bad',
				areaId: 'area_main',
				label: 'TBad',
				shape: 'square',
				minSeats: 6,
				maxSeats: 4,
				onlineBookable: true,
				combinable: true,
				priority: 0,
				isAccessible: false,
				isHighTop: false,
				isWindow: false,
				isBooth: false,
				isPatio: false,
				isBar: false,
				x: 0,
				y: 0,
				width: 50,
				height: 50,
				rotation: 0,
				active: true,
			}).success,
		).toBe(false)

		// Combination requires >= 2 distinct tableIds and minSeats <= maxSeats
		expect(
			combinationSchema.safeParse({
				id: 'c1',
				name: 'T1+T2',
				type: 'adjacent',
				minSeats: 5,
				maxSeats: 8,
				priority: 5,
				onlineBookable: true,
				active: true,
				tableIds: ['t2', 't1'],
			}).success,
		).toBe(true)
		expect(canonicalCombinationSignature(['t2', 't1'])).toBe('t1,t2')

		expect(
			combinationSchema.safeParse({
				id: 'c_single',
				name: 'Single',
				type: 'manual',
				minSeats: 2,
				maxSeats: 4,
				priority: 0,
				onlineBookable: true,
				active: true,
				tableIds: ['t1'],
			}).success,
		).toBe(false)

		// Decor elements
		for (const kind of DECOR_ELEMENT_KINDS) {
			expect(
				decorElementSchema.safeParse({
					id: `decor_${kind}`,
					areaId: 'area_main',
					kind,
					label: kind === 'label' ? 'Entrance' : null,
					x: 10,
					y: 20,
					width: 80,
					height: 20,
					rotation: 0,
				}).success,
			).toBe(true)
		}

		// Turn time bucket
		expect(
			turnTimeBucketSchema.safeParse({
				id: 'tt1',
				serviceId: 'srv_dinner',
				minParty: 1,
				maxParty: 2,
				durationMin: 75,
			}).success,
		).toBe(true)
		expect(
			turnTimeBucketSchema.safeParse({
				id: 'tt_bad',
				serviceId: 'srv_dinner',
				minParty: 4,
				maxParty: 2,
				durationMin: 75,
			}).success,
		).toBe(false)

		// Service schema
		expect(
			serviceSchema.safeParse({
				id: 'srv_dinner',
				name: 'Dinner',
				slug: 'dinner',
				color: '#DC2626',
				daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
				startMin: 1080,
				endMin: 1500,
				lastSeatingMin: 1380,
				onlineBookable: true,
				sortOrder: 1,
				active: true,
			}).success,
		).toBe(true)

		// Pacing rule
		expect(
			pacingRuleSchema.safeParse({
				id: 'pace_1',
				serviceId: 'srv_dinner',
				areaId: null,
				windowStartMin: null,
				windowEndMin: null,
				maxCoversPerSlot: 20,
				maxPartiesPerSlot: 6,
				maxOnlineCoversForService: 120,
			}).success,
		).toBe(true)

		// Special day
		expect(
			specialDaySchema.safeParse({
				id: 'sd_1',
				businessDate: '2026-12-25',
				type: 'closed',
				name: 'Holiday',
				note: null,
				customServices: null,
			}).success,
		).toBe(true)

		// Floor plan save
		expect(
			floorPlanSaveSchema.safeParse({
				expectedFloorPlanVersion: 1,
				tables: [],
				decorElements: [],
			}).success,
		).toBe(true)
	})

	it('detects all required configuration issues via validateConfig', () => {
		const report = validateConfig({
			settings: {
				minParty: 2,
				maxOnlineParty: 6,
				maxParty: 8,
				intervalMin: 15,
				horizonDays: 30,
				defaultTurnMin: 90,
			},
			areas: [
				{ id: 'area_1', name: 'Main', active: true },
				{ id: 'area_2', name: 'Patio', active: true },
			],
			tables: [
				{
					id: 't1',
					areaId: 'area_1',
					label: 'T1',
					minSeats: 2,
					maxSeats: 2,
					onlineBookable: true,
					combinable: true,
					active: true,
				},
				{
					id: 't2',
					areaId: 'area_1',
					label: 't1', // duplicate active label (case-insensitive)
					minSeats: 4,
					maxSeats: 4,
					onlineBookable: true,
					combinable: true,
					active: true,
				},
				{
					id: 't3_archived',
					areaId: 'area_1',
					label: 'T3',
					minSeats: 2,
					maxSeats: 4,
					onlineBookable: true,
					combinable: true,
					active: false,
				},
				{
					id: 't4_patio',
					areaId: 'area_2',
					label: 'P1',
					minSeats: 2,
					maxSeats: 4,
					onlineBookable: true,
					combinable: true,
					active: true,
				},
			],
			combinations: [
				{
					id: 'c_archived',
					name: 'Archived member combo',
					minSeats: 5,
					maxSeats: 6,
					onlineBookable: true,
					active: true,
					tableIds: ['t1', 't3_archived'],
				},
				{
					id: 'c_cross_area',
					name: 'Cross area combo',
					minSeats: 5,
					maxSeats: 6,
					onlineBookable: true,
					active: true,
					tableIds: ['t1', 't4_patio'],
				},
				{
					id: 'c_dup_1',
					name: 'Combo A',
					minSeats: 5,
					maxSeats: 5,
					onlineBookable: true,
					active: true,
					tableIds: ['t1', 't2'],
				},
				{
					id: 'c_dup_2',
					name: 'Combo B same members',
					minSeats: 5,
					maxSeats: 5,
					onlineBookable: true,
					active: true,
					tableIds: ['t2', 't1'],
				},
			],
			services: [
				{
					id: 'srv_good',
					name: 'Dinner',
					startMin: 1080,
					endMin: 1380,
					lastSeatingMin: 1320,
					onlineBookable: true,
					active: true,
				},
				{
					id: 'srv_bad_end',
					name: 'Broken Window',
					startMin: 1200,
					endMin: 1100,
					lastSeatingMin: 1050,
					onlineBookable: true,
					active: true,
				},
				{
					id: 'srv_bad_last',
					name: 'Late Last Seating',
					startMin: 1080,
					endMin: 1320,
					lastSeatingMin: 1350,
					onlineBookable: true,
					active: true,
				},
			],
			turnTimeBuckets: [
				// For srv_good: 1..2 and 2..4 overlap at 2, and 5 is a gap before 6..8
				{
					id: 'tt_1',
					serviceId: 'srv_good',
					minParty: 1,
					maxParty: 2,
					durationMin: 60,
				},
				{
					id: 'tt_2',
					serviceId: 'srv_good',
					minParty: 2,
					maxParty: 4,
					durationMin: 75,
				},
				{
					id: 'tt_3',
					serviceId: 'srv_good',
					minParty: 6,
					maxParty: 8,
					durationMin: 120,
				},
			],
			pacingRules: [
				{
					id: 'p_too_small',
					serviceId: 'srv_good',
					maxCoversPerSlot: 1, // < minParty (2)
					maxPartiesPerSlot: 4,
					maxOnlineCoversForService: 100,
				},
			],
		})

		const codes = report.issues.map((i) => i.code)
		expect(codes).toContain('duplicate_table_label')
		expect(codes).toContain('unseatable_party_size') // party size 3 has no single table or valid active combo
		expect(codes).toContain('combination_archived_table')
		expect(codes).toContain('combination_cross_area')
		expect(codes).toContain('combination_duplicate_members')
		expect(codes).toContain('turn_time_bucket_overlap')
		expect(codes).toContain('turn_time_bucket_gap')
		expect(codes).toContain('pacing_cap_below_min_party')
		expect(codes).toContain('service_invalid_window')
		expect(codes).toContain('service_last_seating_after_end')
		expect(report.valid).toBe(false)
	})
})
