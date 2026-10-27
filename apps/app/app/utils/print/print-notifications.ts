import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'

export type PrintAlertKind = 'paid' | 'shipped' | 'failed'

const KINDS: Record<string, PrintAlertKind> = {
	print_order_paid: 'paid',
	print_order_shipped: 'shipped',
	print_order_failed: 'failed',
}

export function printAlertKindFromNotificationType(
	type: string,
): PrintAlertKind | null {
	return KINDS[type] ?? null
}

export const PRINT_ALERT_COPY: Record<
	PrintAlertKind,
	{ subject: MessageDescriptor; body: MessageDescriptor }
> = {
	paid: {
		subject: msg`**Print order paid**`,
		body: msg`We sent it to the printer. You can cancel until production starts.`,
	},
	shipped: {
		subject: msg`**Your prints are on the way**`,
		body: msg`The parcel has shipped. Tracking is on the order page.`,
	},
	failed: {
		subject: msg`**Print order refunded**`,
		body: msg`The order could not be completed, so we refunded it in full.`,
	},
}
