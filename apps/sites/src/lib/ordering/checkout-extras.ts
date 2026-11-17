/**
 * What a guest pays on top of the items at online checkout and at a table
 * tab: the tip buttons (#118), the service fee line (#123), the packaging fee
 * line (#408), and the two small questions of a takeaway order: utensils
 * (#257) and where to collect it (#251). Pure helpers
 * shared by the checkout page and the table page; the region prices both and
 * refuses a different amount, so this only decides what to show and what to
 * send.
 */
import { toAsciiDigits } from '@repo/common/ascii-digits'
import {
	defaultQrTabTipSettings,
	defaultTipOrderTypeSettings,
	type TipChoice,
	type TipOrderType,
	type TipOrderTypeSettings,
	type TipSettings,
} from '@repo/common/location-types'
import { maxTipMinor } from '@repo/common/order-tips'
import {
	DEFAULT_PACKAGING_FEE_LABEL,
	computePackagingFee,
	type PackagingFeeResult,
	type PackagingFeeSettings,
} from '@repo/common/packaging-fee'
import { resolvePickupInstructions } from '@repo/common/pickup-instructions'
import {
	DEFAULT_SERVICE_FEE_LABEL,
	computeServiceFee,
	type ServiceFeeFulfillment,
	type ServiceFeeResult,
	type ServiceFeeSettings,
} from '@repo/common/service-fee'

/** What the guest picked: no tip, a share of the subtotal, or an exact amount. */
export type TipSelection =
	| { kind: 'none' }
	| { kind: 'percent'; percent: number }
	| { kind: 'amount'; amountMinor: number }

export type TipView = {
	/** In the order the operator set. "No tip" is always offered besides these. */
	choices: TipChoice[]
	allowCustom: boolean
	/** The selection when the page opens. */
	initial: TipSelection
}

/** The part of the ordering options this file reads (older nodes lack both). */
export type CheckoutOptions = {
	tipChoices?: { currency: string; settings: TipSettings }
	serviceFee?: ServiceFeeSettings | null
	packagingFee?: PackagingFeeSettings | null
	utensils?: { enabled: boolean; defaultRequested: boolean } | null
	pickupInstructions?: string | null
} | null

const toSelection = (choice: TipChoice): TipSelection =>
	'percent' in choice
		? { kind: 'percent', percent: choice.percent }
		: { kind: 'amount', amountMinor: choice.amountMinor }

/**
 * The tip buttons for an order type. A node that sends none (an older one)
 * gets the old 10, 15, 18 and 20 percent buttons with 15 selected, and none
 * selected in Saudi riyals.
 */
export function tipViewFor(
	options: CheckoutOptions,
	orderType: TipOrderType,
	currency: string,
): TipView {
	return tipViewOf(
		options?.tipChoices?.settings[orderType],
		orderType,
		options?.tipChoices?.currency ?? currency,
	)
}

/** The same view from one order type's settings, or the defaults when there are none. */
export function tipViewOf(
	saved: TipOrderTypeSettings | undefined,
	orderType: TipOrderType,
	currency: string,
): TipView {
	const settings =
		saved ??
		(orderType === 'qrTab'
			? defaultQrTabTipSettings()
			: defaultTipOrderTypeSettings(currency))
	const preselected =
		settings.defaultIndex === null
			? undefined
			: settings.choices[settings.defaultIndex]
	return {
		choices: settings.choices,
		allowCustom: settings.allowCustom,
		initial: preselected ? toSelection(preselected) : { kind: 'none' },
	}
}

export function sameTipSelection(a: TipSelection, b: TipSelection): boolean {
	if (a.kind !== b.kind) return false
	if (a.kind === 'percent' && b.kind === 'percent')
		return a.percent === b.percent
	if (a.kind === 'amount' && b.kind === 'amount') {
		return a.amountMinor === b.amountMinor
	}
	return true
}

/** The tip in minor units on a subtotal (before discounts), as the region rounds it. */
export function tipSelectionMinor(
	selection: TipSelection,
	subtotalMinor: number,
): number {
	if (selection.kind === 'percent') {
		return Math.round((subtotalMinor * selection.percent) / 100)
	}
	return selection.kind === 'amount' ? selection.amountMinor : 0
}

/**
 * What goes in the order body. A share stays `tipPercent`, which every node
 * reads; only an exact amount needs the newer `tip` field.
 */
export function tipPayload(
	selection: TipSelection,
):
	| { tipPercent: number }
	| { tipPercent: number; tip: { amountMinor: number } } {
	if (selection.kind === 'amount') {
		return { tipPercent: 0, tip: { amountMinor: selection.amountMinor } }
	}
	return { tipPercent: selection.kind === 'percent' ? selection.percent : 0 }
}

export type CustomTip =
	| { ok: true; amountMinor: number }
	| { ok: false; reason: 'invalid' | 'too_large' }

/**
 * A typed custom tip, in major units with up to two decimals ("4", "4.5",
 * "٤٫٥٠"). Above the cap (the larger of half the subtotal or the currency
 * limit) the region refuses with `tip_too_large`, so the page does first.
 */
