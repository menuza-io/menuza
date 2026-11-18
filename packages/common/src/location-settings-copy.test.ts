import { describe, expect, it } from 'vitest'

import {
	addHolidayToLocation,
	mergeLocationSettings,
	type CopyLocation,
} from './location-settings-copy.ts'
import {
	LOCATION_SETTINGS_COLUMNS,
	type LocationSettingsRow,
} from './location-settings-registry.ts'

let counter = 0
const makeId = () => `new_${++counter}`

function row(overrides: Partial<LocationSettingsRow> = {}): LocationSettingsRow {
	return {
		timezone: 'America/New_York',
		storeHours: null,
		onlineHours: null,
		specialHours: null,
		prepTime: 15,
		largeOrderThreshold: 100,
		largeOrderThresholdType: 'dollars',
		largeOrderExtraPrepTime: 15,
		fulfillmentOptions: null,
		inHouseTips: null,
		tipSettings: null,
		serviceFee: null,
		onlineOrderingSettings: null,
		packagingFee: null,
		orderCaps: null,
		scheduling: null,
		deliveryConfig: null,
		...overrides,
	}
}

function loc(
	id: string,
	overrides: Partial<LocationSettingsRow> = {},
	currency = 'USD',
): CopyLocation {
	return { id, name: id, row: row(overrides), ctx: { currency } }
}

const week = (open: string, close: string) =>
	JSON.stringify(
		['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((day) => ({
			day,
			isOpen: true,
			slots: [{ start: open, end: close }],
		})),
	)

