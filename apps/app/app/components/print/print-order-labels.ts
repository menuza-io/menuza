import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { type PrintOrderStatus } from '@repo/common/print-shop'

export const PRINT_ORDER_STATUS_LABELS: Record<
	PrintOrderStatus,
	MessageDescriptor
> = {
	quote: msg`Price ready`,
	awaiting_payment: msg`Waiting for payment`,
	paid: msg`Paid`,
	submitting: msg`Sending to the printer`,
	cancelling: msg`Cancelling`,
	submitted: msg`Sent to the printer`,
	in_production: msg`Printing`,
	shipped: msg`Shipped`,
	delivered: msg`Delivered`,
	held: msg`On hold`,
	failed: msg`Failed`,
	cancelled: msg`Cancelled`,
	refunded: msg`Refunded`,
}

export function printOrderStatusTone(
	status: string,
): 'success' | 'warning' | 'secondary' | 'destructive' {
	if (status === 'shipped' || status === 'delivered' || status === 'paid') {
		return 'success'
	}
	if (status === 'held' || status === 'awaiting_payment') return 'warning'
	if (status === 'failed') return 'destructive'
	return 'secondary'
}

/** Messages for the codes `PrintOrderError` and the order actions return. */
export const PRINT_ORDER_ERROR_LABELS: Record<string, MessageDescriptor> = {
	design_not_approved: msg`Approve each print before ordering it.`,
	not_shippable: msg`This print or size cannot be shipped right now.`,
	quote_unavailable: msg`We could not get a price right now. Try again in a minute.`,
	not_payable: msg`This order is already paid or closed.`,
	quote_expired: msg`This price has expired. Get a new price.`,
	checkout_unavailable: msg`Payment is unavailable right now. Try again in a minute.`,
	too_late: msg`Production has started, so this order can no longer be cancelled.`,
	shipping_paused: msg`Shipped prints are paused for a moment. Try again later.`,
	no_lines: msg`Choose at least one print and how many copies.`,
	order_busy: msg`This order is changing right now. Refresh and try again.`,
	payment_processing: msg`Your payment is being confirmed. This page updates in a moment.`,
	partial_cancel: msg`Part of this order was already printing. Our team will refund what was cancelled.`,
	design_stale: msg`QR codes or labels changed since this print was approved. Approve the proof again, then order.`,
	qr_unavailable: msg`The QR codes could not be checked right now. Try again in a minute.`,
	qr_forbidden: msg`Ordering this print also needs permission to see its QR codes.`,
	needs_support: msg`Our team is checking this order with the printer. It cannot be cancelled here right now.`,
}

export const PRINT_ORDER_ERROR_FALLBACK = msg`That did not work. Try again.`
