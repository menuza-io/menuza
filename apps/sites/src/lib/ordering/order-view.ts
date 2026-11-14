/**
 * Pure helpers for drawing an order read from the region. A read authorised
 * by the emailed link (`X-Order-Link`) returns a reduced body: no `contact`,
 * `delivery` is only `{ feeCents, zoneId }` and every line note is null. The
 * receipt-token body carries all of it. Nothing here may print "undefined" or
 * leave an empty labelled row.
 */

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
