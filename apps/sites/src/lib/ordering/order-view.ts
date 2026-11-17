/**
 * Pure helpers for drawing an order read from the region. A read authorised
 * by the emailed link (`X-Order-Link`) returns a reduced body: no `contact`,
 * `delivery` is only `{ feeCents, zoneId }` and every line note is null. The
 * receipt-token body carries all of it. Nothing here may print "undefined" or
 * leave an empty labelled row.
 */

import { DEFAULT_PACKAGING_FEE_LABEL } from '@repo/common/packaging-fee'

export type ReceiptRecipientInput = {
	fulfillment: string
	contact?: { name?: string | null; phone?: string | null } | null
	delivery?: {
		address?: string | null
		unit?: string | null
		city?: string | null
		feeCents?: number
		zoneId?: string | null
	} | null
}

/**
 * The "name • phone • Deliver to: address" line, or an empty string when the
 * body carries none of it (the link view). `deliverTo` is the translated
 * template with an `{address}` placeholder.
 */
export function receiptRecipientText(
	order: ReceiptRecipientInput,
	deliverTo: string,
): string {
	const parts = [order.contact?.name, order.contact?.phone].filter(
		(part): part is string => typeof part === 'string' && part.length > 0,
	)
	if (order.fulfillment === 'delivery' && order.delivery) {
		const address = [
			order.delivery.address,
			order.delivery.unit,
			order.delivery.city,
		]
			.filter(
				(part): part is string => typeof part === 'string' && part.length > 0,
			)
			.join(', ')
		if (address) parts.push(deliverTo.replace('{address}', address))
	}
	return parts.join(' • ')
}

/** A line note to show, or null when the body has none (always null on a link read). */
export function receiptLineNote(
	instructions: string | null | undefined,
): string | null {
	return typeof instructions === 'string' && instructions.trim()
		? instructions
		: null
}

/** The part of a receipt that says what was added for takeaway (#251, #257, #408). */
export type ReceiptExtrasInput = {
	fulfillment: string
	packagingFeeCents?: number | null
	packagingFeeLabel?: string | null
	utensilsRequested?: boolean | null
	pickupInstructions?: string | null
}

/**
 * The packaging fee as its own receipt line, under the name the guest saw.
 * The default name reads in the page language. Null when none was charged
 * (an order from before the fee existed carries no field at all).
 */
export function receiptPackagingLine(
	order: Pick<ReceiptExtrasInput, 'packagingFeeCents' | 'packagingFeeLabel'>,
	defaultLabel: string,
): { label: string; cents: number } | null {
	const cents = order.packagingFeeCents ?? 0
	if (!(cents > 0)) return null
	const saved = order.packagingFeeLabel?.trim()
	return {
		label:
			saved && saved !== DEFAULT_PACKAGING_FEE_LABEL ? saved : defaultLabel,
		cents,
	}
}

/**
 * "Utensils: yes" or "No utensils", exactly what the guest chose. Null when
 * the question was not asked of this order (null) or the order predates it.
 */
export function receiptUtensilsText(
	order: Pick<ReceiptExtrasInput, 'utensilsRequested'>,
	labels: { yes: string; no: string },
): string | null {
	if (typeof order.utensilsRequested !== 'boolean') return null
	return order.utensilsRequested ? labels.yes : labels.no
}

/**
 * The pickup instructions the guest saw at checkout, kept with the order, as
 * plain text for `textContent` and `white-space: pre-line`. Null for a delivery
 * or table order, for an empty text, and for an order from before they existed.
 */
export function receiptPickupInstructions(
	order: Pick<ReceiptExtrasInput, 'fulfillment' | 'pickupInstructions'>,
): string | null {
	if (order.fulfillment !== 'pickup') return null
	const text = order.pickupInstructions
	return typeof text === 'string' && text.trim() !== '' ? text : null
}

/**
 * Whether prices included tax: the total never added it on top, which the
 * receipt's own amounts show. Every charge the total carries is part of the
 * test, so a fee on an order never makes an inclusive price read exclusive.
 */
export function receiptTaxIncluded(order: {
	taxCents: number
	totalCents: number
	subtotalCents: number
	/** What coupons and automatic discounts took off the items. */
	itemSavingCents: number
	loyaltyCents: number
	/** Delivery fee after a delivery discount. */
	deliveryNetCents: number
	tipCents: number
	serviceFeeCents?: number | null
	packagingFeeCents?: number | null
}): boolean {
	return (
		order.taxCents > 0 &&
		order.totalCents ===
			order.subtotalCents -
				order.itemSavingCents -
				order.loyaltyCents +
				order.deliveryNetCents +
				order.tipCents +
				(order.serviceFeeCents ?? 0) +
				(order.packagingFeeCents ?? 0)
	)
}
