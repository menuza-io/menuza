import { describe, expect, it } from 'vitest'
import { type DayReservationView } from '#app/utils/reservations/book-api.ts'
import {
	type RsvFloorElementRecord,
	type RsvScheduleBlockRecord,
	type RsvTableRecord,
} from '#app/utils/reservations/setup-api.ts'
import {
	computeTableFloorState,
	floorElementsForArea,
	floorPlacement,
	floorStageSize,
	floorRoomBounds,
	floorFitScale,
	FLOOR_MAX_SCALE,
	FLOOR_MIN_SCALE,
	floorTablesForArea,
	isBlockActive,
	pickFloorAreaId,
	restOfServiceWindow,
	type FloorClock,
} from './floor-state.ts'

const NOW = Date.UTC(2026, 3, 20, 19, 0, 0)
const liveClock = (nowLocalMin: number, nowMs = NOW): FloorClock => ({
	nowMs,
	nowLocalMin,
	live: true,
})

const table = (over: Partial<RsvTableRecord> = {}) =>
	({
		id: 't1',
		areaId: 'a1',
		label: 'T1',
		isActive: true,
		x: 10,
		y: 10,
		width: 70,
		height: 70,
		...over,
	}) as RsvTableRecord

const block = (over: Partial<RsvScheduleBlockRecord> = {}) =>
	({
		id: 'b1',
		tableId: 't1',
		businessDate: '2026-04-20',
		startAt: 0,
		endAt: 0,
		startMin: null,
		endMin: null,
		reason: 'maintenance',
		note: null,
		...over,
	}) as RsvScheduleBlockRecord

const rsv = (over: Partial<DayReservationView> = {}) =>
	({
		id: 'r1',
		guestName: 'Amal Khan',
		partySize: 2,
		status: 'booked',
		assignedTableIds: ['t1'],
		localStartMin: 1140,
		localEndMin: 1230,
		slotStartAt: 0,
		slotEndAt: 0,
		seatedAt: null,
		durationMin: 90,
		hhmm: '19:00',
		courseStage: null,
		serverLabel: null,
		...over,
	}) as DayReservationView

describe('table blocks only count inside their window', () => {
	it('ignores a block that ended and one that has not started (epoch ms)', () => {
		const clock = liveClock(1140)
		const ended = block({ startAt: NOW - 3_600_000, endAt: NOW - 60_000 })
		const later = block({ startAt: NOW + 60_000, endAt: NOW + 3_600_000 })
		const open = block({ startAt: NOW - 60_000, endAt: NOW + 3_600_000 })
		expect(isBlockActive(ended, clock, '2026-04-20')).toBe(false)
		expect(isBlockActive(later, clock, '2026-04-20')).toBe(false)
		expect(isBlockActive(open, clock, '2026-04-20')).toBe(true)
		const state = (blocks: RsvScheduleBlockRecord[]) =>
			computeTableFloorState({
				table: table(),
				reservations: [],
				blocks,
				clock,
				businessDate: '2026-04-20',
			})
		expect(state([ended, later]).liveStatus).toBe('available')
		expect(state([ended, later, open]).liveStatus).toBe('blocked')
	})

	it('reads epoch seconds the same way', () => {
		const clock = liveClock(1140)
		const open = block({
			startAt: Math.floor(NOW / 1000) - 60,
			endAt: Math.floor(NOW / 1000) + 3600,
		})
		expect(isBlockActive(open, clock, '2026-04-20')).toBe(true)
	})

	it('falls back to the minute window without epoch bounds, and never on another day', () => {
		const clock = liveClock(1140)
		expect(
			isBlockActive(
				block({ startMin: 1080, endMin: 1200 }),
				clock,
				'2026-04-20',
			),
		).toBe(true)
		expect(
			isBlockActive(
				block({ startMin: 1200, endMin: 1300 }),
				clock,
				'2026-04-20',
			),
		).toBe(false)
		expect(
			isBlockActive(
				block({ businessDate: '2026-04-19', startMin: 0, endMin: 2000 }),
				clock,
				'2026-04-20',
			),
		).toBe(false)
	})

	it('has no active block on a day that is not today', () => {
		const clock: FloorClock = { nowMs: NOW, nowLocalMin: 1140, live: false }
		expect(
			isBlockActive(block({ startMin: 0, endMin: 2000 }), clock, '2026-04-21'),
		).toBe(false)
	})
})

