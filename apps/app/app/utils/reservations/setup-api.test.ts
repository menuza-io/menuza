import { describe, expect, it, vi } from 'vitest'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import {
	checkTurnTimeContiguity,
	createService,
	daysMaskToDaysOfWeek,
	daysOfWeekToDaysMask,
	normalizeService,
	updateService,
	clampCanvasCoord,
	clampCanvasDimension,
	extractApiErrorCode,
	extractApiErrorMessage,
	fetchLocationSettings,
	fetchSetupConflicts,
	formatMinutesLabel,
	isVersionConflictError,
	minutesToTimeString,
	normalizeSetupConflict,
	normalizeRotation,
	rederiveLocationTimes,
	saveFloorPlan,
	snapToGrid,
	timeStringToMinutes,
	updateLocationSettings,
} from '#app/utils/reservations/setup-api.ts'

describe('setup-api helpers', () => {
	it('snaps coordinates to 10-unit grid and clamps within [0..1200]', () => {
		expect(snapToGrid(124)).toBe(120)
		expect(snapToGrid(126)).toBe(130)
		expect(snapToGrid(-15)).toBe(0)
		expect(snapToGrid(1450)).toBe(1200)
		expect(clampCanvasCoord(500)).toBe(500)
		expect(clampCanvasCoord(-10)).toBe(0)
		expect(clampCanvasCoord(1500)).toBe(1200)
	})

	it('clamps canvas dimensions within [20..600] and normalizes rotation', () => {
		expect(clampCanvasDimension(5)).toBe(20)
		expect(clampCanvasDimension(80)).toBe(80)
		expect(clampCanvasDimension(900)).toBe(600)
		expect(normalizeRotation(0)).toBe(0)
		expect(normalizeRotation(90)).toBe(90)
		expect(normalizeRotation(360)).toBe(0)
		expect(normalizeRotation(-90)).toBe(270)
		expect(normalizeRotation(450)).toBe(90)
	})

	it('converts between minutes from midnight and HH:MM strings including next-day spillover', () => {
		expect(minutesToTimeString(690)).toBe('11:30')
		expect(minutesToTimeString(1320)).toBe('22:00')
		expect(minutesToTimeString(1500)).toBe('01:00')
		expect(formatMinutesLabel(1500)).toBe('01:00 (+1d)')
		expect(timeStringToMinutes('11:30')).toBe(690)
		expect(timeStringToMinutes('01:00', { nextDay: true })).toBe(1500)
	})

	it('checks turn-time contiguity across [1..onlinePartyMax]', () => {
		const contiguous = checkTurnTimeContiguity(
			[
				{ serviceId: null, partyMin: 1, partyMax: 2 },
				{ serviceId: null, partyMin: 3, partyMax: 4 },
				{ serviceId: null, partyMin: 5, partyMax: 8 },
			],
			8,
			null,
		)
		expect(contiguous.covered).toBe(true)
		expect(contiguous.gaps).toEqual([])
		expect(contiguous.overlaps).toEqual([])

		const withGap = checkTurnTimeContiguity(
			[
				{ serviceId: null, partyMin: 1, partyMax: 2 },
				{ serviceId: null, partyMin: 5, partyMax: 8 },
			],
			8,
			null,
		)
		expect(withGap.covered).toBe(false)
		expect(withGap.gaps).toEqual([{ from: 3, to: 4 }])

		const withOverlap = checkTurnTimeContiguity(
			[
				{ serviceId: null, partyMin: 1, partyMax: 4 },
				{ serviceId: null, partyMin: 3, partyMax: 8 },
			],
			8,
			null,
		)
		expect(withOverlap.covered).toBe(false)
		expect(withOverlap.overlaps).toEqual([{ from: 3, to: 4 }])
	})

	it('detects 409 stale_version conflicts and extracts error messages', () => {
		const conflictErr = Object.assign(new Error('Conflict'), {
			status: 409,
			body: {
				error: 'stale_version',
				message: 'Settings were modified by another operator.',
			},
		})
		expect(isVersionConflictError(conflictErr)).toBe(true)
		expect(extractApiErrorCode(conflictErr)).toBe('stale_version')
		expect(extractApiErrorMessage(conflictErr, 'Fallback')).toBe(
			'Settings were modified by another operator.',
		)

		const dupLabelErr = Object.assign(new Error('Conflict'), {
			status: 409,
			body: {
				error: 'duplicate_table_label',
				message: 'Table label "T1" is already in use',
			},
		})
		expect(isVersionConflictError(dupLabelErr)).toBe(false)
		expect(extractApiErrorCode(dupLabelErr)).toBe('duplicate_table_label')
	})

	it('sends expectedVersion on settings update and expectedFloorPlanVersion on floor-plan save', async () => {
		const requestMock = vi.fn(async (_path: string, _opts?: unknown) => ({
			settings: { locationId: 'loc-1', version: 2 },
		}))
		const client: ReservationsScopedClient = {
			scope: 'setup',
			request: requestMock as any,
			requestConditional: vi.fn() as any,
			getToken: vi.fn(),
			invalidate: vi.fn(),
		}

		await fetchLocationSettings(client, 'loc-1')
		expect(requestMock).toHaveBeenCalledWith(
			'/operator/reservations/setup/locations/loc-1/settings',
			{ signal: undefined },
		)

		await updateLocationSettings(client, 'loc-1', {
			expectedVersion: 1,
			slotIntervalMin: 30,
		})
		expect(requestMock).toHaveBeenCalledWith(
			'/operator/reservations/setup/locations/loc-1/settings',
			{
				method: 'PUT',
				body: { expectedVersion: 1, slotIntervalMin: 30 },
			},
		)

		await saveFloorPlan(client, 'loc-1', {
			expectedFloorPlanVersion: 3,
			areas: [{ id: 'a1', name: 'Main Dining' }],
			tables: [{ id: 't1', areaId: 'a1', label: 'T1' }],
			elements: [],
			archiveMissingTables: true,
		})
		expect(requestMock).toHaveBeenCalledWith(
			'/operator/reservations/setup/locations/loc-1/floor-plan',
			{
				method: 'PUT',
				body: {
					expectedFloorPlanVersion: 3,
					areas: [{ id: 'a1', name: 'Main Dining' }],
					tables: [{ id: 't1', areaId: 'a1', label: 'T1' }],
					elements: [],
					archiveMissingTables: true,
				},
			},
		)

		await rederiveLocationTimes(client, 'loc-1')
		expect(requestMock).toHaveBeenCalledWith(
			'/operator/reservations/setup/locations/loc-1/rederive-times',
			{
				method: 'POST',
				body: {},
			},
		)
	})
})

