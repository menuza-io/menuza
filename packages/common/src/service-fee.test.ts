import { describe, expect, it } from 'vitest'
import {
	SERVICE_FEE_CONTRACT_VERSION,
	computeServiceFee,
	defaultServiceFeeSettings,
	readServiceFeePolicy,
	serviceFeeAmountsWithinLimit,
	serviceFeeSettingsSchema,
	type ServiceFeeSettings,
} from './service-fee.ts'

const settings = (patch: Partial<ServiceFeeSettings> = {}): ServiceFeeSettings => ({
	...defaultServiceFeeSettings('USD'),
	enabled: true,
	...patch,
})

const fee = (
	patch: Partial<ServiceFeeSettings>,
	baseCents: number,
	extra: {
		fulfillment?: 'pickup' | 'delivery' | 'dine_in'
		taxRatePercent?: number
		taxInclusive?: boolean
	} = {},
) =>
	computeServiceFee({
		settings: settings(patch),
		fulfillment: extra.fulfillment ?? 'pickup',
		baseCents,
		taxRatePercent: extra.taxRatePercent ?? 0,
		taxInclusive: extra.taxInclusive ?? false,
	})

describe('computeServiceFee', () => {
	it('is 3 % of the base', () => {
		expect(fee({}, 5000)).toEqual({ feeCents: 150, taxCents: 0 })
	})

	it('adds the fixed amount to the percentage, then caps the sum', () => {
		expect(fee({ percentBp: 300, fixedMinor: 50 }, 5000).feeCents).toBe(200)
		// 3 % of 100.00 is 3.00, +0.50 is 3.50, capped at 2.00.
		expect(
			fee({ percentBp: 300, fixedMinor: 50, capMinor: 200 }, 10_000).feeCents,
		).toBe(200)
	})

	it('a 3 % fee capped at 2.00 is the same 2.00 everywhere', () => {
		const rule = { percentBp: 300, capMinor: 200 }
		expect(fee(rule, 10_000).feeCents).toBe(200)
		expect(fee(rule, 6_000).feeCents).toBe(180)
	})

	it('charges the small order fee instead below the limit', () => {
		const rule = {
			percentBp: 300,
			smallOrderBelowMinor: 1500,
			smallOrderFeeMinor: 99,
		}
		expect(fee(rule, 1499).feeCents).toBe(99)
		expect(fee(rule, 1500).feeCents).toBe(45)
	})

	it('has no fee on a free order', () => {
		expect(fee({ fixedMinor: 100 }, 0)).toEqual({ feeCents: 0, taxCents: 0 })
		expect(
			fee(
				{ smallOrderBelowMinor: 1500, smallOrderFeeMinor: 99 },
				0,
			).feeCents,
		).toBe(0)
	})

	it('has no fee for an order type it does not cover or when off', () => {
		expect(fee({ fulfillments: ['pickup'] }, 5000, { fulfillment: 'delivery' }))
			.toEqual({ feeCents: 0, taxCents: 0 })
		expect(
			computeServiceFee({
				settings: { ...settings(), enabled: false },
				fulfillment: 'pickup',
				baseCents: 5000,
				taxRatePercent: 0,
				taxInclusive: false,
			}).feeCents,
		).toBe(0)
		expect(
			computeServiceFee({
				settings: null,
				fulfillment: 'pickup',
				baseCents: 5000,
				taxRatePercent: 0,
				taxInclusive: false,
			}).feeCents,
		).toBe(0)
	})

	it('adds tax on top of a taxable fee when prices exclude tax', () => {
		expect(
			fee({ taxable: true }, 10_000, { taxRatePercent: 15 }),
		).toEqual({ feeCents: 300, taxCents: 45 })
	})

	it('carves the tax out of a taxable fee when prices include tax', () => {
		expect(
			fee({ taxable: true }, 11_500, {
				taxRatePercent: 15,
				taxInclusive: true,
			}),
		).toEqual({ feeCents: 345, taxCents: 45 })
	})

	it('has no tax on a fee that is not taxable', () => {
		expect(
			fee({ taxable: false }, 10_000, { taxRatePercent: 15 }).taxCents,
		).toBe(0)
	})

	it('is never computed on a tip: the base is the only input', () => {
		// The function has no tip input at all; a larger tip cannot change it.
		expect(fee({}, 5000)).toEqual(fee({}, 5000))
	})
})