describe('block for the rest of service', () => {
	const dinner = { firstSeatingMin: 1080, endMin: 1560 }

	it('starts at the later of now and the service start', () => {
		expect(
			restOfServiceWindow({
				service: dinner,
				clock: liveClock(1200),
				dayStartMin: 240,
			}).startMin,
		).toBe(1200)
		expect(
			restOfServiceWindow({
				service: dinner,
				clock: liveClock(900),
				dayStartMin: 240,
			}).startMin,
		).toBe(1080)
	})

	it('keeps an end past midnight instead of clamping to 1440', () => {
		const window = restOfServiceWindow({
			service: dinner,
			clock: liveClock(1200),
			dayStartMin: 240,
		})
		expect(window.endMin).toBe(1560)
	})

	it('uses the service start on a day that is not live, and caps at 2880', () => {
		const clock: FloorClock = { nowMs: NOW, nowLocalMin: 1500, live: false }
		expect(
			restOfServiceWindow({ service: dinner, clock, dayStartMin: 240 })
				.startMin,
		).toBe(1080)
		expect(
			restOfServiceWindow({
				service: { firstSeatingMin: 1000, endMin: 5000 },
				clock,
				dayStartMin: 240,
			}).endMin,
		).toBe(2880)
	})

	it('without a service runs to the end of the business day', () => {
		expect(
			restOfServiceWindow({
				service: null,
				clock: liveClock(1200),
				dayStartMin: 240,
			}),
		).toEqual({ startMin: 1200, endMin: 1680 })
	})
})

describe('live states use business-day minutes', () => {
	it('after midnight a 00:30 booking is reserved soon at 00:10 (1450 vs 1470)', () => {
		const state = computeTableFloorState({
			table: table(),
			reservations: [rsv({ localStartMin: 1470, hhmm: '00:30' })],
			blocks: [],
			clock: liveClock(1450),
			businessDate: '2026-04-20',
		})
		expect(state.liveStatus).toBe('reserved_soon')
	})

	it('shows no timers and no soon state when the day is not live', () => {
		const clock: FloorClock = { nowMs: NOW, nowLocalMin: 1140, live: false }
		const seated = computeTableFloorState({
			table: table(),
			reservations: [
				rsv({
					status: 'seated',
					seatedAt: NOW - 600_000,
					slotEndAt: NOW + 600_000,
				}),
			],
			blocks: [],
			clock,
			businessDate: '2026-04-27',
		})
		expect(seated.liveStatus).toBe('seated')
		expect(seated.elapsedMin).toBeNull()
		expect(seated.remainingMin).toBeNull()
		const booked = computeTableFloorState({
			table: table(),
			reservations: [rsv({ localStartMin: 1150 })],
			blocks: [],
			clock,
			businessDate: '2026-04-27',
		})
		expect(booked.liveStatus).toBe('available')
		expect(booked.reservedAtHhmm).toBe('19:00')
	})

	it('flags overtime and finishing from the live clock', () => {
		const base = {
			table: table(),
			blocks: [],
			clock: liveClock(1140),
			businessDate: '2026-04-20',
		}
		expect(
			computeTableFloorState({
				...base,
				reservations: [
					rsv({
						status: 'seated',
						seatedAt: NOW - 100 * 60_000,
						slotEndAt: NOW - 5 * 60_000,
					}),
				],
			}).liveStatus,
		).toBe('overtime')
		expect(
			computeTableFloorState({
				...base,
				reservations: [
					rsv({
						status: 'seated',
						seatedAt: NOW - 80 * 60_000,
						slotEndAt: NOW + 10 * 60_000,
					}),
				],
			}).liveStatus,
		).toBe('finishing')
	})
})

describe('one area at a time', () => {
	const areas = [
		{ id: 'old', isActive: false },
		{ id: 'main', isActive: true },
		{ id: 'patio', isActive: true },
	]

	it('defaults to the first active area and honors a valid request', () => {
		expect(pickFloorAreaId(areas, null)).toBe('main')
		expect(pickFloorAreaId(areas, 'patio')).toBe('patio')
		expect(pickFloorAreaId(areas, 'old')).toBe('main')
		expect(pickFloorAreaId(areas, 'gone')).toBe('main')
		expect(pickFloorAreaId([], null)).toBeNull()
	})

	it('filters tables and elements by area, keeping shared elements', () => {
		const tables = [
			table({ id: 'a', areaId: 'main' }),
			table({ id: 'b', areaId: 'patio' }),
			table({ id: 'c', areaId: 'main', isActive: false }),
		]
		expect(floorTablesForArea(tables, 'main').map((t) => t.id)).toEqual(['a'])
		const elements = [
			{ id: 'e1', areaId: 'main' },
			{ id: 'e2', areaId: 'patio' },
			{ id: 'e3', areaId: null },
		] as RsvFloorElementRecord[]
		expect(floorElementsForArea(elements, 'main').map((e) => e.id)).toEqual([
			'e1',
			'e3',
		])
	})
})

