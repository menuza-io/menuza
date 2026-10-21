import { describe, expect, it } from 'vitest'
import { reflowDay, assignTables, type AssignDayBooking } from './assign.ts'
import {
	searchAvailability,
	type EngineDayConfig,
	type ExistingOccupancyInput,
} from './availability.ts'
import { detectConflicts } from './conflicts.ts'
import { addDays, localToInstant } from '../time.ts'

const TZ = 'America/New_York'

function makeConfig(over: Partial<EngineDayConfig> = {}): EngineDayConfig {
	return {
		timeZone: TZ,
		settings: {
			enabled: true,
			onlineEnabled: true,
			dayStartMin: 240,
			intervalMin: 15,
			horizonDays: 30,
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
			modifyCutoffMin: 0,
			waitlistEnabled: true,
			notifyMeEnabled: true,
		},
		areas: [
			{
				id: 'a1',
				name: 'Main',
				color: '#000',
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
				minSeats: 2,
				maxSeats: 2,
				onlineBookable: true,
				combinable: false,
				priority: 0,
				active: true,
			},
			{
				id: 't2',
				areaId: 'a1',
				label: 'T2',
				minSeats: 2,
				maxSeats: 2,
				onlineBookable: true,
				combinable: false,
				priority: 1,
				active: true,
			},
		],
		combinations: [],
		services: [
			{
				id: 'dinner',
				name: 'Dinner',
				slug: 'dinner',
				color: '#000',
				daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
				startMin: 17 * 60,
				endMin: 22 * 60,
				lastSeatingMin: 20 * 60,
				onlineBookable: true,
				sortOrder: 0,
				active: true,
			},
		],
		turnTimeBuckets: [],
		pacingRules: [
			{
				id: 'p1',
				serviceId: 'dinner',
				areaId: null,
				windowStartMin: null,
				windowEndMin: null,
				maxCoversPerSlot: 2,
				maxPartiesPerSlot: null,
				maxOnlineCoversForService: null,
			},
		],
		serviceTableModes: [],
		specialDays: [],
		...over,
	}
}

const nowMs = localToInstant('2026-06-10', 10 * 60, TZ).instantMs

function booking(
	id: string,
	businessDate: string,
	localStartMin: number,
	tableIds: string[],
	over: Partial<ExistingOccupancyInput> = {},
): ExistingOccupancyInput {
	const dayOffset = Math.floor(localStartMin / 1440)
	const startAt = localToInstant(
		addDays(businessDate, dayOffset),
		localStartMin - dayOffset * 1440,
		TZ,
	).instantMs
	return {
		id,
		kind: 'reservation',
		status: 'booked',
		channel: 'online',
		serviceId: 'dinner',
		areaId: null,
		partySize: 2,
		businessDate,
		localStartMin,
		startAt,
		endAt: startAt + 60 * 60_000,
		tableIds,
		...over,
	}
}

describe('finding 10: pacing is scoped to the requested business date', () => {
	it("tomorrow's 18:00 booking does not count against today's 18:00 pacing", () => {
		const occupancies = [booking('tomorrow', '2026-06-13', 18 * 60, ['t2'])]
		const res = searchAvailability({
			config: makeConfig(),
			businessDate: '2026-06-12',
			partySize: 2,
			nowMs,
			channel: 'online',
			occupancies,
		})
		expect(res.slots.some((s) => s.slotMin === 18 * 60)).toBe(true)
	})

	it("a same-date 18:00 booking still counts against that date's pacing", () => {
		const occupancies = [booking('today', '2026-06-12', 18 * 60, ['t2'])]
		const res = searchAvailability({
			config: makeConfig(),
			businessDate: '2026-06-12',
			partySize: 2,
			nowMs,
			channel: 'online',
			occupancies,
		})
		expect(res.slots.some((s) => s.slotMin === 18 * 60)).toBe(false)
	})

	const overnight = makeConfig({
		services: [
			{
				id: 'dinner',
				name: 'Late',
				slug: 'late',
				color: '#000',
				daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
				startMin: 20 * 60,
				endMin: 3 * 60,
				lastSeatingMin: 2 * 60,
				onlineBookable: true,
				sortOrder: 0,
				active: true,
			},
		],
	})

	it('an overnight booking counts only for its own business date', () => {
		const occupancies = [booking('night', '2026-06-11', 1470, ['t2'])]
		const own = searchAvailability({
			config: overnight,
			businessDate: '2026-06-11',
			partySize: 2,
			nowMs,
			channel: 'online',
			occupancies,
		})
		expect(own.slots.some((s) => s.slotMin === 1470)).toBe(false)
		const next = searchAvailability({
			config: overnight,
			businessDate: '2026-06-12',
			partySize: 2,
			nowMs,
			channel: 'online',
			occupancies,
		})
		expect(next.slots.some((s) => s.slotMin === 1470)).toBe(true)
	})

	it('an adjacent-day occupancy still blocks tables physically but not pacing', () => {
		const config = makeConfig({
			tables: makeConfig().tables.slice(0, 1),
			pacingRules: [],
		})
		// Yesterday's overnight booking ends 19:00 today on the only table.
		const yesterday = booking('night', '2026-06-11', 1470, ['t1'])
		yesterday.endAt = localToInstant('2026-06-12', 19 * 60, TZ).instantMs
		const res = searchAvailability({
			config,
			businessDate: '2026-06-12',
			partySize: 2,
			nowMs,
			channel: 'online',
			occupancies: [yesterday],
		})
		expect(res.slots.some((s) => s.slotMin === 18 * 60)).toBe(false)
		expect(res.slots.some((s) => s.slotMin === 19 * 60 + 15)).toBe(true)
	})

	it('detectConflicts pacing ignores bookings of other business dates', () => {
		const mk = (id: string, businessDate: string) => ({
			id,
			status: 'booked',
			partySize: 2,
			localStartMin: 18 * 60,
			businessDate,
			startAt: 0,
			endAt: 1,
			tableIds: [id],
			serviceId: 'dinner',
		})
		const input = {
			tables: makeConfig().tables.map((t) => ({ ...t })),
			bookings: [mk('t1', '2026-06-12'), mk('t2', '2026-06-13')],
			pacingRules: makeConfig().pacingRules,
		}
		expect(
			detectConflicts({ ...input, businessDate: '2026-06-12' }).filter(
				(c) => c.kind === 'pacing_exceeded',
			),
		).toHaveLength(0)
		expect(
			detectConflicts({ ...input }).filter((c) => c.kind === 'pacing_exceeded'),
		).toHaveLength(1)
	})
})

