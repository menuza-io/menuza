/**
 * Guest service fee for online orders (#123): the settings an operator saves
 * on a location, the one pure function every channel prices the fee with, and
 * the reader the order region uses on the order context.
 *
 * Rules, in one place:
 * - Base: the subtotal after discounts and loyalty rewards, before tax and
 *   tip. A tip is never computed on the fee and the fee never on the tip.
 * - Fee = percentage of the base (basis points) + a fixed amount, capped
 *   after both are added. Below the small-order threshold a fixed small-order
 *   fee applies instead. A base of 0 (a free order) pays no fee.
 * - Tax on the fee follows `taxable`. With tax-inclusive prices the fee is a
 *   gross amount and the tax is the part already inside it; otherwise the tax
 *   is added on top. Either way the fee's tax is part of the order's tax.
 *
 * No I/O and no UI strings: Sites (display), tenant-api (quote, placement, tab
 * payment) and the App all import this file.
 */
import { z } from 'zod'

/** Bumped when the shape of `context.serviceFee` changes in a way a node must know. */
export const SERVICE_FEE_CONTRACT_VERSION = 1

export const SERVICE_FEE_FULFILLMENTS = [
	'pickup',
	'delivery',
	'dine_in',
] as const
export type ServiceFeeFulfillment = (typeof SERVICE_FEE_FULFILLMENTS)[number]

export const DEFAULT_SERVICE_FEE_LABEL = 'Service fee'
export const SERVICE_FEE_LABEL_MAX_LENGTH = 40
export const SERVICE_FEE_EXPLANATION_MAX_LENGTH = 200
/** Percentage at most 10 %, in basis points. */
export const SERVICE_FEE_MAX_PERCENT_BP = 1000

/**
 * The largest fixed amount (fixed fee, small-order fee, cap), in major units
 * per currency. An unknown currency uses `SERVICE_FEE_FALLBACK_MAX_MAJOR`.
 */
export const SERVICE_FEE_MAX_MAJOR: Readonly<Record<string, number>> = {
	USD: 25,
	CAD: 35,
	SAR: 100,
}
export const SERVICE_FEE_FALLBACK_MAX_MAJOR = 25

/** The largest fixed amount for a currency, in minor units. */
export function serviceFeeMaxMinor(currency: string): number {
	const major =
		SERVICE_FEE_MAX_MAJOR[currency.toUpperCase()] ??
		SERVICE_FEE_FALLBACK_MAX_MAJOR
	return Math.round(major * 100)
}

const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

export const serviceFeeSettingsSchema = z
	.strictObject({
		enabled: z.boolean(),
		/** Percentage of the base in basis points (300 = 3 %). */
		percentBp: z.number().int().min(0).max(SERVICE_FEE_MAX_PERCENT_BP),
		/** Fixed amount added to the percentage, minor units. */
		fixedMinor: minor,
		/** Most the fee can be per order, minor units; null is no cap. Never 0. */
		capMinor: minor.nullable(),
		/** A base below this pays `smallOrderFeeMinor` instead; null is off. */
		smallOrderBelowMinor: minor.nullable(),
		smallOrderFeeMinor: minor.nullable(),
		fulfillments: z.array(z.enum(SERVICE_FEE_FULFILLMENTS)).max(3),
		/** The name guests see. */
		label: z.string().trim().min(1).max(SERVICE_FEE_LABEL_MAX_LENGTH),
		/** Shown on tap. */
		explanation: z
			.string()
			.trim()
			.max(SERVICE_FEE_EXPLANATION_MAX_LENGTH)
			.nullable(),
		taxable: z.boolean(),
	})
	.superRefine((value, context) => {
		const issue = (path: string, message: string) =>
			context.addIssue({ code: 'custom', path: [path], message })
		if (value.capMinor === 0) issue('capMinor', 'A cap of 0 is not allowed')
		if ((value.smallOrderBelowMinor === null) !== (value.smallOrderFeeMinor === null)) {
			issue(
				'smallOrderFeeMinor',
				'Set both the small order limit and its fee, or neither',
			)
		}
		if (new Set(value.fulfillments).size !== value.fulfillments.length) {
			issue('fulfillments', 'Each order type once')
		}
		if (value.enabled) {
			if (value.fulfillments.length === 0) {
				issue('fulfillments', 'Choose at least one order type')
			}
			const charges =
				value.percentBp > 0 ||
				value.fixedMinor > 0 ||
				(value.smallOrderFeeMinor ?? 0) > 0
			if (!charges) issue('percentBp', 'The fee charges nothing')
		}
	})
export type ServiceFeeSettings = z.infer<typeof serviceFeeSettingsSchema>

/** The settings of a location with the fee never turned on. */
export function defaultServiceFeeSettings(
	currency: string,
): ServiceFeeSettings {
	return {
		enabled: false,
		percentBp: 300,
		fixedMinor: 0,
		capMinor: null,
		smallOrderBelowMinor: null,
		smallOrderFeeMinor: null,
		fulfillments: ['pickup', 'delivery'],
		label: DEFAULT_SERVICE_FEE_LABEL,
		explanation: null,
		// VAT applies to service charges in KSA.
		taxable: currency.toUpperCase() === 'SAR',
	}
}

/**
 * A fixed amount above the currency limit. Checked apart from the schema
 * because the limit depends on the location's currency.
 */