describe('stage geometry', () => {
	it('uses the real table size, not a bigger minimum', () => {
		expect(floorPlacement(table({ width: 64, height: 48 }))).toMatchObject({
			width: 64,
			height: 48,
		})
		expect(floorPlacement({ width: 4, height: 4 })).toMatchObject({
			width: 20,
			height: 20,
		})
	})

	it('wraps the layout and never exceeds the editor canvas', () => {
		const small = floorStageSize([table({ x: 100, y: 100 })])
		expect(small).toEqual({ width: 560, height: 360 })
		const huge = floorStageSize([table({ x: 5000, y: 5000 })])
		expect(huge).toEqual({ width: 1200, height: 720 })
		const wide = floorStageSize([
			table({ x: 700, y: 400, width: 100, height: 100 }),
		])
		expect(wide).toEqual({ width: 824, height: 524 })
	})
})

describe('room fit', () => {
	it('bounds the actual tables, not the whole canvas', () => {
		const b = floorRoomBounds([
			table({ x: 200, y: 100, width: 100, height: 100 }),
			table({ x: 400, y: 300, width: 100, height: 100 }),
		])
		expect(b).toEqual({ x: 184, y: 84, width: 332, height: 332 })
	})

	it('clamps the fit scale and survives zero sizes', () => {
		expect(floorFitScale(1400, 332)).toBe(FLOOR_MAX_SCALE)
		expect(floorFitScale(100, 1000)).toBe(FLOOR_MIN_SCALE)
		expect(floorFitScale(664, 332)).toBe(
			2 > FLOOR_MAX_SCALE ? FLOOR_MAX_SCALE : 2,
		)
		expect(floorFitScale(0, 332)).toBe(1)
	})
})

describe('floor tile sizing', () => {
	it('grows a small table to the readable minimum and keeps larger ones', async () => {
		const { floorTablePlacement, FLOOR_TABLE_MIN } =
			await import('./floor-state.ts')
		const small = floorTablePlacement(
			{ x: 40, y: 50, width: 40, height: 30 },
			0,
		)
		expect(small).toMatchObject({
			x: 40,
			y: 50,
			width: FLOOR_TABLE_MIN,
			height: FLOOR_TABLE_MIN,
		})
		expect(
			floorTablePlacement({ x: 10, y: 10, width: 120, height: 90 }, 0),
		).toMatchObject({ width: 120, height: 90 })
	})

	it('counts the grown tile in the room bounds so the fit scale never clips it', async () => {
		const { floorRoomBounds, FLOOR_TABLE_MIN } =
			await import('./floor-state.ts')
		const b = floorRoomBounds([{ x: 100, y: 100, width: 40, height: 40 }])
		expect(b.x + b.width).toBeGreaterThanOrEqual(100 + FLOOR_TABLE_MIN)
	})

	it('chooses the tile tier and party-name lines from the tile size', async () => {
		const { floorTileLayout } = await import('./floor-state.ts')
		expect(floorTileLayout(72, 72)).toMatchObject({
			tier: 'tight',
			partyLines: 1,
			showParty: false,
			showTime: false,
		})
		expect(floorTileLayout(88, 88)).toMatchObject({
			tier: 'tight',
			partyLines: 1,
			showParty: true,
			showTime: false,
		})
		expect(floorTileLayout(120, 96)).toMatchObject({
			tier: 'roomy',
			partyLines: 2,
			showTime: true,
		})
		// A small round tile keeps the party name out of the tile.
		expect(floorTileLayout(72, 72, true).showParty).toBe(false)
		expect(floorTileLayout(110, 110, true).showParty).toBe(true)
		expect(floorTileLayout(120, 96, true).tier).toBe('tight')
		expect(floorTileLayout(140, 120, true).tier).toBe('roomy')
	})

	it('lets a narrow room magnify up to 2.2 and no further', () => {
		expect(FLOOR_MAX_SCALE).toBe(2.2)
		expect(floorFitScale(3000, 300)).toBe(2.2)
	})
})
