import { defaultTipSettings } from '@repo/common/location-types'
import { defaultServiceFeeSettings } from '@repo/common/service-fee'
import { describe, expect, it } from 'vitest'
import {
	parseCustomTip,
	sameTipSelection,
	serviceFeeChargeMinor,
	serviceFeeFor,
	tipPayload,
	tipSelectionMinor,
	tipViewFor,
	type CheckoutOptions,
} from './checkout-extras.ts'

const withTips = (patch: (s: ReturnType<typeof defaultTipSettings>) => void, currency = 'USD'): CheckoutOptions => {
	const settings = defaultTipSettings(currency)
	patch(settings)
	return { tipChoices: { currency, settings } }
}

describe('tipViewFor', () => {
	it('falls back to 10, 15, 18 and 20 with 15 selected when the node sends none', () => {
		const view = tipViewFor(null, 'pickup', 'USD')
		expect(view.choices).toEqual([
			{ percent: 10 },
			{ percent: 15 },
			{ percent: 18 },
			{ percent: 20 },
		])
		expect(view.initial).toEqual({ kind: 'percent', percent: 15 })
		expect(view.allowCustom).toBe(false)
	})

	it('preselects no tip for SAR when the node sends none', () => {
		expect(tipViewFor(null, 'delivery', 'SAR').initial).toEqual({ kind: 'none' })
		expect(tipViewFor({}, 'delivery', 'SAR').initial).toEqual({ kind: 'none' })
	})

	it('shows the configured choices, default and custom per order type', () => {
		const options = withTips((s) => {
			s.delivery = {
				choices: [{ percent: 5 }, { amountMinor: 300 }],
				defaultIndex: 1,
				allowCustom: true,
			}
		})
		const delivery = tipViewFor(options, 'delivery', 'USD')
		expect(delivery.choices).toEqual([{ percent: 5 }, { amountMinor: 300 }])
		expect(delivery.initial).toEqual({ kind: 'amount', amountMinor: 300 })
		expect(delivery.allowCustom).toBe(true)
		// Pickup keeps the default buttons.
		expect(tipViewFor(options, 'pickup', 'USD').choices).toHaveLength(4)
	})

	it('allows no preselected tip', () => {
		const options = withTips((s) => {
			s.pickup.defaultIndex = null
		})
		expect(tipViewFor(options, 'pickup', 'USD').initial).toEqual({ kind: 'none' })
	})
})

describe('tips as money and as an order field', () => {
	it('works out a share on the subtotal and keeps an amount exact', () => {
		expect(tipSelectionMinor({ kind: 'percent', percent: 15 }, 2000)).toBe(300)
		expect(tipSelectionMinor({ kind: 'amount', amountMinor: 437 }, 2000)).toBe(437)
		expect(tipSelectionMinor({ kind: 'none' }, 2000)).toBe(0)
	})

	it('sends a share as tipPercent and an amount as tip', () => {
		expect(tipPayload({ kind: 'percent', percent: 18 })).toEqual({ tipPercent: 18 })
		expect(tipPayload({ kind: 'none' })).toEqual({ tipPercent: 0 })
		expect(tipPayload({ kind: 'amount', amountMinor: 437 })).toEqual({
			tipPercent: 0,
			tip: { amountMinor: 437 },
		})
	})

	it('compares selections', () => {
		expect(sameTipSelection({ kind: 'none' }, { kind: 'none' })).toBe(true)
		expect(
			sameTipSelection({ kind: 'percent', percent: 10 }, { kind: 'percent', percent: 15 }),
		).toBe(false)
		expect(
			sameTipSelection({ kind: 'amount', amountMinor: 5 }, { kind: 'percent', percent: 5 }),
		).toBe(false)
	})
})

