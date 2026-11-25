import { describe, expect, it } from 'vitest'

import {
	applySettingValue,
	canonicalSettingString,
	changedLocationSettings,
	changedLocationSettingsInForm,
	getLocationSetting,
	listLocationSettings,
	LOCATION_SETTING_IDS,
	LOCATION_SETTINGS_COLUMNS,
	LOCATION_SETTINGS_REGISTRY,
	locationSettingsMatch,
	summarizeLocationSetting,
	summarizeWeeklySchedule,
	type LocationSettingContext,
	type LocationSettingsRow,
} from './location-settings-registry.ts'
import {
	DEFAULT_IN_HOUSE_TIPS,
	DEFAULT_SCHEDULING,
	DEFAULT_WEEKLY_SCHEDULE,
} from './location-types.ts'

const ctx: LocationSettingContext = { currency: 'USD' }

function row(
	overrides: Partial<LocationSettingsRow> = {},
): LocationSettingsRow {
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

describe('location settings registry', () => {
	it('has one definition per id, in the id list order', () => {
		expect(listLocationSettings().map((definition) => definition.id)).toEqual([
			...LOCATION_SETTING_IDS,
		])
		for (const id of LOCATION_SETTING_IDS) {
			expect(LOCATION_SETTINGS_REGISTRY[id].id).toBe(id)
		}
	})

	it('only declares columns the row type knows', () => {
		const known = new Set<string>([...LOCATION_SETTINGS_COLUMNS, 'timezone'])
		for (const definition of listLocationSettings()) {
			expect(definition.columns.length).toBeGreaterThan(0)
			for (const column of definition.columns) {
				expect(known.has(column)).toBe(true)
			}
		}
	})

	it('no two settings own the same column except large-order sharing the online ordering settings JSON', () => {
		const owners = new Map<string, string[]>()
		for (const definition of listLocationSettings()) {
			for (const column of definition.columns) {
				owners.set(column, [...(owners.get(column) ?? []), definition.id])
			}
		}
		for (const [column, ids] of owners) {
			if (column === 'onlineOrderingSettings') {
				expect(ids).toEqual(['largeOrder'])
			} else {
				expect(ids).toHaveLength(1)
			}
		}
	})

	it('writes then reads back the same value for every setting (round trip)', () => {
		const samples: Record<string, unknown> = {
			storeHours: DEFAULT_WEEKLY_SCHEDULE,
			onlineHours: DEFAULT_WEEKLY_SCHEDULE,
			specialHours: [
				{ date: '2027-12-25', isOpen: false, slots: [] },
				{
					date: '2027-12-24',
					isOpen: true,
					slots: [{ start: '10:00', end: '14:00' }],
					note: 'Short day',
				},
			],
			prepTime: 25,
			largeOrder: {
				threshold: 50,
				thresholdType: 'items',
				extraPrepTime: 20,
				rule: { itemThreshold: 8, amountMinor: null, extraMinutes: 20 },
			},
			fulfillment: {
				pickup: true,
				delivery: true,
				dineIn: false,
				curbside: true,
			},
			tips: {
				inHouseTips: {
					pickupTips: true,
					deliveryTips: false,
					dineInTips: true,
				},
				tipSettings: getLocationSetting('tips').systemDefault(ctx).tipSettings,
			},
			scheduling: { scheduledOrdersEnabled: true, advanceOrderDays: 5 },
			delivery: {
				providers: ['in_house'],
				estimatedDeliveryTimeMin: 30,
				estimatedDeliveryTimeMax: 45,
			},
			orderCaps: { pickup: { maxSubtotalMinor: 50000 } },
			serviceFee: null,
			packagingFee: null,
		}
		for (const id of LOCATION_SETTING_IDS) {
			const definition = getLocationSetting(id)
			const value = samples[id]
			const parsed = definition.parse(value)
			expect(parsed.ok, `${id} sample parses`).toBe(true)
			const { row: written } = applySettingValue(id, row(), value, ctx)
			expect(
				canonicalSettingString(definition.read(written, ctx)),
				`${id} round trip`,
			).toBe(canonicalSettingString(definition.read(written, ctx)))
			// Reading what we wrote and writing it again changes nothing.
			const again = applySettingValue(
				id,
				written,
				definition.read(written, ctx),
				ctx,
			)
			expect(changedLocationSettings(written, again.row, ctx)).toEqual([])
			// And the value we read equals the sample (canonical form).
			expect(
				canonicalSettingString(definition.read(written, ctx)),
				`${id} equals sample`,
			).toBe(
				canonicalSettingString(
					id === 'specialHours'
						? definition.read(applySettingValue(id, row(), value, ctx).row, ctx)
						: value,
				),
			)
		}
	})

	it('a write only touches the columns the setting owns', () => {
		for (const id of LOCATION_SETTING_IDS) {
			const definition = getLocationSetting(id)
			const patch = definition.write(row(), definition.systemDefault(ctx), ctx)
			for (const column of Object.keys(patch)) {
				expect(definition.columns).toContain(column)
			}
		}
	})

	it('treats a stored null and an explicit default as the same value where the app does', () => {
		const stored = row({ tipSettings: null })
		const explicit = applySettingValue(
			'tips',
			stored,
			getLocationSetting('tips').systemDefault(ctx),
			ctx,
		).row
		expect(locationSettingsMatch('tips', stored, ctx, explicit, ctx)).toBe(true)
		expect(
			locationSettingsMatch(
				'fulfillment',
				row({ fulfillmentOptions: null }),
				ctx,
				row({
					fulfillmentOptions: JSON.stringify({
						pickup: true,
						delivery: true,
						dineIn: true,
						curbside: false,
					}),
				}),
				ctx,
			),
		).toBe(true)
	})

	it('an untouched form save is never a change, even where columns were never saved', () => {
		const stored = row() // every JSON column null: the form fills in defaults
		const posted = {
			...stored,
			storeHours: JSON.stringify(DEFAULT_WEEKLY_SCHEDULE),
			onlineHours: JSON.stringify(DEFAULT_WEEKLY_SCHEDULE),
			inHouseTips: JSON.stringify(DEFAULT_IN_HOUSE_TIPS),
			scheduling: JSON.stringify(DEFAULT_SCHEDULING),
			specialHours: JSON.stringify([]),
			deliveryConfig: JSON.stringify({
				providers: ['in_house', 'uber_eats', 'doordash'],
				estimatedDeliveryTimeMin: 25,
				estimatedDeliveryTimeMax: 45,
			}),
			tipSettings: JSON.stringify(
				getLocationSetting('tips').systemDefault(ctx).tipSettings,
			),
		}
		expect(changedLocationSettingsInForm(stored, posted, ctx)).toEqual([])
		// A real edit still shows up.
		expect(
			changedLocationSettingsInForm(stored, { ...posted, prepTime: 30 }, ctx),
		).toEqual(['prepTime'])
		expect(
			changedLocationSettingsInForm(
				stored,
				{ ...posted, storeHours: JSON.stringify([]) },
				ctx,
			),
		).toEqual(['storeHours'])
	})

	it('reads the older delivery time key spelling', () => {
		const legacy = row({
			deliveryConfig: JSON.stringify({
				providers: ['doordash'],
				estimatedTimeMin: 20,
				estimatedTimeMax: 40,
			}),
		})
		expect(getLocationSetting('delivery').read(legacy, ctx)).toEqual({
			providers: ['doordash'],
			estimatedDeliveryTimeMin: 20,
			estimatedDeliveryTimeMax: 40,
		})
	})

	it('copying delivery settings never carries the zone order, and keeps the target\'s own (#266)', () => {
		const delivery = getLocationSetting('delivery')
		const source = row({
			deliveryConfig: JSON.stringify({
				providers: ['in_house'],
				estimatedDeliveryTimeMin: 20,
				estimatedDeliveryTimeMax: 40,
				zonePriority: 'order',
			}),
		})
		const value = delivery.read(source, ctx)
		expect(value).not.toHaveProperty('zonePriority')
		const untouched = delivery.write(row({ deliveryConfig: null }), value, ctx)
		expect(JSON.parse(untouched.deliveryConfig!)).not.toHaveProperty('zonePriority')
		const reordered = delivery.write(
			row({
				deliveryConfig: JSON.stringify({
					providers: ['in_house'],
					estimatedDeliveryTimeMin: 25,
					estimatedDeliveryTimeMax: 45,
					zonePriority: 'order',
				}),
			}),
			value,
			ctx,
		)
		expect(JSON.parse(reordered.deliveryConfig!)).toMatchObject({
			estimatedDeliveryTimeMin: 20,
			zonePriority: 'order',
		})
	})

	it('a large-order write keeps buffers and utensils of the target', () => {
		const target = row({
			onlineOrderingSettings: JSON.stringify({
				buffers: { openingBufferMinutes: 10, closingBufferMinutes: 5 },
				pickup: 'custom',
				delivery: 'follow_online',
				catering: 'follow_online',
				syncOnlineWithStore: false,
				utensils: { enabled: true, defaultRequested: false },
			}),
		})
		const { patch } = applySettingValue(
			'largeOrder',
			target,
			{
				threshold: 100,
				thresholdType: 'dollars',
				extraPrepTime: 15,
				rule: { itemThreshold: 12, amountMinor: null, extraMinutes: 30 },
			},
			ctx,
		)
		const next = JSON.parse(patch.onlineOrderingSettings!) as Record<
			string,
			unknown
		>
		expect(next.buffers).toEqual({
			openingBufferMinutes: 10,
			closingBufferMinutes: 5,
		})
		expect(next.pickup).toBe('custom')
		expect(next.syncOnlineWithStore).toBe(false)
		expect(next.utensils).toEqual({ enabled: true, defaultRequested: false })
		expect(next.largeOrder).toEqual({
			itemThreshold: 12,
			amountMinor: null,
			extraMinutes: 30,
		})
	})

	it('rejects values that do not fit the setting', () => {
		expect(getLocationSetting('prepTime').parse(-1).ok).toBe(false)
		expect(getLocationSetting('prepTime').parse(1.5).ok).toBe(false)
		expect(getLocationSetting('prepTime').parse(99999).ok).toBe(false)
		expect(getLocationSetting('fulfillment').parse({ pickup: true }).ok).toBe(
			false,
		)
		expect(getLocationSetting('scheduling').parse({}).ok).toBe(false)
	})

	it('summarises hours in plain words', () => {
		expect(summarizeWeeklySchedule(null)).toBe('Not set')
		const week = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map(
			(day) => ({
				day,
				isOpen: true,
				slots: [{ start: '09:00', end: '17:00' }],
			}),
		)
		const text = summarizeWeeklySchedule([
			...week,
			{ day: 'saturday', isOpen: false, slots: [] },
			{ day: 'sunday', isOpen: false, slots: [] },
		] as never)
		expect(text).toBe('Mon-Fri 09:00-17:00; Sat-Sun closed')
		expect(
			summarizeLocationSetting('prepTime', row({ prepTime: 20 }), ctx),
		).toBe('20 min')
	})

	it('only the special hours setting opts out of a chain default', () => {
		expect(
			listLocationSettings()
				.filter((definition) => !definition.chainDefault)
				.map((definition) => definition.id),
		).toEqual(['specialHours'])
	})
})
