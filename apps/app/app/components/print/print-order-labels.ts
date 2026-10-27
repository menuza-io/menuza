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
