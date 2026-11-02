import {
	type DiscountQuote,
	type DiscountRefusalReason,
	localizedDiscountText,
} from '@repo/discounts'
import { type DiscountQuoteState } from './discount-quote.ts'
import { fillTemplate } from './money.ts'

/**
 * What checkout and the receipt say about discounts. Pure helpers: the page
 * builds the labels from the Lingui catalog and renders what these return.
 */

export type DiscountLabels = {
	/** Plain, kind copy per refusal. Unknown, paused and archived codes all read as `not_found`. */
	refusals: Record<DiscountRefusalReason, string>
	/** The code lost to a better discount. */
	replaced: string
	/** Apply pressed with nothing typed. */
	enterCode: string
	/** "{code} applied" */
	applied: string
	/** "Code {code} applied. You save {amount}. Total {total}." */
	appliedAnnounce: string
	/** "Coupon code removed. Total {total}." */
	removedAnnounce: string
	/** "Total updated to {total}." */
	totalUpdated: string
	checking: string
	updating: string
	estimate: string
	/** "{name} (delivery)" */
	deliveryDiscount: string
	/** "Your discount changed, so we updated your total to {total}. ..." */
	discountChanged: string
	/** A refused order whose reason could not be read. */
	couponRefusedGeneric: string
	/** The feature went off between the quote and placing. */
	discountsDisabled: string
	totalUnconfirmed: string
	/** A code typed while the order cannot be priced yet. */
	waiting: string
	/** A code the region could not check just now. */
	unchecked: string
}

export function refusalMessage(
	reason: DiscountRefusalReason | null,
	labels: DiscountLabels,
): string {
	return labels.refusals[reason ?? 'not_found'] ?? labels.refusals.not_found
}

/** One line of the breakdown: a discount, or the delivery part of one. */
export type DiscountLine = {
	key: string
	label: string
	code: string | null
	amountMinor: number
	delivery: boolean
}

/**
 * The page language a discount name is shown in: the guest's language, then
 * the site's default language, then the name the operator typed.
 */
export type DiscountTextLanguage = {
	locale?: string | null
	defaultLocale?: string | null
}

/**
 * The discount lines of a quote, in the region's order. A discount that takes
 * something off both the items and delivery shows as two lines, so each sum
 * adds up to the amounts above it. Names are shown in `language`.
 */
export function discountLines(
	quote: Pick<DiscountQuote, 'discounts'>,
	labels: Pick<DiscountLabels, 'deliveryDiscount'>,
	language: DiscountTextLanguage = {},
): DiscountLine[] {
	const lines: DiscountLine[] = []
	for (const discount of quote.discounts) {
		const name = localizedDiscountText(
			discount.nameI18n,
			discount.name,
			language.locale,
			language.defaultLocale,
		)
		if (discount.amountMinor > 0) {
			lines.push({
				key: `${discount.discountId}:items`,
				label: name,
				code: discount.code,
				amountMinor: discount.amountMinor,
				delivery: false,
			})
		}
		if (discount.deliveryAmountMinor > 0) {
			lines.push({
				key: `${discount.discountId}:delivery`,
				label: fillTemplate(labels.deliveryDiscount, { name }),
				code: discount.code,
				amountMinor: discount.deliveryAmountMinor,
				delivery: true,
			})
		}
	}
	return lines
}

/** What the customer sees under the coupon field. */
export type CouponView =
	| { mode: 'none' }
	| { mode: 'checking'; code: string }
	| { mode: 'applied'; code: string }
	| { mode: 'replaced'; code: string; message: string }
	/** Typed, but not checked: the order is not priceable yet, or the region did not answer. */
	| { mode: 'waiting'; code: string; message: string }
	| {
			mode: 'refused'
			code: string
			reason: DiscountRefusalReason
			message: string
	  }

/**
 * `code` is the code being sent; `held` is a code that was refused for good
 * and is no longer sent, kept so its message stays until the customer edits it.
 */
export function couponView(
	input: {
		code: string | null
		held: { code: string; reason: DiscountRefusalReason } | null
		state: DiscountQuoteState
	},
	labels: DiscountLabels,
): CouponView {
	if (input.code === null) {
		return input.held
			? {
					mode: 'refused',
					code: input.held.code,
					reason: input.held.reason,
					message: refusalMessage(input.held.reason, labels),
				}
			: { mode: 'none' }
	}
	const { state } = input
	if (state.status === 'idle') {
		return { mode: 'waiting', code: input.code, message: labels.waiting }
	}
	if (state.status === 'error') {
		return { mode: 'waiting', code: input.code, message: labels.unchecked }
	}
	if (state.status !== 'ready') return { mode: 'checking', code: input.code }
	const coupon = state.quote.coupon
	if (!coupon) return { mode: 'checking', code: input.code }
	if (coupon.status === 'applied') return { mode: 'applied', code: input.code }
	if (coupon.status === 'replaced') {
		return { mode: 'replaced', code: input.code, message: labels.replaced }
	}
	return {
		mode: 'refused',
		code: input.code,
		reason: coupon.reason,
		message: refusalMessage(coupon.reason, labels),
	}
}

