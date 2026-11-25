import { describe, expect, it } from 'vitest'

import {
	deliveryFeeCentsFor,
	deliveryFeeFor,
	deliveryFeeFromPricing,
	deliveryFeeProgress,
	deliveryPricingFor,
	deliveryProgressFromPricing,
	distanceBandRanges,
	distanceFeeCents,
	distanceForZone,
	validateDistanceBands,
	validateFeeSteps,
	type DeliveryFeeZone,
} from './delivery-fees.ts'

// Under 20: 5.00; from 20: 3.00; from 40: free. Minimum order 10.
const stepped: DeliveryFeeZone = {
	deliveryFee: 5,
	minimumOrder: 10,
	feeSteps: [
		{ from: 40, fee: 0 },
		{ from: 10, fee: 5 },
		{ from: 20, fee: 3 },
	],
}

// 0-3 km 3.00, 3-5 km 4.00, 5-8 km 5.00, 8+ km 7.00.
const banded: DeliveryFeeZone = {
	deliveryFee: 9,
	minimumOrder: 0,
	distanceFees: {
		mode: 'driving',
		unit: 'km',
		bands: [
			{ from: 0, fee: 3 },
			{ from: 3, fee: 4 },
			{ from: 5, fee: 5 },
			{ from: 8, fee: 7 },
		],
	},
}

describe('fee by order size (#244)', () => {
	it('charges the step the subtotal has reached, in any input order', () => {
		expect(deliveryFeeFor(stepped, 10)).toBe(5)
		expect(deliveryFeeFor(stepped, 19.99)).toBe(5)
		expect(deliveryFeeFor(stepped, 20)).toBe(3)
		expect(deliveryFeeFor(stepped, 39.99)).toBe(3)
		expect(deliveryFeeFor(stepped, 40)).toBe(0)
	})

	it('gives free delivery above the last step', () => {
		expect(deliveryFeeFor(stepped, 500)).toBe(0)
		expect(deliveryFeeCentsFor(stepped, 100_000)).toBe(0)
	})

	it('keeps the single fee without steps, and uses the first step below it', () => {
		expect(deliveryFeeFor({ deliveryFee: 3.99, minimumOrder: 0 }, 80)).toBe(3.99)
		expect(deliveryFeeFor({ deliveryFee: 3.99, minimumOrder: 0, feeSteps: [] }, 80)).toBe(3.99)
		expect(deliveryFeeFor(stepped, 4)).toBe(5)
	})

	it('shows how much more unlocks the next cheaper step', () => {
		expect(deliveryFeeProgress(stepped, 1400)).toEqual({
			feeCents: 500,
			next: { fromCents: 2000, feeCents: 300, remainingCents: 600 },
		})
		expect(deliveryFeeProgress(stepped, 3400).next).toEqual({
			fromCents: 4000,
			feeCents: 0,
			remainingCents: 600,
		})
		expect(deliveryFeeProgress(stepped, 4000)).toEqual({
			feeCents: 0,
			next: null,
		})
	})

	it('skips a later step that does not lower the fee', () => {
		const flat: DeliveryFeeZone = {
			deliveryFee: 4,
			minimumOrder: 0,
			feeSteps: [
				{ from: 0, fee: 4 },
				{ from: 10, fee: 4 },
				{ from: 30, fee: 1 },
			],
		}
		expect(deliveryFeeProgress(flat, 500).next).toEqual({
			fromCents: 3000,
			feeCents: 100,
			remainingCents: 2500,
		})
	})

	it('validates the table: distinct thresholds, the first at the minimum', () => {
		expect(validateFeeSteps(stepped.feeSteps, 10)).toBeNull()
		expect(validateFeeSteps(undefined, 10)).toBeNull()
		expect(
			validateFeeSteps(
				[
					{ from: 10, fee: 5 },
					{ from: 10, fee: 3 },
				],
				10,
			),
		).toBe('steps_not_distinct')
		expect(validateFeeSteps([{ from: 12, fee: 5 }], 10)).toBe(
			'steps_first_not_minimum',
		)
		expect(
			validateFeeSteps(
				Array.from({ length: 11 }, (_, i) => ({ from: i, fee: 1 })),
				0,
			),
		).toBe('steps_too_many')
	})
})

