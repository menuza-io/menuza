import { parseOnlineOrderingSettings } from '@repo/common/location-settings'
import { describe, expect, it } from 'vitest'
import {
	defaultOnlineOrderingForm,
	largeOrderFieldsFromLegacy,
	largeOrderFromForm,
	minorToAmountInput,
	onlineOrderingFormFromRecord,
	orderingSettingsFormFromRecord,
	parseOrderingSettingsFields,
} from './ordering-settings.ts'

const flags = { slotLimits: false, prayerPause: false }

function bundle(online: Record<string, unknown>) {
	const base = orderingSettingsFormFromRecord({
		onlineOrderingSettings: null,
		slotLimitSettings: null,
		prepSchedule: null,
		prayerPauseSettings: null,
	})
	return {
		orderingSettings: JSON.stringify({
			...base,
			online: { ...base.online, ...online },
		}),
	}
}

function savedLargeOrder(raw: Record<string, unknown>) {
	const result = parseOrderingSettingsFields(raw, flags)
	if (!result.ok) throw new Error(result.error)
	return parseOnlineOrderingSettings(result.patch.onlineOrderingSettings)
		?.largeOrder
}

describe('large orders: the form from the saved record (#355)', () => {
	it('starts a location that never saved the rule from its old columns', () => {
		expect(
			largeOrderFieldsFromLegacy({
				largeOrderThreshold: 12,
				largeOrderThresholdType: 'items',
				largeOrderExtraPrepTime: 15,
			}),
		).toEqual({
			largeOrderItems: '12',
			largeOrderAmount: '',
			largeOrderMinutes: '15',
		})
		expect(
			largeOrderFieldsFromLegacy({
				largeOrderThreshold: 300,
				largeOrderThresholdType: 'dollars',
				largeOrderExtraPrepTime: 20,
			}),
		).toEqual({
			largeOrderItems: '',
			largeOrderAmount: '300',
			largeOrderMinutes: '20',
		})
	})

	it('keeps cents of an old amount threshold', () => {
		expect(
			largeOrderFieldsFromLegacy({
				largeOrderThreshold: 99.5,
				largeOrderThresholdType: 'dollars',
				largeOrderExtraPrepTime: 5,
			}).largeOrderAmount,
		).toBe('99.5')
	})

	it('reads an old rule that cannot apply as no rule', () => {
		const none = {
			largeOrderItems: '',
			largeOrderAmount: '',
			largeOrderMinutes: '',
		}
		for (const legacy of [
			undefined,
			{
				largeOrderThreshold: 0,
				largeOrderThresholdType: 'items',
				largeOrderExtraPrepTime: 15,
			},
			{
				largeOrderThreshold: 12,
				largeOrderThresholdType: 'items',
				largeOrderExtraPrepTime: 0,
			},
			{
				largeOrderThreshold: 12,
				largeOrderThresholdType: 'weird',
				largeOrderExtraPrepTime: 15,
			},
			{
				largeOrderThreshold: null,
				largeOrderThresholdType: null,
				largeOrderExtraPrepTime: null,
			},
		]) {
			expect(largeOrderFieldsFromLegacy(legacy)).toEqual(none)
		}
	})

	it('shows the saved rule, both thresholds, and prefers it to the old columns', () => {
		const record = JSON.stringify({
			buffers: { openingBufferMinutes: 0, closingBufferMinutes: 0 },
			pickup: 'follow_online',
			delivery: 'follow_online',
			catering: 'follow_online',
			syncOnlineWithStore: true,
			largeOrder: { itemThreshold: 12, amountMinor: 30_050, extraMinutes: 20 },
		})
		const form = onlineOrderingFormFromRecord(record, {
			largeOrderThreshold: 5,
			largeOrderThresholdType: 'items',
			largeOrderExtraPrepTime: 99,
		})
		expect(form).toMatchObject({
			largeOrderItems: '12',
			largeOrderAmount: '300.5',
			largeOrderMinutes: '20',
		})
	})

	it('shows a saved rule that was switched off as empty, not as the old columns', () => {
		const record = JSON.stringify({
			buffers: { openingBufferMinutes: 0, closingBufferMinutes: 0 },
			pickup: 'follow_online',
			delivery: 'follow_online',
			catering: 'follow_online',
			syncOnlineWithStore: true,
			largeOrder: { itemThreshold: null, amountMinor: null, extraMinutes: 0 },
		})
		expect(
			onlineOrderingFormFromRecord(record, {
				largeOrderThreshold: 100,
				largeOrderThresholdType: 'dollars',
				largeOrderExtraPrepTime: 15,
			}),
		).toMatchObject({
			largeOrderItems: '',
			largeOrderAmount: '',
			largeOrderMinutes: '',
		})
	})

	it('starts a new location with the rule locations always started with', () => {
		expect(defaultOnlineOrderingForm()).toMatchObject({
			largeOrderItems: '',
			largeOrderAmount: '100',
			largeOrderMinutes: '15',
		})
	})

	it('formats minor units as a typed amount', () => {
		expect(minorToAmountInput(30_000)).toBe('300')
		expect(minorToAmountInput(30_050)).toBe('300.5')
		expect(minorToAmountInput(30_005)).toBe('300.05')
	})
})

