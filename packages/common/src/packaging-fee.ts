/**
 * Packaging / bag fee (#408): fixed per order or per item, per fulfillment type.
 * Mirrors the service-fee storage shape and order columns.
 */
import { z } from 'zod'

export const PACKAGING_FEE_CONTRACT_VERSION = 1
export const DEFAULT_PACKAGING_FEE_LABEL = 'Packaging fee'
export const PACKAGING_FEE_LABEL_MAX_LENGTH = 40

export const PACKAGING_FEE_FULFILLMENTS = ['pickup', 'delivery'] as const
export type PackagingFeeFulfillment =
	(typeof PACKAGING_FEE_FULFILLMENTS)[number]

const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

export const packagingFeeModeSchema = z.enum(['per_order', 'per_item'])
export type PackagingFeeMode = z.infer<typeof packagingFeeModeSchema>

export const packagingFeeSettingsSchema = z
	.strictObject({
		enabled: z.boolean(),
		mode: packagingFeeModeSchema,
		/** Amount per order or per dish unit, minor units. */
		amountMinor: minor,
		fulfillments: z.array(z.enum(PACKAGING_FEE_FULFILLMENTS)).max(2),
		label: z.string().trim().min(1).max(PACKAGING_FEE_LABEL_MAX_LENGTH),
		taxable: z.boolean(),
	})
	.superRefine((value, ctx) => {
		if (value.enabled) {
			if (value.fulfillments.length === 0) {
				ctx.addIssue({
					code: 'custom',
					path: ['fulfillments'],
					message: 'Choose at least one order type',
				})
			}
			if (value.amountMinor <= 0) {
				ctx.addIssue({
					code: 'custom',
					path: ['amountMinor'],
					message: 'Enter a fee amount',
				})
			}
		}
	})

export type PackagingFeeSettings = z.infer<typeof packagingFeeSettingsSchema>

export function defaultPackagingFeeSettings(
	currency: string,
): PackagingFeeSettings {
	return {
		enabled: false,
		mode: 'per_order',
		amountMinor: 100,
		fulfillments: ['pickup', 'delivery'],
		label: DEFAULT_PACKAGING_FEE_LABEL,
		taxable: currency.toUpperCase() === 'SAR',
	}
}

export type PackagingFeeInput = {
	settings: PackagingFeeSettings | null
	fulfillment: PackagingFeeFulfillment | 'dine_in'
	/** Dish units after exemptions, for per-item mode. */
	itemUnits: number
	taxRatePercent: number
	taxInclusive: boolean
}

export type PackagingFeeResult = { feeCents: number; taxCents: number }

const NO_FEE: PackagingFeeResult = { feeCents: 0, taxCents: 0 }

function includedTaxCents(grossCents: number, ratePercent: number): number {
	const rate = Math.max(0, Math.min(100, ratePercent || 0))
	if (!(rate > 0) || !(grossCents > 0)) return 0
	return Math.round((grossCents * rate) / (100 + rate))
}

export function computePackagingFee(
	input: PackagingFeeInput,
): PackagingFeeResult {
	const { settings } = input
	if (!settings?.enabled) return NO_FEE
	if (input.fulfillment === 'dine_in') return NO_FEE
	if (!settings.fulfillments.includes(input.fulfillment)) return NO_FEE
	const units =
		settings.mode === 'per_item' ? Math.max(0, Math.trunc(input.itemUnits)) : 1
	if (units <= 0) return NO_FEE
	const fee = settings.amountMinor * units
	if (fee <= 0) return NO_FEE
	if (!settings.taxable) return { feeCents: fee, taxCents: 0 }
	const taxCents = input.taxInclusive
		? includedTaxCents(fee, input.taxRatePercent)
		: Math.round((fee * Math.max(0, input.taxRatePercent || 0)) / 100)
	return { feeCents: fee, taxCents }
}

export const orderContextPackagingFeeSchema = z.object({
	version: z.number().int().min(1),
	locations: z.record(z.string(), z.unknown()),
})

export type PackagingFeePolicy =
	| { kind: 'off' }
	| { kind: 'on'; settings: PackagingFeeSettings }
	| { kind: 'unreadable' }

export function readPackagingFeePolicy(
	raw: unknown,
	locationId: string,
): PackagingFeePolicy {
	if (raw === undefined || raw === null) return { kind: 'off' }
	const envelope = orderContextPackagingFeeSchema.safeParse(raw)
	if (!envelope.success) return { kind: 'unreadable' }
	const entry = envelope.data.locations[locationId]
	if (entry === undefined || entry === null) return { kind: 'off' }
	if (envelope.data.version > PACKAGING_FEE_CONTRACT_VERSION) {
		return { kind: 'unreadable' }
	}
	const settings = packagingFeeSettingsSchema.safeParse(entry)
	if (!settings.success) return { kind: 'unreadable' }
	return settings.data.enabled
		? { kind: 'on', settings: settings.data }
		: { kind: 'off' }
}

export const PACKAGING_FEE_CHANGED_CODE = 'packaging_fee_changed'
export const PACKAGING_FEE_UNAVAILABLE_CODE = 'packaging_fee_unavailable'
