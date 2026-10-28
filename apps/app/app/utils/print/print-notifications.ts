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
		body: msg`Payment is confirmed. Submission to the printer is pending. You can cancel until production starts.`,
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

/**
 * The email for the same events. Users have no stored language, so it uses
 * the language of the request that sends it (the operator's own action), and
 * the source language from webhooks and jobs, like the App's other emails.
 */
export const PRINT_EMAIL_COPY: Record<
	PrintAlertKind,
	{ headline: MessageDescriptor; detail: MessageDescriptor }
> = {
	paid: {
		headline: msg`Your print order is paid`,
		detail: msg`Payment is confirmed. Submission to the printer is pending. You can cancel until production starts.`,
	},
	shipped: {
		headline: msg`Your prints are on the way`,
		detail: msg`The parcel has shipped. Tracking is on the order page.`,
	},
	failed: {
		headline: msg`Your print order was refunded`,
		detail: msg`The order could not be completed, so we refunded it in full.`,
	},
}

export const PRINT_EMAIL_EYEBROW = msg`Print shop`
export const PRINT_EMAIL_ACTION = msg`Open the order`