/** Money amounts of the summary, in minor units, with where they came from. */
export type SummaryTotals = {
	subtotalMinor: number
	discountMinor: number
	loyaltyMinor: number
	taxMinor: number
	deliveryFeeMinor: number
	deliveryDiscountMinor: number
	tipMinor: number
	totalMinor: number
	/** Priced by the region for the order on screen. */
	source: 'quote' | 'estimate'
}

/** The totals the region's quote prices. */
export function totalsFromQuote(quote: DiscountQuote): SummaryTotals {
	return {
		subtotalMinor: quote.subtotalMinor,
		discountMinor: quote.totalDiscountMinor - quote.deliveryDiscountMinor,
		loyaltyMinor: quote.loyaltyDiscountMinor,
		taxMinor: quote.taxMinor,
		deliveryFeeMinor: quote.deliveryFeeMinor,
		deliveryDiscountMinor: quote.deliveryDiscountMinor,
		tipMinor: quote.tipMinor,
		totalMinor: quote.totalMinor,
		source: 'quote',
	}
}

/**
 * The status line under the totals: "Updating..." while a quote is on its
 * way, the estimate warning when none could be had, nothing when the figures
 * are the region's (or the feature is off and checkout is as it always was).
 */
export function totalsNote(
	state: DiscountQuoteState,
	labels: Pick<DiscountLabels, 'updating' | 'estimate'>,
): string {
	if (state.status === 'loading') return labels.updating
	if (state.status === 'error') return labels.estimate
	return ''
}

/** The polite announcement after a quote changed what the customer pays. */
export function appliedAnnouncement(
	code: string,
	amountMinor: number,
	totalMinor: number,
	formatMoney: (minor: number) => string,
	labels: Pick<DiscountLabels, 'appliedAnnounce'>,
): string {
	return fillTemplate(labels.appliedAnnounce, {
		code,
		amount: formatMoney(amountMinor),
		total: formatMoney(totalMinor),
	})
}

/**
 * The receipt of an order: reads the discount fields defensively, since an
 * older region sends none of them.
 */
export type ReceiptDiscounts = {
	lines: DiscountLine[]
	/** Items discount (without delivery) and delivery discount in cents. */
	itemsCents: number
	deliveryCents: number
	loyaltyCents: number
	free: boolean
}

function cents(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? Math.round(value)
		: 0
}

/** A `{ locale: text }` map read defensively from an order the region sent. */
function textMap(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return undefined
	const out: Record<string, string> = {}
	for (const [key, text] of Object.entries(value)) {
		if (typeof text === 'string' && text.trim()) out[key] = text
	}
	return Object.keys(out).length > 0 ? out : undefined
}

export function receiptDiscounts(
	order: {
		discounts?: unknown
		discountCents?: unknown
		deliveryDiscountCents?: unknown
		loyaltyDiscountCents?: unknown
		paymentStatus?: unknown
	},
	labels: Pick<DiscountLabels, 'deliveryDiscount'> & {
		/** Used when the order has a discount amount but no named snapshot. */
		discount: string
		deliveryDiscountPlain: string
	},
	language: DiscountTextLanguage = {},
): ReceiptDiscounts {
	const rows = Array.isArray(order.discounts) ? order.discounts : []
	const lines = discountLines(
		{
			discounts: rows.flatMap((row, index) => {
				if (!row || typeof row !== 'object') return []
				const entry = row as Record<string, unknown>
				const name = typeof entry.name === 'string' ? entry.name.trim() : ''
				if (!name) return []
				const id =
					typeof entry.discountId === 'string'
						? entry.discountId
						: typeof entry.id === 'string'
							? entry.id
							: `d${index}`
				return [
					{
						discountId: id,
						version: 1,
						name,
						nameI18n: textMap(entry.nameI18n),
						code:
							typeof entry.code === 'string' && entry.code ? entry.code : null,
						amountMinor: cents(entry.amountMinor),
						deliveryAmountMinor: cents(entry.deliveryAmountMinor),
						lineIds: [],
					},
				]
			}),
		},
		labels,
		language,
	)
	const deliveryCents = cents(order.deliveryDiscountCents)
	const itemsCents = cents(order.discountCents)
	if (!lines.some((line) => !line.delivery) && itemsCents > 0) {
		lines.unshift({
			key: 'items',
			label: labels.discount,
			code: null,
			amountMinor: itemsCents,
			delivery: false,
		})
	}
	if (!lines.some((line) => line.delivery) && deliveryCents > 0) {
		lines.push({
			key: 'delivery',
			label: labels.deliveryDiscountPlain,
			code: null,
			amountMinor: deliveryCents,
			delivery: true,
		})
	}
	return {
		lines,
		itemsCents,
		deliveryCents,
		loyaltyCents: cents(order.loyaltyDiscountCents),
		free: order.paymentStatus === 'not_required',
	}
}