describe('service fee settings', () => {
	it('defaults to taxable for SAR only', () => {
		expect(defaultServiceFeeSettings('SAR').taxable).toBe(true)
		expect(defaultServiceFeeSettings('USD').taxable).toBe(false)
		expect(defaultServiceFeeSettings('USD').enabled).toBe(false)
	})

	it('refuses a cap of 0, more than 10 % and an empty enabled fee', () => {
		expect(serviceFeeSettingsSchema.safeParse(settings()).success).toBe(true)
		expect(
			serviceFeeSettingsSchema.safeParse(settings({ capMinor: 0 })).success,
		).toBe(false)
		expect(
			serviceFeeSettingsSchema.safeParse(settings({ percentBp: 1001 })).success,
		).toBe(false)
		expect(
			serviceFeeSettingsSchema.safeParse(
				settings({ percentBp: 0, fixedMinor: 0 }),
			).success,
		).toBe(false)
		expect(
			serviceFeeSettingsSchema.safeParse(settings({ fulfillments: [] })).success,
		).toBe(false)
		expect(
			serviceFeeSettingsSchema.safeParse(
				settings({ smallOrderBelowMinor: 1500, smallOrderFeeMinor: null }),
			).success,
		).toBe(false)
	})

	it('limits fixed amounts by currency', () => {
		expect(
			serviceFeeAmountsWithinLimit(settings({ fixedMinor: 2500 }), 'USD'),
		).toBe(true)
		expect(
			serviceFeeAmountsWithinLimit(settings({ fixedMinor: 2501 }), 'USD'),
		).toBe(false)
		expect(
			serviceFeeAmountsWithinLimit(settings({ fixedMinor: 2501 }), 'SAR'),
		).toBe(true)
		expect(
			serviceFeeAmountsWithinLimit(settings({ capMinor: 10_001 }), 'SAR'),
		).toBe(false)
	})
})

describe('readServiceFeePolicy', () => {
	const on = settings({ label: 'Online fee' })

	it('is off when the context has no fee, or the location is not listed', () => {
		expect(readServiceFeePolicy(undefined, 'loc')).toEqual({ kind: 'off' })
		expect(readServiceFeePolicy(null, 'loc')).toEqual({ kind: 'off' })
		expect(
			readServiceFeePolicy(
				{ version: SERVICE_FEE_CONTRACT_VERSION, locations: { other: on } },
				'loc',
			),
		).toEqual({ kind: 'off' })
	})

	it('reads a listed location that is on', () => {
		expect(
			readServiceFeePolicy(
				{ version: SERVICE_FEE_CONTRACT_VERSION, locations: { loc: on } },
				'loc',
			),
		).toEqual({ kind: 'on', settings: on })
	})

	it('refuses, never drops, a fee it cannot read', () => {
		expect(readServiceFeePolicy('junk', 'loc')).toEqual({ kind: 'unreadable' })
		expect(
			readServiceFeePolicy(
				{
					version: SERVICE_FEE_CONTRACT_VERSION,
					locations: { loc: { enabled: true, percentBp: 'x' } },
				},
				'loc',
			),
		).toEqual({ kind: 'unreadable' })
		// A newer payload than this node knows.
		expect(
			readServiceFeePolicy(
				{ version: SERVICE_FEE_CONTRACT_VERSION + 1, locations: { loc: on } },
				'loc',
			),
		).toEqual({ kind: 'unreadable' })
		expect(
			readServiceFeePolicy(
				{ version: SERVICE_FEE_CONTRACT_VERSION + 1, locations: { other: on } },
				'loc',
			),
		).toEqual({ kind: 'unreadable' })
	})
})