describe('large orders: the form to the saved rule (#355)', () => {
	it('saves either threshold or both, the amount in minor units', () => {
		expect(
			largeOrderFromForm({
				largeOrderItems: '12',
				largeOrderAmount: '',
				largeOrderMinutes: '15',
			}),
		).toEqual({
			ok: true,
			value: { itemThreshold: 12, amountMinor: null, extraMinutes: 15 },
		})
		expect(
			largeOrderFromForm({
				largeOrderItems: '',
				largeOrderAmount: '300',
				largeOrderMinutes: '15',
			}),
		).toEqual({
			ok: true,
			value: { itemThreshold: null, amountMinor: 30_000, extraMinutes: 15 },
		})
		expect(
			largeOrderFromForm({
				largeOrderItems: '12',
				largeOrderAmount: '300.50',
				largeOrderMinutes: '15',
			}),
		).toEqual({
			ok: true,
			value: { itemThreshold: 12, amountMinor: 30_050, extraMinutes: 15 },
		})
	})

	it('reads Arabic digits like the other money fields', () => {
		expect(
			largeOrderFromForm({
				largeOrderItems: '١٢',
				largeOrderAmount: '٣٠٠٫٥٠',
				largeOrderMinutes: '١٥',
			}),
		).toEqual({
			ok: true,
			value: { itemThreshold: 12, amountMinor: 30_050, extraMinutes: 15 },
		})
	})

	it('saves an empty rule as the rule switched off', () => {
		expect(
			largeOrderFromForm({
				largeOrderItems: '',
				largeOrderAmount: '',
				largeOrderMinutes: '',
			}),
		).toEqual({
			ok: true,
			value: { itemThreshold: null, amountMinor: null, extraMinutes: 0 },
		})
	})

	it('needs the minutes whenever a threshold is set', () => {
		for (const minutes of ['', '0']) {
			const result = largeOrderFromForm({
				largeOrderItems: '12',
				largeOrderAmount: '',
				largeOrderMinutes: minutes,
			})
			expect(result).toMatchObject({ ok: false })
		}
	})

	it.each([
		['items', { largeOrderItems: '0' }],
		['items', { largeOrderItems: '2.5' }],
		['items', { largeOrderItems: '1001' }],
		['items', { largeOrderItems: 'many' }],
		['amount', { largeOrderAmount: '0' }],
		['amount', { largeOrderAmount: '-5' }],
		['amount', { largeOrderAmount: '1.234' }],
		['amount', { largeOrderAmount: 'lots' }],
		['minutes', { largeOrderMinutes: '241' }],
		['minutes', { largeOrderMinutes: 'soon' }],
	])('refuses a bad %s entry %j', (_field, patch) => {
		const result = largeOrderFromForm({
			largeOrderItems: '12',
			largeOrderAmount: '',
			largeOrderMinutes: '15',
			...patch,
		})
		expect(result.ok).toBe(false)
	})

	it('leaves the rule alone when a form from before this change posts none', () => {
		expect(largeOrderFromForm({})).toEqual({ ok: true, value: undefined })
	})
})

describe('large orders through the settings bundle (#355)', () => {
	it('stores the rule inside the online ordering settings', () => {
		const saved = savedLargeOrder(
			bundle({
				largeOrderItems: '12',
				largeOrderAmount: '300',
				largeOrderMinutes: '15',
			}),
		)
		expect(saved).toEqual({
			itemThreshold: 12,
			amountMinor: 30_000,
			extraMinutes: 15,
		})
	})

	it('stores a cleared rule as present but empty, so it overrides the old columns', () => {
		expect(
			savedLargeOrder(
				bundle({
					largeOrderItems: '',
					largeOrderAmount: '',
					largeOrderMinutes: '',
				}),
			),
		).toEqual({ itemThreshold: null, amountMinor: null, extraMinutes: 0 })
	})

	it('refuses a bad entry with a plain message and saves nothing', () => {
		const result = parseOrderingSettingsFields(
			bundle({
				largeOrderItems: 'lots',
				largeOrderAmount: '',
				largeOrderMinutes: '15',
			}),
			flags,
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/items/i)
	})

	it('writes no rule for a form that posted none, so the old columns keep applying', () => {
		const base = orderingSettingsFormFromRecord({
			onlineOrderingSettings: null,
			slotLimitSettings: null,
			prepSchedule: null,
			prayerPauseSettings: null,
		})
		const {
			largeOrderItems: _i,
			largeOrderAmount: _a,
			largeOrderMinutes: _m,
			...stale
		} = base.online
		const result = parseOrderingSettingsFields(
			{ orderingSettings: JSON.stringify({ ...base, online: stale }) },
			flags,
		)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(
				parseOnlineOrderingSettings(result.patch.onlineOrderingSettings)
					?.largeOrder,
			).toBeUndefined()
		}
	})

	it('round-trips: what is saved is what the form shows next time', () => {
		const saved = parseOrderingSettingsFields(
			bundle({
				largeOrderItems: '8',
				largeOrderAmount: '250.5',
				largeOrderMinutes: '10',
			}),
			flags,
		)
		if (!saved.ok) throw new Error(saved.error)
		expect(
			onlineOrderingFormFromRecord(saved.patch.onlineOrderingSettings),
		).toMatchObject({
			largeOrderItems: '8',
			largeOrderAmount: '250.5',
			largeOrderMinutes: '10',
		})
	})
})
