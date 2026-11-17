/**
 * Pickup instructions (#251), order caps (#422) and packaging fee (#408) on the
 * location form. Posted as JSON in `checkoutRules`; utensils live in online
 * ordering settings (see ordering-settings.ts).
 */
import {
	orderCapsSettingsSchema,
	type OrderCapsSettings,
} from '@repo/common/order-caps'
import {
	packagingFeeSettingsSchema,
	defaultPackagingFeeSettings,
	type PackagingFeeSettings,
} from '@repo/common/packaging-fee'
import {
	PICKUP_INSTRUCTIONS_MAX_LENGTH,
	pickupInstructionsSchema,
	serializePickupInstructions,
} from '@repo/common/pickup-instructions'
import {
	parseLocalizedString,
	type LocalizedString,
} from '@repo/common/site-locales'
import {
	minorToMajorText,
	parseMoneyToMinor,
	parseWholeNumber,
} from '#app/utils/money-input.ts'

export type PickupInstructionsForm = LocalizedString

export type OrderCapsFormValues = {
	pickupMaxSubtotal: string
	deliveryMaxSubtotal: string
	dineInMaxGuests: string
}

export type PackagingFeeFormValues = {
	enabled: boolean
	mode: 'per_order' | 'per_item'
	amount: string
	pickup: boolean
	delivery: boolean
	label: string
	taxable: boolean
}

export type CheckoutRulesPatch = {
	pickupInstructions?: string | null
	orderCaps?: string | null
	packagingFee?: string | null
}

export function pickupInstructionsFromRecord(
	raw: string | null | undefined,
	defaultLocale: string,
): PickupInstructionsForm {
	if (!raw?.trim()) return {}
	try {
		return parseLocalizedString(raw, defaultLocale)
	} catch {
		return {}
	}
}

/** A stored JSON column as a value; unreadable text reads as nothing. */
function readJson(raw: unknown): unknown {
	if (typeof raw !== 'string') return raw
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}

export function orderCapsFormFromRecord(raw: unknown): OrderCapsFormValues {
	const parsed = orderCapsSettingsSchema.safeParse(readJson(raw))
	if (!parsed.success) {
		return {
			pickupMaxSubtotal: '',
			deliveryMaxSubtotal: '',
			dineInMaxGuests: '',
		}
	}
	const { pickup, delivery, dineIn } = parsed.data
	const major = (minor: number | null | undefined) =>
		minor == null ? '' : (minor / 100).toFixed(2)
	return {
		pickupMaxSubtotal: major(pickup?.maxSubtotalMinor),
		deliveryMaxSubtotal: major(delivery?.maxSubtotalMinor),
		dineInMaxGuests: dineIn?.maxGuests == null ? '' : String(dineIn.maxGuests),
	}
}

export function packagingFeeFormFromRecord(
	raw: unknown,
	currency: string,
): PackagingFeeFormValues {
	const parsed = packagingFeeSettingsSchema.safeParse(readJson(raw))
	const base = parsed.success
		? parsed.data
		: defaultPackagingFeeSettings(currency)
	return {
		enabled: base.enabled,
		mode: base.mode,
		amount: minorToMajorText(base.amountMinor, currency),
		pickup: base.fulfillments.includes('pickup'),
		delivery: base.fulfillments.includes('delivery'),
		label: base.label,
		taxable: base.taxable,
	}
}

/** The largest order cap the region accepts, in minor units. */
const MAX_CAP_MINOR = 10_000_000

export const ORDER_CAP_AMOUNT_ERROR =
	'Enter the largest order as an amount like 250 or 250.50, or leave it empty.'
export const ORDER_CAP_GUESTS_ERROR =
	'Enter the most guests as a whole number from 1 to 500, or leave it empty.'

function capsFromForm(values: OrderCapsFormValues, currency: string) {
	const amount = (text: string) =>
		text.trim()
			? parseMoneyToMinor(text, { currency, min: 1, max: MAX_CAP_MINOR })
			: undefined
	const pickupMinor = amount(values.pickupMaxSubtotal)
	const deliveryMinor = amount(values.deliveryMaxSubtotal)
	const guestsText = values.dineInMaxGuests.trim()
	const guests = guestsText
		? parseWholeNumber(guestsText, { min: 1, max: 500 })
		: undefined
	// Typed but unreadable is refused: it must never read as "no cap".
	if (pickupMinor === null || deliveryMinor === null) {
		return { ok: false as const, error: ORDER_CAP_AMOUNT_ERROR }
	}
	if (guests === null) {
		return { ok: false as const, error: ORDER_CAP_GUESTS_ERROR }
	}
	const settings: OrderCapsSettings = {}
	if (pickupMinor !== undefined) {
		settings.pickup = { maxSubtotalMinor: pickupMinor }
	}
	if (deliveryMinor !== undefined) {
		settings.delivery = { maxSubtotalMinor: deliveryMinor }
	}
	// The guest limit belongs to tables only: a pickup or delivery order has no
	// head count.
	if (guests !== undefined) {
		settings.dineIn = { maxGuests: guests }
	}
	if (!settings.pickup && !settings.delivery && !settings.dineIn) {
		return { ok: true as const, settings: null }
	}
	// The same schema the region reads: a record it cannot read would be
	// ignored there without a word.
	const valid = orderCapsSettingsSchema.safeParse(settings)
	if (!valid.success) {
		return { ok: false as const, error: ORDER_CAP_AMOUNT_ERROR }
	}
	return { ok: true as const, settings: valid.data }
}