export function serviceFeeAmountsWithinLimit(
	settings: Pick<
		ServiceFeeSettings,
		'fixedMinor' | 'capMinor' | 'smallOrderFeeMinor' | 'smallOrderBelowMinor'
	>,
	currency: string,
): boolean {
	const max = serviceFeeMaxMinor(currency)
	return (
		settings.fixedMinor <= max &&
		(settings.capMinor ?? 0) <= max &&
		(settings.smallOrderFeeMinor ?? 0) <= max
	)
}

export type ServiceFeeInput = {
	settings: ServiceFeeSettings | null
	fulfillment: ServiceFeeFulfillment
	/** Subtotal after discounts and loyalty, before tax and tip, minor units. */
	baseCents: number
	taxRatePercent: number
	taxInclusive: boolean
}

export type ServiceFeeResult = {
	/** What the guest pays for the fee (tax-exclusive: before its tax). */
	feeCents: number
	/**
	 * Tax on the fee. Part of the order's tax: added to the total when prices
	 * exclude tax, already inside `feeCents` when they include it.
	 */
	taxCents: number
}

const NO_FEE: ServiceFeeResult = { feeCents: 0, taxCents: 0 }

/** Tax inside a tax-inclusive amount; the same rounding as an inclusive order. */
function includedTaxCents(grossCents: number, ratePercent: number): number {
	const rate = Math.max(0, Math.min(100, ratePercent || 0))
	if (!(rate > 0) || !(grossCents > 0)) return 0
	return Math.round((grossCents * rate) / (100 + rate))
}

/**
 * The service fee on one order, or none: the settings are off, do not cover
 * this order type, or the base is 0 or less. Pure and deterministic, so the
 * page, the quote and the placement agree to the cent.
 */
export function computeServiceFee(input: ServiceFeeInput): ServiceFeeResult {
	const { settings } = input
	if (!settings || !settings.enabled) return NO_FEE
	if (!settings.fulfillments.includes(input.fulfillment)) return NO_FEE
	const base = Math.trunc(input.baseCents)
	if (!Number.isFinite(base) || base <= 0) return NO_FEE
	let fee: number
	if (
		settings.smallOrderBelowMinor !== null &&
		settings.smallOrderFeeMinor !== null &&
		base < settings.smallOrderBelowMinor
	) {
		fee = settings.smallOrderFeeMinor
	} else {
		fee = Math.round((base * settings.percentBp) / 10_000) + settings.fixedMinor
	}
	if (settings.capMinor !== null) fee = Math.min(fee, settings.capMinor)
	fee = Math.max(0, fee)
	if (fee === 0) return NO_FEE
	if (!settings.taxable) return { feeCents: fee, taxCents: 0 }
	const taxCents = input.taxInclusive
		? includedTaxCents(fee, input.taxRatePercent)
		: Math.round((fee * Math.max(0, input.taxRatePercent || 0)) / 100)
	return { feeCents: fee, taxCents }
}

/** What the guest owes for the fee line: the tax is added when prices exclude it. */
export function serviceFeeChargeCents(
	result: ServiceFeeResult,
	taxInclusive: boolean,
): number {
	return result.feeCents + (taxInclusive ? 0 : result.taxCents)
}

// ---------------------------------------------------------------------------
// Order context: how the region learns a location's fee
// ---------------------------------------------------------------------------

/**
 * `context.serviceFee`, built by the App from the `ordering.service_fee` flag
 * and each location's settings: only locations that have the fee on. Read with
 * `readServiceFeePolicy`, never parsed inside the context schema, so a node
 * can tell "off" from "on but unreadable" and refuse the second.
 */
export const orderContextServiceFeeSchema = z.object({
	version: z.number().int().min(1),
	locations: z.record(z.string(), z.unknown()),
})

export type ServiceFeePolicy =
	| { kind: 'off' }
	| { kind: 'on'; settings: ServiceFeeSettings }
	/** The App says a fee is on but this node cannot read it: refuse, never drop it. */
	| { kind: 'unreadable' }

/**
 * The fee policy of one location. A missing field, or a location not listed,
 * is off (the flag is off or the App predates the fee). A listed location whose
 * settings do not parse, or a payload newer than this node knows, is
 * `unreadable`: the order is refused rather than placed without its fee.
 */
export function readServiceFeePolicy(
	raw: unknown,
	locationId: string,
): ServiceFeePolicy {
	if (raw === undefined || raw === null) return { kind: 'off' }
	const envelope = orderContextServiceFeeSchema.safeParse(raw)
	if (!envelope.success) return { kind: 'unreadable' }
	const entry = envelope.data.locations[locationId]
	if (entry === undefined || entry === null) {
		// A newer payload may key locations differently: not knowing the
		// version while any location is listed is a refusal, not a free pass.
		return envelope.data.version > SERVICE_FEE_CONTRACT_VERSION &&
			Object.keys(envelope.data.locations).length > 0
			? { kind: 'unreadable' }
			: { kind: 'off' }
	}
	if (envelope.data.version > SERVICE_FEE_CONTRACT_VERSION) {
		return { kind: 'unreadable' }
	}
	const settings = serviceFeeSettingsSchema.safeParse(entry)
	if (!settings.success) return { kind: 'unreadable' }
	return settings.data.enabled
		? { kind: 'on', settings: settings.data }
		: { kind: 'off' }
}

/** The 409 when the amount the page showed is not the amount priced now. */
export const SERVICE_FEE_CHANGED_CODE = 'service_fee_changed'
export const INVALID_SERVICE_FEE_CODE = 'invalid_service_fee'
/** 503: the node cannot read the location's fee, so it takes no orders there. */
export const SERVICE_FEE_UNAVAILABLE_CODE = 'service_fee_unavailable'
