import { defaultTipSettings } from '@repo/common/location-types'
import { defaultPackagingFeeSettings } from '@repo/common/packaging-fee'
import { defaultServiceFeeSettings } from '@repo/common/service-fee'
import { describe, expect, it } from 'vitest'
import {
	packagingFeeChargeMinor,
	packagingFeeFor,
	parseCustomTip,
	pickupInstructionsFor,
	sameTipSelection,
	serviceFeeChargeMinor,
	serviceFeeFor,
	tipPayload,
	tipSelectionMinor,
	tipViewFor,
	utensilsView,
	type CheckoutOptions,
} from './checkout-extras.ts'

const withTips = (
	patch: (s: ReturnType<typeof defaultTipSettings>) => void,
	currency = 'USD',
): CheckoutOptions => {
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
		expect(tipViewFor(null, 'delivery', 'SAR').initial).toEqual({
			kind: 'none',
		})
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
		expect(tipViewFor(options, 'pickup', 'USD').initial).toEqual({
			kind: 'none',
		})
	})
})

describe('tips as money and as an order field', () => {
	it('works out a share on the subtotal and keeps an amount exact', () => {
		expect(tipSelectionMinor({ kind: 'percent', percent: 15 }, 2000)).toBe(300)
		expect(tipSelectionMinor({ kind: 'amount', amountMinor: 437 }, 2000)).toBe(
			437,
		)
		expect(tipSelectionMinor({ kind: 'none' }, 2000)).toBe(0)
	})

	it('sends a share as tipPercent and an amount as tip', () => {
		expect(tipPayload({ kind: 'percent', percent: 18 })).toEqual({
			tipPercent: 18,
		})
		expect(tipPayload({ kind: 'none' })).toEqual({ tipPercent: 0 })
		expect(tipPayload({ kind: 'amount', amountMinor: 437 })).toEqual({
			tipPercent: 0,
			tip: { amountMinor: 437 },
		})
	})

	it('compares selections', () => {
		expect(sameTipSelection({ kind: 'none' }, { kind: 'none' })).toBe(true)
		expect(
			sameTipSelection(
				{ kind: 'percent', percent: 10 },
				{ kind: 'percent', percent: 15 },
			),
		).toBe(false)
		expect(
			sameTipSelection(
				{ kind: 'amount', amountMinor: 5 },
				{ kind: 'percent', percent: 5 },
			),
		).toBe(false)
	})
})

describe('parseCustomTip', () => {
	it('reads decimals, Arabic digits and the Arabic decimal mark', () => {
		expect(parseCustomTip('4', 'USD', 2000)).toEqual({
			ok: true,
			amountMinor: 400,
		})
		expect(parseCustomTip('4.5', 'USD', 2000)).toEqual({
			ok: true,
			amountMinor: 450,
		})
		expect(parseCustomTip('٤٫٥٠', 'USD', 2000)).toEqual({
			ok: true,
			amountMinor: 450,
		})
		expect(parseCustomTip('0', 'USD', 2000)).toEqual({
			ok: true,
			amountMinor: 0,
		})
	})

	it('refuses anything that is not an amount', () => {
		for (const text of ['', 'abc', '-3', '4.567', '4,5', '1e3']) {
			expect(parseCustomTip(text, 'USD', 2000)).toEqual({
				ok: false,
				reason: 'invalid',
			})
		}
	})

	it('refuses above the cap like the region', () => {
		expect(parseCustomTip('200', 'USD', 2000).ok).toBe(true)
		expect(parseCustomTip('200.01', 'USD', 2000)).toEqual({
			ok: false,
			reason: 'too_large',
		})
		expect(parseCustomTip('750', 'SAR', 2000).ok).toBe(true)
		expect(parseCustomTip('750.01', 'SAR', 2000).ok).toBe(false)
		// Half of a 1000.00 subtotal beats the currency cap.
		expect(parseCustomTip('500', 'USD', 100_000).ok).toBe(true)
	})
})