describe('mergeLocationSettings', () => {
	it('copying online hours changes only the online hours column', () => {
		const source = loc('a', {
			onlineHours: week('11:00', '22:00'),
			storeHours: week('09:00', '17:00'),
			prepTime: 40,
		})
		const target = loc('b', {
			onlineHours: week('08:00', '12:00'),
			storeHours: week('07:00', '19:00'),
			prepTime: 10,
		})
		const result = mergeLocationSettings(source, target, ['onlineHours'], {
			makeId,
		})
		expect(result.changed).toBe(true)
		expect(Object.keys(result.patch)).toEqual(['onlineHours'])
		expect(result.patch.onlineHours).toBe(
			JSON.stringify(JSON.parse(source.row.onlineHours!)),
		)
		expect(result.changedParts).toEqual(['onlineHours'])
	})

	it('reports a part the target already matches as unchanged and writes nothing', () => {
		const source = loc('a', { prepTime: 20 })
		const target = loc('b', { prepTime: 20 })
		const result = mergeLocationSettings(source, target, ['prepTime'], {
			makeId,
		})
		expect(result.changed).toBe(false)
		expect(result.patch).toEqual({})
		expect(result.changes[0]).toMatchObject({ part: 'prepTime', changed: false })
	})

	it('parts that are not selected stay untouched, every column of the patch belongs to a chosen part', () => {
		const source = loc('a', {
			prepTime: 30,
			fulfillmentOptions: JSON.stringify({
				pickup: true,
				delivery: true,
				dineIn: true,
				curbside: true,
			}),
			scheduling: JSON.stringify({
				scheduledOrdersEnabled: false,
				advanceOrderDays: 3,
			}),
		})
		const target = loc('b')
		const result = mergeLocationSettings(source, target, ['prepTime'], {
			makeId,
		})
		expect(Object.keys(result.patch)).toEqual(['prepTime'])
		for (const column of Object.keys(result.patch)) {
			expect(LOCATION_SETTINGS_COLUMNS).toContain(column)
		}
	})

	it('special hours add mode keeps the target and skips dates it already has', () => {
		const source = loc('a', {
			specialHours: JSON.stringify([
				{ id: 's1', date: '2027-12-25', isOpen: false, slots: [] },
				{ id: 's2', date: '2027-12-31', isOpen: false, slots: [] },
			]),
		})
		const target = loc('b', {
			specialHours: JSON.stringify([
				{
					id: 't1',
					date: '2027-12-25',
					isOpen: true,
					slots: [{ start: '10:00', end: '12:00' }],
				},
			]),
		})
		const result = mergeLocationSettings(source, target, ['specialHours'], {
			makeId,
			specialHours: { mode: 'add' },
		})
		const written = JSON.parse(result.patch.specialHours!) as Array<{
			date: string
			isOpen: boolean
			id: string
		}>
		expect(written.map((e) => e.date)).toEqual(['2027-12-25', '2027-12-31'])
		// The target's own 25 Dec entry is kept as it was.
		expect(written[0]).toMatchObject({ id: 't1', isOpen: true })
		// The new entry has a fresh id, never the source's.
		expect(written[1]!.id).not.toBe('s2')
	})

	it('special hours replace mode swaps only the chosen date range', () => {
		const source = loc('a', {
			specialHours: JSON.stringify([
				{ id: 's1', date: '2027-12-25', isOpen: false, slots: [] },
				{ id: 's2', date: '2028-01-05', isOpen: false, slots: [] },
			]),
		})
		const target = loc('b', {
			specialHours: JSON.stringify([
				{ id: 't0', date: '2027-11-01', isOpen: false, slots: [] },
				{ id: 't1', date: '2027-12-26', isOpen: false, slots: [] },
				{ id: 't2', date: '2028-02-01', isOpen: false, slots: [] },
			]),
		})
		const result = mergeLocationSettings(source, target, ['specialHours'], {
			makeId,
			specialHours: { mode: 'replace', from: '2027-12-01', to: '2027-12-31' },
		})
		const dates = (
			JSON.parse(result.patch.specialHours!) as Array<{ date: string }>
		).map((entry) => entry.date)
		// 2027-11-01 and 2028-02-01 are outside the range: kept. 2027-12-26 was
		// inside the range and the source has 2027-12-25 there: replaced.
		expect(dates).toEqual(['2027-11-01', '2027-12-25', '2028-02-01'])
	})

	it('states a time zone difference and keeps the same local times', () => {
		const source = loc('a', { storeHours: week('11:00', '21:00') })
		const target = loc('b', { timezone: 'America/Los_Angeles' })
		const result = mergeLocationSettings(source, target, ['storeHours'], {
			makeId,
		})
		expect(result.changes[0]!.notes).toContain('timezone_differs')
		const hours = JSON.parse(result.patch.storeHours!) as Array<{
			slots: Array<{ start: string }>
		}>
		expect(hours[0]!.slots[0]!.start).toBe('11:00')
	})

	it('warns when copied online hours will sit beside a store-hours sync', () => {
		const source = loc('a', { onlineHours: week('11:00', '22:00') })
		const target = loc('b', { onlineHours: week('08:00', '12:00') })
		const result = mergeLocationSettings(source, target, ['onlineHours'], {
			makeId,
		})
		expect(result.changes[0]!.notes).toContain('online_hours_follow_store')
		// Not when the target has switched the sync off.
		const off = loc('c', {
			onlineHours: week('08:00', '12:00'),
			onlineOrderingSettings: JSON.stringify({
				buffers: { openingBufferMinutes: 0, closingBufferMinutes: 0 },
				pickup: 'follow_online',
				delivery: 'follow_online',
				catering: 'follow_online',
				syncOnlineWithStore: false,
			}),
		})
		expect(
			mergeLocationSettings(source, off, ['onlineHours'], { makeId }).changes[0]!
				.notes,
		).not.toContain('online_hours_follow_store')
	})

	it('skips currency-sensitive parts between locations with different currencies', () => {
		const source = loc(
			'a',
			{ orderCaps: JSON.stringify({ pickup: { maxSubtotalMinor: 50000 } }) },
			'USD',
		)
		const target = loc('b', {}, 'SAR')
		const result = mergeLocationSettings(
			source,
			target,
			['orderCaps', 'prepTime'],
			{ makeId },
		)
		expect(result.changes.find((c) => c.part === 'orderCaps')).toMatchObject({
			changed: false,
			skipped: 'currency_differs',
		})
		expect(result.patch.orderCaps).toBeUndefined()
	})

	it('copies several parts and lists exactly the parts that changed', () => {
		const source = loc('a', {
			prepTime: 35,
			scheduling: JSON.stringify({
				scheduledOrdersEnabled: true,
				advanceOrderDays: 14,
			}),
		})
		const target = loc('b', {
			scheduling: JSON.stringify({
				scheduledOrdersEnabled: true,
				advanceOrderDays: 14,
			}),
		})
		const result = mergeLocationSettings(
			source,
			target,
			['prepTime', 'scheduling'],
			{ makeId },
		)
		expect(result.changedParts).toEqual(['prepTime'])
		expect(Object.keys(result.patch)).toEqual(['prepTime'])
	})
})

describe('addHolidayToLocation', () => {
	const holiday = { date: '2027-12-25', isOpen: false, slots: [], note: 'Xmas' }

	it('adds one entry to a location without the date', () => {
		const result = addHolidayToLocation(loc('a'), holiday, makeId)
		expect(result.added).toBe(true)
		const written = JSON.parse(result.patch.specialHours!) as unknown[]
		expect(written).toHaveLength(1)
	})

	it('skips a location that already has the date and leaves it untouched', () => {
		const existing = loc('b', {
			specialHours: JSON.stringify([
				{ id: 'x', date: '2027-12-25', isOpen: true, slots: [{ start: '10:00', end: '14:00' }] },
			]),
		})
		const result = addHolidayToLocation(existing, holiday, makeId)
		expect(result.added).toBe(false)
		expect(result.patch).toEqual({})
	})
})