describe('fee by distance (#421)', () => {
	it('puts a road distance of 6 km in the 5-8 km band', () => {
		const distance = distanceForZone(banded, {
			straightMeters: 4_400,
			drivingMeters: 6_000,
		})
		expect(distance).toEqual({ meters: 6_000, source: 'driving' })
		expect(distanceFeeCents(banded, distance!.meters)).toBe(500)
	})

	it('measures a band boundary inclusively on the lower edge', () => {
		expect(distanceFeeCents(banded, 4_999)).toBe(400)
		expect(distanceFeeCents(banded, 5_000)).toBe(500)
		expect(distanceFeeCents(banded, 8_000)).toBe(700)
		expect(distanceFeeCents(banded, 40_000)).toBe(700)
	})

	it('falls back to the straight-line distance when routing gave nothing', () => {
		const distance = distanceForZone(banded, {
			straightMeters: 4_400,
			drivingMeters: null,
		})
		expect(distance).toEqual({ meters: 4_400, source: 'straight_line' })
		expect(distanceFeeCents(banded, distance!.meters)).toBe(400)
	})

	it('ignores a road distance on a zone that measures in a straight line', () => {
		const straight: DeliveryFeeZone = {
			...banded,
			distanceFees: { ...banded.distanceFees!, mode: 'straight_line' },
		}
		expect(
			distanceForZone(straight, { straightMeters: 2_000, drivingMeters: 9_000 }),
		).toEqual({ meters: 2_000, source: 'straight_line' })
	})

	it('uses the zone fee when the distance is unknown or there are no bands', () => {
		expect(distanceFeeCents(banded, null)).toBe(900)
		expect(distanceFeeCents({ deliveryFee: 2.5, minimumOrder: 0 }, 9_000)).toBe(250)
		expect(distanceForZone(banded, {})).toBeNull()
	})

	it('measures miles', () => {
		const miles: DeliveryFeeZone = {
			deliveryFee: 9,
			minimumOrder: 0,
			distanceFees: {
				mode: 'straight_line',
				unit: 'miles',
				bands: [
					{ from: 0, fee: 2 },
					{ from: 2, fee: 6 },
				],
			},
		}
		expect(distanceFeeCents(miles, 3_000)).toBe(200) // 1.86 mi
		expect(distanceFeeCents(miles, 3_300)).toBe(600) // 2.05 mi
	})

	it('validates the bands and lists them as ranges', () => {
		expect(validateDistanceBands(banded.distanceFees)).toBeNull()
		expect(
			validateDistanceBands({ ...banded.distanceFees!, bands: [{ from: 1, fee: 1 }] }),
		).toBe('bands_first_not_zero')
		expect(
			validateDistanceBands({
				...banded.distanceFees!,
				bands: [
					{ from: 0, fee: 1 },
					{ from: 0, fee: 2 },
				],
			}),
		).toBe('bands_not_distinct')
		expect(distanceBandRanges(banded.distanceFees!)).toEqual([
			{ from: 0, to: 3, fee: 3 },
			{ from: 3, to: 5, fee: 4 },
			{ from: 5, to: 8, fee: 5 },
			{ from: 8, to: null, fee: 7 },
		])
	})
})

describe('distance and order size together', () => {
	const both: DeliveryFeeZone = {
		...banded,
		minimumOrder: 10,
		// Order size may only lower the distance fee.
		feeSteps: [
			{ from: 10, fee: 6 },
			{ from: 20, fee: 4 },
			{ from: 40, fee: 0 },
		],
	}

	it('takes the lower of the distance fee and the order-size fee', () => {
		// 6 km: distance fee 5.00.
		expect(deliveryFeeCentsFor(both, 1500, 6_000)).toBe(500) // step 6.00 > 5.00
		expect(deliveryFeeCentsFor(both, 2500, 6_000)).toBe(400) // step 4.00 < 5.00
		expect(deliveryFeeCentsFor(both, 4500, 6_000)).toBe(0)
		// 2 km: distance fee 3.00, so 6.00 and 4.00 steps never raise it.
		expect(deliveryFeeCentsFor(both, 1500, 2_000)).toBe(300)
		expect(deliveryFeeCentsFor(both, 2500, 2_000)).toBe(300)
		expect(deliveryFeeCentsFor(both, 4500, 2_000)).toBe(0)
	})

	it('reports the next step against the combined fee', () => {
		expect(deliveryFeeProgress(both, 1500, 6_000).next).toEqual({
			fromCents: 2000,
			feeCents: 400,
			remainingCents: 500,
		})
		// At 2 km the 20.00 step would not lower 3.00, only the free one does.
		expect(deliveryFeeProgress(both, 1500, 2_000).next).toEqual({
			fromCents: 4000,
			feeCents: 0,
			remainingCents: 2500,
		})
	})

	it('gives a client the same fee from the pricing a quote carries', () => {
		const pricing = deliveryPricingFor(both, 6_000)
		expect(pricing).toEqual({
			baseFee: 5,
			steps: [
				{ from: 10, fee: 6 },
				{ from: 20, fee: 4 },
				{ from: 40, fee: 0 },
			],
			byDistance: true,
		})
		for (const subtotal of [10, 15, 19.99, 20, 35, 40, 120]) {
			expect(deliveryFeeFromPricing(pricing, subtotal)).toBe(
				deliveryFeeFor(both, subtotal, 6_000),
			)
		}
		expect(deliveryProgressFromPricing(pricing, 15).next?.remainingCents).toBe(500)
		const stepsOnly = deliveryPricingFor(stepped, null)
		expect(stepsOnly.byDistance).toBe(false)
		for (const subtotal of [10, 25, 45]) {
			expect(deliveryFeeFromPricing(stepsOnly, subtotal)).toBe(
				deliveryFeeFor(stepped, subtotal),
			)
		}
	})
})
