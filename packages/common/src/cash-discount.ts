/**
 * The cash-payment discount (#375): a percentage a location takes off a bill
 * paid entirely in cash, shown as its own line. It is the other side of a card
 * surcharge (#264, not built): both are a difference in price by payment
 * method, so the rule for where each is allowed lives in one table here and a
 * surcharge reads the same table. No imports, no I/O: the App (setting and
 * menu payload), the till (the line) and tenant-api (the upload check) all
 * call it.
 */

/**
 * Where a price difference by payment method is allowed, by the organization's
 * data region. A cash discount is allowed in the US. The KSA node never offers
 * it: the setting is hidden, the till never sees it and an uploaded sale that
 * carries one is flagged. Add a key for a region only with a legal reason.
 */
export const PAYMENT_PRICING_RULES = {
	us: { cashDiscount: true },
	ksa: { cashDiscount: false },
} as const satisfies Record<string, { cashDiscount: boolean }>

/** The largest cash discount a location may set: 10.00%, in basis points. */
export const CASH_DISCOUNT_MAX_BP = 1000

/**
 * The id of the cash discount adjustment on a sale. There is at most one per
 * sale, which is also how the region tells it from a manual discount.
 */
export const CASH_DISCOUNT_ADJUSTMENT_ID = 'cash-discount'

/** Whether an organization in this data region may offer a cash discount. Unknown regions may not. */
export function cashDiscountAllowedIn(
	dataRegion: string | null | undefined,
): boolean {
	if (!dataRegion) return false
	const rules = PAYMENT_PRICING_RULES as Record<
		string,
		{ cashDiscount: boolean } | undefined
	>
	return rules[dataRegion]?.cashDiscount === true
}

/** A configured percentage that is a whole number of basis points in range, else null. */
export function readCashDiscountBp(value: unknown): number | null {
	return typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value >= 1 &&
		value <= CASH_DISCOUNT_MAX_BP
		? value
		: null
}

/**
 * Why a cash discount does not apply to a bill, or null when it does. The
 * surcharge guard is the hook for #264: a bill that carries a card surcharge
 * never also gets a cash discount, whichever is set. Nothing makes a
 * surcharge yet, so callers pass 0 until it exists.
 */
export type CashDiscountBlock =
	'not_allowed_here' | 'not_set' | 'not_all_cash' | 'card_surcharge_present'

export function cashDiscountBlock(input: {
	dataRegion: string | null | undefined
	percentBp: number | null | undefined
	/** True when the whole bill is paid in cash, in one payment. */
	paidAllInCash: boolean
	/** A card surcharge (#264) on the same bill, in minor units. Reserved: always 0 today. */
	cardSurchargeCents?: number
}): CashDiscountBlock | null {
	if (!cashDiscountAllowedIn(input.dataRegion)) return 'not_allowed_here'
	if (readCashDiscountBp(input.percentBp) === null) return 'not_set'
	if ((input.cardSurchargeCents ?? 0) > 0) return 'card_surcharge_present'
	if (!input.paidAllInCash) return 'not_all_cash'
	return null
}

/**
 * The discount in minor units: the percentage of what the bill costs after its
 * other discounts, rounded down so the guest is never given a cent more than
 * the rate says. The tip stays on the bill before any discount.
 */
export function cashDiscountCents(input: {
	subtotalCents: number
	/** Discounts and rewards already taken (capped at the subtotal by the caller or here). */
	otherAdjustmentCents: number
	percentBp: number
}): number {
	const bp = readCashDiscountBp(input.percentBp)
	if (bp === null) return 0
	const left = Math.max(
		0,
		Math.trunc(input.subtotalCents) -
			Math.min(
				Math.max(0, Math.trunc(input.otherAdjustmentCents)),
				Math.trunc(input.subtotalCents),
			),
	)
	return Math.floor((left * bp) / 10_000)
}

/**
 * The most a cash discount on an uploaded sale may be: the rate's ceiling on
 * the subtotal, plus one cent for each line the till rounded. A bigger amount
 * is flagged for a person to look at; the sale is kept.
 */
export function cashDiscountCeilingCents(input: {
	subtotalCents: number
	lineCount: number
}): number {
	return (
		Math.ceil(
			(Math.max(0, input.subtotalCents) * CASH_DISCOUNT_MAX_BP) / 10_000,
		) + Math.max(0, input.lineCount)
	)
}
