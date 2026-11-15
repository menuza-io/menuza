import { describe, expect, it } from 'vitest'
import {
	computeTip,
	maxTipMinor,
	orderTipSchema,
	requestedTip,
	requestsTip,
	canonicalTip,
} from './order-tips.ts'
import {
	TipSettingsSchema,
	defaultTipSettings,
	resolveTipSettings,
} from './location-types.ts'

describe('computeTip', () => {
	it('takes a percentage of the subtotal and keeps the percent', () => {
		expect(
			computeTip({ tip: { percent: 15 }, subtotalCents: 2000, currency: 'USD' }),
		).toEqual({ ok: true, tipCents: 300, tipPercent: 15 })
	})

	it('charges a custom amount exactly with a null percent', () => {
		expect(
			computeTip({
				tip: { amountMinor: 437 },
				subtotalCents: 2000,
				currency: 'USD',
			}),
		).toEqual({ ok: true, tipCents: 437, tipPercent: null })
	})

	it('accepts 0 as an amount', () => {
		expect(
			computeTip({ tip: { amountMinor: 0 }, subtotalCents: 0, currency: 'SAR' }),
		).toEqual({ ok: true, tipCents: 0, tipPercent: null })
	})

	it('refuses an amount above the currency cap on a small order', () => {
		expect(
			computeTip({
				tip: { amountMinor: 20_001 },
				subtotalCents: 2000,
				currency: 'USD',
			}),
		).toEqual({ ok: false, code: 'tip_too_large' })
		expect(
			computeTip({
				tip: { amountMinor: 20_000 },
				subtotalCents: 2000,
				currency: 'USD',
			}).ok,
		).toBe(true)
	})

	it('uses 750 for SAR and 200 major units for an unknown currency', () => {
		expect(maxTipMinor(1000, 'SAR')).toBe(75_000)
		expect(maxTipMinor(1000, 'sar')).toBe(75_000)
		expect(maxTipMinor(1000, 'EUR')).toBe(20_000)
	})

	it('allows half the subtotal when that is larger than the cap', () => {
		// 50 % of 1000.00 USD is 500.00, above the 200.00 cap.
		expect(maxTipMinor(100_000, 'USD')).toBe(50_000)
		expect(
			computeTip({
				tip: { amountMinor: 50_000 },
				subtotalCents: 100_000,
				currency: 'USD',
			}).ok,
		).toBe(true)
		expect(
			computeTip({
				tip: { amountMinor: 50_001 },
				subtotalCents: 100_000,
				currency: 'USD',
			}).ok,
		).toBe(false)
	})
})

describe('the tip a request carries', () => {
	it('reads the legacy tipPercent when tip is absent', () => {
		expect(requestedTip({ tipPercent: 18 })).toEqual({ percent: 18 })
		expect(requestedTip({})).toEqual({ percent: 0 })
		expect(requestsTip({ tipPercent: 0 })).toBe(false)
		expect(requestsTip({ tipPercent: 5 })).toBe(true)
	})

	it('prefers tip and detects an amount', () => {
		expect(requestedTip({ tip: { amountMinor: 300 }, tipPercent: 0 })).toEqual({
			amountMinor: 300,
		})
		expect(requestsTip({ tip: { amountMinor: 300 } })).toBe(true)
		expect(requestsTip({ tip: { amountMinor: 0 } })).toBe(false)
	})

	it('hashes a percent like the old tipPercent and an amount apart', () => {
		expect(canonicalTip({ tipPercent: 15 })).toEqual({ tipPercent: 15 })
		expect(canonicalTip({ tip: { percent: 15 } })).toEqual({ tipPercent: 15 })
		expect(canonicalTip({ tip: { amountMinor: 15 } })).toEqual({
			tipAmountMinor: 15,
		})
	})

	it('rejects a malformed tip', () => {
		for (const bad of [
			{ percent: 31 },
			{ percent: 1.5 },
			{ amountMinor: -1 },
			{ amountMinor: 1.5 },
			{ percent: 10, amountMinor: 5 },
			{},
		]) {
			expect(orderTipSchema.safeParse(bad).success).toBe(false)
		}
	})
})

describe('tip settings', () => {
	it('defaults to the old buttons with 15 selected, none for SAR', () => {
		const usd = defaultTipSettings('USD')
		expect(usd.pickup.choices).toEqual([
			{ percent: 10 },
			{ percent: 15 },
			{ percent: 18 },
			{ percent: 20 },
		])
		expect(usd.pickup.defaultIndex).toBe(1)
		expect(usd.pickup.allowCustom).toBe(false)
		expect(defaultTipSettings('SAR').delivery.defaultIndex).toBeNull()
	})

	it('requires the default to be one of the choices', () => {
		const settings = defaultTipSettings('USD')
		expect(TipSettingsSchema.safeParse(settings).success).toBe(true)
		expect(
			TipSettingsSchema.safeParse({
				...settings,
				pickup: { ...settings.pickup, defaultIndex: 4 },
			}).success,
		).toBe(false)
	})

	it('allows at most four choices, no repeats, and not nothing at all', () => {
		const base = defaultTipSettings('USD').pickup
		const make = (pickup: unknown) =>
			TipSettingsSchema.safeParse({ ...defaultTipSettings('USD'), pickup })
				.success
		expect(
			make({
				...base,
				choices: [...base.choices, { percent: 25 }],
				defaultIndex: null,
			}),
		).toBe(false)
		expect(
			make({ ...base, choices: [{ percent: 10 }, { percent: 10 }], defaultIndex: null }),
		).toBe(false)
		expect(make({ choices: [], defaultIndex: null, allowCustom: false })).toBe(
			false,
		)
		expect(make({ choices: [], defaultIndex: null, allowCustom: true })).toBe(
			true,
		)
		expect(
			make({
				choices: [{ amountMinor: 200 }, { percent: 10 }],
				defaultIndex: 0,
				allowCustom: true,
			}),
		).toBe(true)
	})

	it('falls back to the default for a missing or unreadable order type', () => {
		const resolved = resolveTipSettings(
			JSON.stringify({
				pickup: { choices: [{ percent: 5 }], defaultIndex: 0, allowCustom: true },
				delivery: { choices: 'nope' },
			}),
			'USD',
		)
		expect(resolved.pickup.choices).toEqual([{ percent: 5 }])
		expect(resolved.delivery).toEqual(defaultTipSettings('USD').delivery)
		expect(resolved.qrTab).toEqual(defaultTipSettings('USD').qrTab)
		// A table tab keeps its old buttons: 10, 15 and 20, none selected.
		expect(resolved.qrTab.choices).toEqual([
			{ percent: 10 },
			{ percent: 15 },
			{ percent: 20 },
		])
		expect(resolved.qrTab.defaultIndex).toBeNull()
		expect(resolveTipSettings('{not json', 'SAR').pickup.defaultIndex).toBeNull()
		expect(resolveTipSettings(null, 'USD')).toEqual(defaultTipSettings('USD'))
	})
})