describe('serviceFeeFor', () => {
	const on = (patch = {}): CheckoutOptions => ({
		serviceFee: {
			...defaultServiceFeeSettings('USD'),
			enabled: true,
			...patch,
		},
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
		const fee = serviceFeeFor(
			on({ label: 'Online fee', explanation: 'Covers cards.' }),
			base,
		)
		expect(fee).toMatchObject({
			label: 'Online fee',
			explanation: 'Covers cards.',
		})
	})

	it('has no line for an order type it does not cover or a free order', () => {
		expect(serviceFeeFor(on(), { ...base, fulfillment: 'dine_in' })).toBeNull()
		expect(
			serviceFeeFor(on(), {
				...base,
				subtotalMinor: 1000,
				discountMinor: 1000,
			}),
		).toBeNull()
	})

	it('charges the fee tax on top only when prices exclude tax', () => {
		const fee = serviceFeeFor(on({ taxable: true }), {
			...base,
			taxRatePercent: 10,
		})!
		expect(fee).toMatchObject({ feeCents: 150, taxCents: 15 })
		expect(serviceFeeChargeMinor(fee, false)).toBe(165)
		expect(serviceFeeChargeMinor(fee, true)).toBe(150)
	})
})

describe('tipViewOf (a table tab)', () => {
	it('keeps the old 10, 15 and 20 buttons with none selected until saved', async () => {
		const { tipViewOf } = await import('./checkout-extras.ts')
		const view = tipViewOf(undefined, 'qrTab', 'USD')
		expect(view.choices).toEqual([
			{ percent: 10 },
			{ percent: 15 },
			{ percent: 20 },
		])
		expect(view.initial).toEqual({ kind: 'none' })
		expect(view.allowCustom).toBe(false)
	})

	it('shows a saved table choice and its default', async () => {
		const { tipViewOf } = await import('./checkout-extras.ts')
		const view = tipViewOf(
			{
				choices: [{ percent: 12 }, { amountMinor: 200 }],
				defaultIndex: 0,
				allowCustom: true,
			},
			'qrTab',
			'SAR',
		)
		expect(view.initial).toEqual({ kind: 'percent', percent: 12 })
		expect(view.allowCustom).toBe(true)
	})
})

describe('packagingFeeFor (#408)', () => {
	const on = (patch: Record<string, unknown> = {}): CheckoutOptions => ({
		packagingFee: {
			...defaultPackagingFeeSettings('USD'),
			enabled: true,
			...patch,
		} as never,
	})
	const base = {
		fulfillment: 'pickup' as const,
		itemUnits: 3,
		taxRatePercent: 0,
		taxInclusive: false,
		defaultLabel: 'Packaging fee (guest language)',
	}

	it('is none when the location has no fee', () => {
		expect(packagingFeeFor(null, base)).toBeNull()
		expect(packagingFeeFor({}, base)).toBeNull()
		expect(packagingFeeFor({ packagingFee: null }, base)).toBeNull()
		expect(packagingFeeFor(on({ enabled: false }), base)).toBeNull()
	})

	it('charges a takeaway order the fixed fee, under the default name in the guest language', () => {
		const fee = packagingFeeFor(on(), base)!
		expect(fee.feeCents).toBe(100)
		expect(fee.label).toBe('Packaging fee (guest language)')
	})

	it('shows the name the operator gave it', () => {
		expect(packagingFeeFor(on({ label: 'Bag fee' }), base)!.label).toBe(
			'Bag fee',
		)
	})

	it('never charges a table', () => {
		expect(
			packagingFeeFor(on(), { ...base, fulfillment: 'dine_in' }),
		).toBeNull()
	})

	it('follows the order types the operator chose', () => {
		const pickupOnly = on({ fulfillments: ['pickup'] })
		expect(packagingFeeFor(pickupOnly, base)).not.toBeNull()
		expect(
			packagingFeeFor(pickupOnly, { ...base, fulfillment: 'delivery' }),
		).toBeNull()
	})

	it('counts the dish units passed in when charging per item', () => {
		const perItem = on({ mode: 'per_item', amountMinor: 50 })
		expect(packagingFeeFor(perItem, base)!.feeCents).toBe(150)
		expect(packagingFeeFor(perItem, { ...base, itemUnits: 0 })).toBeNull()
	})

	it('adds the tax on top only when prices exclude tax', () => {
		const fee = packagingFeeFor(on({ taxable: true }), {
			...base,
			taxRatePercent: 10,
		})!
		expect(fee).toMatchObject({ feeCents: 100, taxCents: 10 })
		expect(packagingFeeChargeMinor(fee, false)).toBe(110)
		expect(packagingFeeChargeMinor(fee, true)).toBe(100)
	})
})

