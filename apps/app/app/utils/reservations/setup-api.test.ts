import { describe, expect, it, vi } from 'vitest'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import {
	checkTurnTimeContiguity,
	clampCanvasCoord,
	clampCanvasDimension,
	extractApiErrorCode,
	extractApiErrorMessage,
	fetchLocationSettings,
	formatMinutesLabel,
	isVersionConflictError,
	minutesToTimeString,
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
