import { describe, expect, it } from 'vitest'
import {
	ORDER_CAP_AMOUNT_ERROR,
	ORDER_CAP_GUESTS_ERROR,
	orderCapsFormFromRecord,
	packagingFeeFormFromRecord,
	parseCheckoutRulesFields,
	PICKUP_DEFAULT_LANGUAGE_ERROR,
	pickupInstructionsFromRecord,
} from './checkout-rules-settings.ts'

const options = {
	currency: 'SAR',
	defaultLocale: 'en',
	packagingFeeEnabled: true,
}

function rules(bundle: Record<string, unknown>) {
	return {
		checkoutRules: JSON.stringify({
			pickupInstructions: {},
			orderCaps: {
				pickupMaxSubtotal: '',
				deliveryMaxSubtotal: '',
				dineInMaxGuests: '',
			},
			packagingFee: packagingFeeFormFromRecord(null, 'SAR'),
			...bundle,
		}),
	}
}

function patchOf(bundle: Record<string, unknown>, opts = options) {
	const result = parseCheckoutRulesFields(rules(bundle), opts)
	if (!result.ok) throw new Error(result.error)
	return result.patch
}

function errorOf(bundle: Record<string, unknown>, opts = options) {
	const result = parseCheckoutRulesFields(rules(bundle), opts)
	return result.ok ? null : result.error
}

describe('order size caps (#422)', () => {
	it('saves an amount per order type and a guest limit for tables only', () => {
		const patch = patchOf({
			orderCaps: {
				pickupMaxSubtotal: '250',
				deliveryMaxSubtotal: '400.50',
				dineInMaxGuests: '12',
			},
		})
		expect(JSON.parse(patch.orderCaps!)).toEqual({
			pickup: { maxSubtotalMinor: 25_000 },
			delivery: { maxSubtotalMinor: 40_050 },
			dineIn: { maxGuests: 12 },
		})
	})

	it('puts no guest limit on pickup, which has no head count', () => {
		const patch = patchOf({
			orderCaps: {
				pickupMaxSubtotal: '',
				deliveryMaxSubtotal: '',
				dineInMaxGuests: '6',
			},
		})
		expect(JSON.parse(patch.orderCaps!)).toEqual({ dineIn: { maxGuests: 6 } })
	})

	it('saves nothing (no cap) when every field is empty', () => {
		expect(patchOf({}).orderCaps).toBeNull()
	})

	it('refuses an amount it cannot read instead of reading it as no cap', () => {
		for (const bad of ['abc', '0', '-5', '1.234', '1,5']) {
			expect(
				errorOf({
					orderCaps: {
						pickupMaxSubtotal: bad,
						deliveryMaxSubtotal: '',
						dineInMaxGuests: '',
					},
				}),
			).toBe(ORDER_CAP_AMOUNT_ERROR)
		}
	})

	it('refuses a guest limit it cannot read instead of reading it as no cap', () => {
		for (const bad of ['many', '0', '2.5', '501']) {
			expect(
				errorOf({
					orderCaps: {
						pickupMaxSubtotal: '',
						deliveryMaxSubtotal: '',
						dineInMaxGuests: bad,
					},
				}),
			).toBe(ORDER_CAP_GUESTS_ERROR)
		}
	})

	it('reads Arabic digits', () => {
		const patch = patchOf({
			orderCaps: {
				pickupMaxSubtotal: '٢٥٠',
				deliveryMaxSubtotal: '',
				dineInMaxGuests: '',
			},
		})
		expect((JSON.parse(patch.orderCaps!) as any).pickup.maxSubtotalMinor).toBe(
			25_000,
		)
	})

	it('shows a stored cap, and an unreadable stored one as empty rather than failing the page', () => {
		expect(
			orderCapsFormFromRecord(
				JSON.stringify({
					pickup: { maxSubtotalMinor: 25_000 },
					dineIn: { maxGuests: 8 },
				}),
			),
		).toEqual({
			pickupMaxSubtotal: '250.00',
			deliveryMaxSubtotal: '',
			dineInMaxGuests: '8',
		})
		expect(orderCapsFormFromRecord('{not json')).toEqual({
			pickupMaxSubtotal: '',
			deliveryMaxSubtotal: '',
			dineInMaxGuests: '',
		})
		expect(() => packagingFeeFormFromRecord('{not json', 'SAR')).not.toThrow()
	})
})

describe('pickup instructions (#251)', () => {
	it('saves text per language and keeps it at 300 characters', () => {
		const patch = patchOf({
			pickupInstructions: { en: `${'x'.repeat(400)}`, ar: 'اركن في الجانب' },
		})
		const saved = JSON.parse(patch.pickupInstructions!) as Record<
			string,
			string
		>
		expect(saved.en).toHaveLength(300)
		expect(saved.ar).toBe('اركن في الجانب')
	})

	it('saves nothing when every language is empty', () => {
		expect(
			patchOf({ pickupInstructions: { en: '  ', ar: '' } }).pickupInstructions,
		).toBeNull()
	})

	it('needs the default language when another language has text', () => {
		expect(errorOf({ pickupInstructions: { ar: 'اركن في الجانب' } })).toBe(
			PICKUP_DEFAULT_LANGUAGE_ERROR,
		)
		expect(
			errorOf(
				{ pickupInstructions: { ar: 'اركن في الجانب' } },
				{ ...options, defaultLocale: 'ar' },
			),
		).toBeNull()
	})

	it('reads a stored value back, empty or unreadable as no text', () => {
		expect(pickupInstructionsFromRecord(null, 'en')).toEqual({})
		expect(pickupInstructionsFromRecord('   ', 'en')).toEqual({})
		expect(
			pickupInstructionsFromRecord(JSON.stringify({ en: 'Side door' }), 'en'),
		).toEqual({ en: 'Side door' })
	})
})

describe('packaging fee (#408)', () => {
	const fee = (patch: Record<string, unknown> = {}) => ({
		...packagingFeeFormFromRecord(null, 'SAR'),
		enabled: true,
		amount: '1.00',
		...patch,
	})

	it('saves the fee when the feature is on, in minor units', () => {
		const patch = patchOf({ packagingFee: fee({ mode: 'per_item' }) })
		expect(JSON.parse(patch.packagingFee!)).toMatchObject({
			enabled: true,
			mode: 'per_item',
			amountMinor: 100,
		})
	})

	it('leaves the stored fee alone while the feature is off', () => {
		const patch = patchOf(
			{ packagingFee: fee() },
			{ ...options, packagingFeeEnabled: false },
		)
		expect('packagingFee' in patch).toBe(false)
	})

	it('refuses a fee with no amount, or with no order type', () => {
		expect(errorOf({ packagingFee: fee({ amount: '' }) })).toMatch(/amount/i)
		expect(
			errorOf({ packagingFee: fee({ pickup: false, delivery: false }) }),
		).not.toBeNull()
	})

	it('never charges dine-in: only pickup and delivery can be chosen', () => {
		const patch = patchOf({ packagingFee: fee() })
		expect((JSON.parse(patch.packagingFee!) as any).fulfillments).toEqual([
			'pickup',
			'delivery',
		])
	})
})