describe('utensilsView (#257)', () => {
	it('asks pickup and delivery only where the location asks, with its default', () => {
		const asks = (defaultRequested: boolean): CheckoutOptions => ({
			utensils: { enabled: true, defaultRequested },
		})
		expect(utensilsView(asks(false), 'pickup')).toEqual({
			defaultRequested: false,
		})
		expect(utensilsView(asks(true), 'delivery')).toEqual({
			defaultRequested: true,
		})
	})

	it('does not ask a table, or when the location does not ask', () => {
		expect(
			utensilsView(
				{ utensils: { enabled: true, defaultRequested: true } },
				'dine_in',
			),
		).toBeNull()
		expect(utensilsView({ utensils: null }, 'pickup')).toBeNull()
		expect(
			utensilsView(
				{ utensils: { enabled: false, defaultRequested: true } },
				'pickup',
			),
		).toBeNull()
		expect(utensilsView(null, 'pickup')).toBeNull()
		expect(utensilsView({}, 'delivery')).toBeNull()
	})
})

describe('pickupInstructionsFor (#251)', () => {
	const localized = JSON.stringify({
		en: 'Park in the side lot.',
		ar: 'اركن في الموقف الجانبي.',
	})

	it('reads the guest language and falls back to the default language', () => {
		const options: CheckoutOptions = { pickupInstructions: localized }
		expect(pickupInstructionsFor(options, 'ar', 'en')).toBe(
			'اركن في الموقف الجانبي.',
		)
		expect(pickupInstructionsFor(options, 'fr', 'en')).toBe(
			'Park in the side lot.',
		)
	})

	it('reads a plain text that was never translated', () => {
		expect(
			pickupInstructionsFor(
				{ pickupInstructions: 'Ask at the bar.' },
				'de',
				'en',
			),
		).toBe('Ask at the bar.')
	})

	it('keeps line breaks and does not touch markup (the page escapes it)', () => {
		const text = 'Line one\nLine <b>two</b>'
		expect(
			pickupInstructionsFor({ pickupInstructions: text }, 'en', 'en'),
		).toBe(text)
	})

	it('is none for empty text, a missing field and a delivery or table order', () => {
		expect(
			pickupInstructionsFor({ pickupInstructions: null }, 'en', 'en'),
		).toBeNull()
		expect(
			pickupInstructionsFor({ pickupInstructions: '  \n ' }, 'en', 'en'),
		).toBeNull()
		expect(pickupInstructionsFor({}, 'en', 'en')).toBeNull()
		expect(pickupInstructionsFor(null, 'en', 'en')).toBeNull()
		expect(
			pickupInstructionsFor(
				{ pickupInstructions: 'Hi' },
				'en',
				'en',
				'delivery',
			),
		).toBeNull()
		expect(
			pickupInstructionsFor(
				{ pickupInstructions: 'Hi' },
				'en',
				'en',
				'dine_in',
			),
		).toBeNull()
	})

	it('cuts text over the 300-character limit', () => {
		expect(
			pickupInstructionsFor(
				{ pickupInstructions: 'x'.repeat(500) },
				'en',
				'en',
			),
		).toHaveLength(300)
	})
})