describe('parseCustomTip', () => {
	it('reads decimals, Arabic digits and the Arabic decimal mark', () => {
		expect(parseCustomTip('4', 'USD', 2000)).toEqual({ ok: true, amountMinor: 400 })
		expect(parseCustomTip('4.5', 'USD', 2000)).toEqual({ ok: true, amountMinor: 450 })
		expect(parseCustomTip('٤٫٥٠', 'USD', 2000)).toEqual({ ok: true, amountMinor: 450 })
		expect(parseCustomTip('0', 'USD', 2000)).toEqual({ ok: true, amountMinor: 0 })
	})

	it('refuses anything that is not an amount', () => {
		for (const text of ['', 'abc', '-3', '4.567', '4,5', '1e3']) {
			expect(parseCustomTip(text, 'USD', 2000)).toEqual({ ok: false, reason: 'invalid' })
		}
	})

	it('refuses above the cap like the region', () => {
		expect(parseCustomTip('200', 'USD', 2000).ok).toBe(true)
		expect(parseCustomTip('200.01', 'USD', 2000)).toEqual({ ok: false, reason: 'too_large' })
		expect(parseCustomTip('750', 'SAR', 2000).ok).toBe(true)
		expect(parseCustomTip('750.01', 'SAR', 2000).ok).toBe(false)
		// Half of a 1000.00 subtotal beats the currency cap.
		expect(parseCustomTip('500', 'USD', 100_000).ok).toBe(true)
	})
})

describe('serviceFeeFor', () => {
	const on = (patch = {}): CheckoutOptions => ({
		serviceFee: { ...defaultServiceFeeSettings('USD'), enabled: true, ...patch },
	})
	const base = {
		fulfillment: 'pickup' as const,
		subtotalMinor: 5000,
		discountMinor: 0,
		taxRatePercent: 0,
		taxInclusive: false,
		defaultLabel: 'Frais de service',
	}

	it('has no line when the location has no fee', () => {
		expect(serviceFeeFor(null, base)).toBeNull()
		expect(serviceFeeFor({ serviceFee: null }, base)).toBeNull()
	})

	it('prices 3 % on what discounts left, with the default name in the guest language', () => {
		const fee = serviceFeeFor(on(), { ...base, discountMinor: 1000 })
		expect(fee).toMatchObject({ feeCents: 120, label: 'Frais de service' })
	})

	it('keeps a name the restaurant chose and its explanation', () => {
		const fee = serviceFeeFor(on({ label: 'Online fee', explanation: 'Covers cards.' }), base)
		expect(fee).toMatchObject({ label: 'Online fee', explanation: 'Covers cards.' })
	})

	it('has no line for an order type it does not cover or a free order', () => {
		expect(serviceFeeFor(on(), { ...base, fulfillment: 'dine_in' })).toBeNull()
		expect(serviceFeeFor(on(), { ...base, subtotalMinor: 1000, discountMinor: 1000 })).toBeNull()
	})

	it('charges the fee tax on top only when prices exclude tax', () => {
		const fee = serviceFeeFor(on({ taxable: true }), { ...base, taxRatePercent: 10 })!
		expect(fee).toMatchObject({ feeCents: 150, taxCents: 15 })
		expect(serviceFeeChargeMinor(fee, false)).toBe(165)
		expect(serviceFeeChargeMinor(fee, true)).toBe(150)
	})
})

describe('tipViewOf (a table tab)', () => {
  it('keeps the old 10, 15 and 20 buttons with none selected until saved', async () => {
    const { tipViewOf } = await import('./checkout-extras.ts')
    const view = tipViewOf(undefined, 'qrTab', 'USD')
    expect(view.choices).toEqual([{ percent: 10 }, { percent: 15 }, { percent: 20 }])
    expect(view.initial).toEqual({ kind: 'none' })
    expect(view.allowCustom).toBe(false)
  })

  it('shows a saved table choice and its default', async () => {
    const { tipViewOf } = await import('./checkout-extras.ts')
    const view = tipViewOf(
      { choices: [{ percent: 12 }, { amountMinor: 200 }], defaultIndex: 0, allowCustom: true },
      'qrTab',
      'SAR',
    )
    expect(view.initial).toEqual({ kind: 'percent', percent: 12 })
    expect(view.allowCustom).toBe(true)
  })
})