export function parseCustomTip(
	text: string,
	currency: string,
	subtotalMinor: number,
): CustomTip {
	const normalized = toAsciiDigits(text)
		.replace(/[‎‏؜\s]/g, '')
		.replace(/٫/g, '.')
		.replace(/٬/g, ',')
	const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(normalized)
	if (!match) return { ok: false, reason: 'invalid' }
	const amountMinor =
		Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0')
	if (amountMinor > maxTipMinor(subtotalMinor, currency)) {
		return { ok: false, reason: 'too_large' }
	}
	return { ok: true, amountMinor }
}

/** The order type whose tip buttons apply to a checkout. */
export function tipOrderTypeOf(mode: 'pickup' | 'delivery'): TipOrderType {
	return mode === 'delivery' ? 'delivery' : 'pickup'
}

export type ServiceFeeView = ServiceFeeResult & {
	/** The name to show: the default reads in the guest's language. */
	label: string
	explanation: string | null
}

/**
 * The service fee line for an order, or null when the location has none for
 * it. The base is the subtotal after discounts and rewards, before tax and
 * tip, exactly as the region prices it.
 */
export function serviceFeeFor(
	options: CheckoutOptions,
	input: {
		fulfillment: ServiceFeeFulfillment
		/** Minor units. */
		subtotalMinor: number
		discountMinor: number
		taxRatePercent: number
		taxInclusive: boolean
		/** What "Service fee" is called in the guest's language. */
		defaultLabel: string
	},
): ServiceFeeView | null {
	const settings = options?.serviceFee
	if (!settings) return null
	const result = computeServiceFee({
		settings,
		fulfillment: input.fulfillment,
		baseCents: input.subtotalMinor - input.discountMinor,
		taxRatePercent: input.taxRatePercent,
		taxInclusive: input.taxInclusive,
	})
	if (result.feeCents <= 0) return null
	return {
		...result,
		label:
			settings.label === DEFAULT_SERVICE_FEE_LABEL
				? input.defaultLabel
				: settings.label,
		explanation: settings.explanation,
	}
}

/** The total the guest owes for the fee line: its tax too, unless prices include tax. */
export function serviceFeeChargeMinor(
	fee: ServiceFeeResult,
	taxInclusive: boolean,
): number {
	return fee.feeCents + (taxInclusive ? 0 : fee.taxCents)
}

export type PackagingFeeView = PackagingFeeResult & {
	/** The name to show: the default reads in the guest's language. */
	label: string
}

/**
 * The packaging or bag fee line for an order, or null when the location has
 * none for it (#408). A table never has one. A per-item fee counts `itemUnits`:
 * the dishes that count toward order limits, as the region counts them. A
 * discount that waives the fee is the region's word: while a quote is on its
 * way this is the estimate, and the quote's `packagingFeeMinor` replaces it.
 */
export function packagingFeeFor(
	options: CheckoutOptions,
	input: {
		fulfillment: 'pickup' | 'delivery' | 'dine_in'
		/** Dish units after the order-limit exemptions. */
		itemUnits: number
		taxRatePercent: number
		taxInclusive: boolean
		/** What "Packaging fee" is called in the guest's language. */
		defaultLabel: string
	},
): PackagingFeeView | null {
	const settings = options?.packagingFee
	if (!settings || input.fulfillment === 'dine_in') return null
	const result = computePackagingFee({
		settings,
		fulfillment: input.fulfillment,
		itemUnits: input.itemUnits,
		taxRatePercent: input.taxRatePercent,
		taxInclusive: input.taxInclusive,
	})
	if (result.feeCents <= 0) return null
	return {
		...result,
		label:
			settings.label === DEFAULT_PACKAGING_FEE_LABEL
				? input.defaultLabel
				: settings.label,
	}
}

/** The total the guest owes for the packaging line: its tax too, unless prices include tax. */
export function packagingFeeChargeMinor(
	fee: PackagingFeeResult,
	taxInclusive: boolean,
): number {
	return fee.feeCents + (taxInclusive ? 0 : fee.taxCents)
}

export type UtensilsView = {
	/** Whether the box starts ticked. */
	defaultRequested: boolean
}

/**
 * "Include utensils and napkins" (#257): asked only for pickup and delivery,
 * and only where the location asks. Never for a table.
 */
export function utensilsView(
	options: CheckoutOptions,
	fulfillment: 'pickup' | 'delivery' | 'dine_in',
): UtensilsView | null {
	const utensils = options?.utensils
	if (!utensils?.enabled || fulfillment === 'dine_in') return null
	return { defaultRequested: utensils.defaultRequested === true }
}

/**
 * The location's pickup instructions (#251) in the guest's language, as plain
 * text to show with `textContent` and `white-space: pre-line`. Null when there
 * is none, or when the order is not a pickup (the location's text is for guests
 * collecting at its door; a drop has its own pickup place, and the region sends
 * none for it).
 */
export function pickupInstructionsFor(
	options: CheckoutOptions,
	locale: string,
	defaultLocale: string,
	fulfillment: 'pickup' | 'delivery' | 'dine_in' = 'pickup',
): string | null {
	if (fulfillment !== 'pickup') return null
	const text = resolvePickupInstructions(
		options?.pickupInstructions ?? null,
		locale,
		defaultLocale,
	)
	return text === '' ? null : text
}
