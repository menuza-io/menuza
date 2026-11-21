import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

/** Plain words for the short code a failed provider refund carries. */
export const REFUND_FAILURE_LABELS: Record<string, MessageDescriptor> = {
	charge_already_refunded: msg`The payment was already refunded.`,
	charge_disputed: msg`The payment is disputed with the card issuer.`,
	amount_too_large: msg`The amount is more than the provider can return.`,
	expired_or_canceled_card: msg`The guest's card is closed or expired.`,
	refund_declined: msg`The provider declined the refund.`,
	payment_not_found: msg`The provider could not find the payment.`,
	processor_unavailable: msg`The payment provider could not be reached.`,
}

export const REFUND_FAILURE_FALLBACK = msg`The payment provider could not complete the refund.`

/** Operator cancel reasons (the stored values, `@repo/common`). */
export const CANCEL_REASON_LABELS: Record<string, MessageDescriptor> = {
	out_of_stock: msg`Out of stock`,
	kitchen_closed: msg`Kitchen closed`,
	guest_asked: msg`Guest asked`,
	duplicate: msg`Duplicate order`,
	other: msg`Other`,
	too_busy: msg`Too busy`,
	not_accepted_in_time: msg`Not accepted in time`,
}

export const CANCELLED_BY_LABELS: Record<string, MessageDescriptor> = {
	operator: msg`Staff`,
	guest: msg`Guest`,
	system: msg`Automatically`,
}

/** Where an order came from (#115): the stored `attribution_source` values. */
export const ORDER_SOURCE_LABELS: Record<string, MessageDescriptor> = {
	direct: msg`Direct`,
	email: msg`Email campaign`,
	sms: msg`Text campaign`,
	campaign: msg`Campaign`,
	short_link: msg`Short link`,
	qr_table: msg`Table QR code`,
	qr_poster: msg`Poster QR code`,
	coupon: msg`Coupon`,
}