describe('finding 11: reflow keeps local minutes for time-bounded table modes', () => {
	const start = localToInstant('2026-06-12', 18 * 60 + 30, TZ).instantMs
	const config = makeConfig({ pacingRules: [] })
	const modes = [
		{
			id: 'm1',
			serviceId: 'dinner',
			tableId: 't1',
			fromMin: 18 * 60,
			toMin: 20 * 60,
			mode: 'unavailable' as const,
		},
	]
	const soft: AssignDayBooking = {
		id: 'b1',
		kind: 'reservation',
		status: 'booked',
		channel: 'online',
		serviceId: 'dinner',
		partySize: 2,
		businessDate: '2026-06-12',
		localStartMin: 18 * 60 + 30,
		startAt: start,
		endAt: start + 60 * 60_000,
		tableIds: ['t1'],
	}

	it('direct assignment avoids the unavailable table', () => {
		const res = assignTables({
			partySize: 2,
			startAt: start,
			endAt: start + 60 * 60_000,
			localStartMin: 18 * 60 + 30,
			serviceId: 'dinner',
			tables: config.tables,
			serviceAvailability: modes,
			bookings: [],
			nowMs,
		})
		expect(res.assigned && res.tableIds).toEqual(['t2'])
	})

	it('reflow moves a booking off a table marked unavailable at its local time', () => {
		const res = reflowDay({
			tables: config.tables,
			serviceAvailability: modes,
			bookings: [soft],
			nowMs,
			assignmentFreezeMin: 0,
		})
		expect(res.status).toBe('assigned')
		expect(res.assignments.get('b1')?.tableIds).toEqual(['t2'])
	})

	it('reflow keeps the table once the mode window has ended', () => {
		const lateStart = localToInstant('2026-06-12', 20 * 60 + 15, TZ).instantMs
		const res = reflowDay({
			tables: config.tables,
			serviceAvailability: modes,
			bookings: [
				{
					...soft,
					localStartMin: 20 * 60 + 15,
					startAt: lateStart,
					endAt: lateStart + 3_600_000,
				},
			],
			nowMs,
			assignmentFreezeMin: 0,
		})
		expect(res.assignments.get('b1')?.tableIds).toEqual(['t1'])
	})

	it('reflow of an already valid day is a no-op', () => {
		for (let m = 17 * 60; m <= 21 * 60; m += 15) {
			const s = localToInstant('2026-06-12', m, TZ).instantMs
			const bookings: AssignDayBooking[] = [
				{
					...soft,
					id: 'x1',
					localStartMin: m,
					startAt: s,
					endAt: s + 3_600_000,
					tableIds: m >= 18 * 60 && m < 20 * 60 ? ['t2'] : ['t1'],
				},
				{
					...soft,
					id: 'x2',
					localStartMin: m + 60,
					startAt: s + 3_600_000,
					endAt: s + 7_200_000,
					tableIds: ['t2'],
				},
			]
			const res = reflowDay({
				tables: config.tables,
				serviceAvailability: modes,
				bookings,
				nowMs,
				assignmentFreezeMin: 0,
			})
			expect(res.status).toBe('assigned')
			for (const b of bookings) {
				const expected =
					b.localStartMin! >= 18 * 60 && b.localStartMin! < 20 * 60
						? ['t2']
						: [...b.tableIds]
				// A valid input must keep its tables; an invalid one (x2 on t2 is
				// always valid) may only move where the mode forbids it.
				if (b.tableIds[0] === 't2') {
					expect(res.assignments.get(b.id)?.tableIds).toEqual(expected)
				}
			}
			expect(res.reassigned).toHaveLength(0)
		}
	})
})