describe('setup conflicts', () => {
	const item = {
		kind: 'blocked_table',
		bookingId: 'rsv-1',
		tableId: 'tbl-1',
		serviceId: null,
		slotMin: 1140,
		details: { businessDate: '2026-04-20', partySize: 4 },
	}

	it('maps a /conflicts item to code, date, party size and a reason key', () => {
		const dto = normalizeSetupConflict(item)
		expect(dto).toMatchObject({
			kind: 'blocked_table',
			reservationId: 'rsv-1',
			reason: 'table_blocked',
			businessDate: '2026-04-20',
			partySize: 4,
			tableId: 'tbl-1',
			confirmationCode: null,
		})
		expect(normalizeSetupConflict({ kind: 'mystery' }).reason).toBe('other')
	})

	it('fills the confirmation code from the booking for a non-empty list', async () => {
		const requestMock = vi.fn(async (path: string) => {
			if (path.endsWith('/conflicts')) {
				return {
					conflicts: [
						item,
						{ ...item, kind: 'table_overlap', bookingId: 'rsv-2', details: {} },
					],
				}
			}
			if (path.endsWith('/rsv-1')) {
				return { reservation: { confirmationCode: 'ABC123', partySize: 4 } }
			}
			throw new Error('forbidden')
		})
		const client = {
			scope: 'setup',
			request: requestMock,
		} as unknown as ReservationsScopedClient

		const { conflicts } = await fetchSetupConflicts(client, 'loc-1')
		expect(conflicts).toHaveLength(2)
		expect(conflicts[0]).toMatchObject({
			confirmationCode: 'ABC123',
			businessDate: '2026-04-20',
			partySize: 4,
			reason: 'table_blocked',
		})
		expect(conflicts[1]).toMatchObject({
			reason: 'table_overlap',
			confirmationCode: null,
			partySize: null,
		})
	})
})

describe('service weekday mask conversion (UI Sunday-first, mask Monday-first)', () => {
	it('round-trips all seven days and every mask', () => {
		for (let d = 0; d <= 6; d++) {
			expect(daysMaskToDaysOfWeek(daysOfWeekToDaysMask([d]))).toEqual([d])
		}
		for (let mask = 1; mask <= 127; mask++) {
			expect(daysOfWeekToDaysMask(daysMaskToDaysOfWeek(mask))).toBe(mask)
		}
		expect(daysOfWeekToDaysMask([])).toBe(127)
	})

	it('saves a Monday-only service as bit 0 and displays it as Monday', async () => {
		const requestMock = vi.fn(async (_path: string, _opts?: unknown) => ({
			service: { id: 'srv_1', name: 'Lunch', daysMask: 1 },
		}))
		const client = {
			request: requestMock,
		} as unknown as ReservationsScopedClient
		const base = {
			name: 'Lunch',
			firstSeatingMin: 720,
			lastSeatingMin: 840,
			endMin: 900,
		}
		const created = await createService(client, 'loc_1', {
			...base,
			daysOfWeek: [1],
		})
		expect((requestMock.mock.calls[0]![1] as any).body.daysMask).toBe(1)
		expect(created.service.daysOfWeek).toEqual([1])

		await updateService(client, 'loc_1', 'srv_1', { daysOfWeek: [0] })
		expect((requestMock.mock.calls[1]![1] as any).body.daysMask).toBe(64)

		// A stored Monday-only mask (bit 0) reads back as Monday (1), not Sunday.
		expect(
			normalizeService({ id: 's', name: 'x', daysMask: 1 }).daysOfWeek,
		).toEqual([1])
		expect(
			normalizeService({ id: 's', name: 'x', daysMask: 64 }).daysOfWeek,
		).toEqual([0])
	})
})
