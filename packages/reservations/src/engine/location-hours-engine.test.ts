import { describe, expect, it } from 'vitest'
import {
	calendarSummary,
	searchAvailability,
	type EngineDayConfig,
} from './availability.ts'
import { type LocationHours } from '../rules/location-hours.ts'
import { localToInstant } from '../time.ts'

const TZ = 'America/New_York'

function config(locationHours: LocationHours | null): EngineDayConfig {
	return {
		timeZone: TZ,
		settings: {
			enabled: true,
			onlineEnabled: true,
			dayStartMin: 240,
			intervalMin: 30,
			horizonDays: 60,
			releaseLocalMin: 0,
			minNoticeMin: 0,
			sameDayCutoffMin: null,
			minParty: 1,
			maxOnlineParty: 6,
			maxParty: 12,
			largePartyMode: 'request',
			seatingPreferenceMode: 'any',
			defaultTurnMin: 60,
			bufferMin: 0,
			holdTtlSec: 300,
			assignmentFreezeMin: 0,
			graceMin: 15,
			autoNoShowMin: null,
			maxActivePerPhone: 3,
			modifyCutoffMin: 120,
			waitlistEnabled: false,
			notifyMeEnabled: false,
		},
		areas: [
			{
				id: 'a1',
				name: 'Main',
				color: '#000000',
				isOutdoor: false,
				sortOrder: 0,
				active: true,
			},
		],
		tables: [
			{
				id: 't1',
				areaId: 'a1',
				label: 'T1',
				minSeats: 1,
				maxSeats: 6,
				onlineBookable: true,
				combinable: false,
				priority: 0,
				active: true,
			},
		],
		combinations: [],
		services: [
			{
				id: 'dinner',
				name: 'Dinner',
				slug: 'dinner',
				daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
				startMin: 17 * 60,
				endMin: 22 * 60,
				lastSeatingMin: 21 * 60,
				onlineBookable: true,
				sortOrder: 0,
				active: true,
			},
		],
		turnTimeBuckets: [],
		pacingRules: [],
		serviceTableModes: [],
		specialDays: [],
		locationHours,
	}
}

const DAYS = [
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
	'sunday',
] as const

const hoursOf = (over: Partial<LocationHours>): LocationHours => ({
	timeZone: TZ,
	isActive: true,
	storeHours: DAYS.map((day) => ({
		day,
		isOpen: true,
		slots: [{ start: '16:00', end: '23:00' }],
	})),
	specialHours: null,
	...over,
})

const NOW = localToInstant('2026-06-10', 10 * 60, TZ).instantMs
// 2026-06-12 is a Friday.
const search = (cfg: EngineDayConfig, channel: 'online' | 'host' = 'online') =>
	searchAvailability({
		config: cfg,
		businessDate: '2026-06-12',
		partySize: 2,
		nowMs: NOW,
		channel,
	})

describe('engine honours location hours', () => {
	it('offers every slot when no hours are known (fail open)', () => {
		expect(search(config(null)).slots.length).toBe(9)
	})

	it('clips online slots to the open range, staff get a warning instead', () => {
		const h = hoursOf({
			specialHours: [
				{
					id: 's',
					date: '2026-06-12',
					isOpen: true,
					slots: [{ start: '17:00', end: '19:00' }],
				},
			],
		})
		const online = search(config(h))
		expect(online.slots.map((s) => s.slotHhmm)).toEqual([
			'17:00',
			'17:30',
			'18:00',
			'18:30',
			'19:00',
		])
		const host = search(config(h), 'host')
		expect(host.slots.length).toBe(9)
		expect(
			host.slots.filter((s) => s.warnings?.includes('outside_location_hours')),
		).toHaveLength(4)
		expect(host.warnings).toContain('outside_location_hours')
	})

	it('answers closed with the location source for guests and still lists slots for staff', () => {
		const h = hoursOf({
			specialHours: [
				{
					id: 's',
					date: '2026-06-12',
					isOpen: false,
					slots: [],
					note: 'Holiday',
				},
			],
		})
		const online = search(config(h))
		expect(online.status).toBe('closed')
		expect(online.slots).toHaveLength(0)
		expect(online.closed).toMatchObject({
			source: 'location_closed',
			reason: 'special_closed',
			note: 'Holiday',
		})
		const host = search(config(h), 'host')
		expect(host.status).toBe('available')
		expect(
			host.slots.every((s) => s.warnings?.includes('outside_location_hours')),
		).toBe(true)
	})

	it('treats an inactive location as closed for guests', () => {
		const res = search(config(hoursOf({ isActive: false })))
		expect(res.status).toBe('closed')
		expect(res.closed?.reason).toBe('inactive')
	})

	it('keeps a reservations-only closed day closed and says why', () => {
		const cfg = config(hoursOf({}))
		cfg.specialDays = [
			{ id: 'sd', businessDate: '2026-06-12', type: 'closed', name: 'Buyout' },
		]
		const res = search(cfg, 'host')
		expect(res.status).toBe('closed')
		expect(res.closed?.source).toBe('reservation_special_day')
	})

	it('a replace special day cannot open a closed location', () => {
		const cfg = config(
			hoursOf({
				specialHours: [
					{ id: 's', date: '2026-06-12', isOpen: false, slots: [] },
				],
			}),
		)
		cfg.specialDays = [
			{
				id: 'sd',
				businessDate: '2026-06-12',
				type: 'replace',
				name: 'Gala',
				customServices: [
					{
						id: 'gala',
						name: 'Gala',
						startMin: 18 * 60,
						endMin: 22 * 60,
						lastSeatingMin: 20 * 60,
						onlineBookable: true,
					},
				],
			},
		]
		expect(search(cfg).slots).toHaveLength(0)
	})

	it('marks closed days in the calendar summary with the source', () => {
		const cfg = config(
			hoursOf({
				specialHours: [
					{ id: 's', date: '2026-06-13', isOpen: false, slots: [] },
				],
			}),
		)
		const { days } = calendarSummary({
			config: cfg,
			fromDate: '2026-06-12',
			toDate: '2026-06-13',
			partySize: 2,
			nowMs: NOW,
		})
		expect(days[0]).toMatchObject({ status: 'available' })
		expect(days[1]).toMatchObject({
			status: 'closed',
			closedSource: 'location_closed',
		})
	})
})