function packagingFromForm(
	values: PackagingFeeFormValues,
	currency: string,
): { ok: true; settings: PackagingFeeSettings } | { ok: false; error: string } {
	if (!values.enabled) {
		return {
			ok: true,
			settings: { ...defaultPackagingFeeSettings(currency), enabled: false },
		}
	}
	const amountMinor = parseMoneyToMinor(values.amount, { currency })
	if (amountMinor == null || amountMinor <= 0) {
		return { ok: false, error: 'Enter a packaging fee amount.' }
	}
	const fulfillments: PackagingFeeSettings['fulfillments'] = []
	if (values.pickup) fulfillments.push('pickup')
	if (values.delivery) fulfillments.push('delivery')
	const parsed = packagingFeeSettingsSchema.safeParse({
		enabled: true,
		mode: values.mode,
		amountMinor,
		fulfillments,
		label: values.label.trim() || defaultPackagingFeeSettings(currency).label,
		taxable: values.taxable,
	})
	if (!parsed.success) {
		return {
			ok: false,
			error: parsed.error.issues[0]?.message ?? 'Check the packaging fee.',
		}
	}
	return { ok: true, settings: parsed.data }
}

export type CheckoutRulesBundle = {
	pickupInstructions: PickupInstructionsForm
	orderCaps: OrderCapsFormValues
	packagingFee: PackagingFeeFormValues
}

export const PICKUP_DEFAULT_LANGUAGE_ERROR =
	'Add the pickup instructions in your default language too. Guests in a language without text read that one.'

export function parseCheckoutRulesFields(
	raw: Record<string, unknown>,
	options: {
		currency: string
		defaultLocale: string
		packagingFeeEnabled: boolean
	},
): { ok: true; patch: CheckoutRulesPatch } | { ok: false; error: string } {
	const json = raw.checkoutRules
	if (typeof json !== 'string' || !json.trim()) {
		return { ok: true, patch: {} }
	}
	let parsedJson: unknown
	try {
		parsedJson = JSON.parse(json)
	} catch {
		return { ok: false, error: 'Could not read checkout rules.' }
	}
	if (!parsedJson || typeof parsedJson !== 'object') {
		return { ok: false, error: 'Could not read checkout rules.' }
	}
	const bundle = parsedJson as CheckoutRulesBundle
	const patch: CheckoutRulesPatch = {}

	const pickupMap: LocalizedString = {}
	for (const [locale, text] of Object.entries(
		bundle.pickupInstructions ?? {},
	)) {
		const trimmed = String(text).trim().slice(0, PICKUP_INSTRUCTIONS_MAX_LENGTH)
		if (trimmed) pickupMap[locale] = trimmed
	}
	if (Object.keys(pickupMap).length > 0) {
		// The default language is what a guest reads when their own has no text.
		if (!pickupMap[options.defaultLocale]) {
			return { ok: false, error: PICKUP_DEFAULT_LANGUAGE_ERROR }
		}
		const valid = pickupInstructionsSchema.safeParse(pickupMap)
		if (!valid.success) {
			return {
				ok: false,
				error: valid.error.issues[0]?.message ?? 'Check pickup instructions.',
			}
		}
		patch.pickupInstructions = serializePickupInstructions(pickupMap)
	} else {
		patch.pickupInstructions = null
	}

	const caps = capsFromForm(
		bundle.orderCaps ?? orderCapsFormFromRecord(null),
		options.currency,
	)
	if (!caps.ok) return caps
	patch.orderCaps = caps.settings == null ? null : JSON.stringify(caps.settings)

	if (options.packagingFeeEnabled) {
		const fee = packagingFromForm(
			bundle.packagingFee ?? packagingFeeFormFromRecord(null, options.currency),
			options.currency,
		)
		if (!fee.ok) return fee
		patch.packagingFee = JSON.stringify(fee.settings)
	}

	return { ok: true, patch }
}
