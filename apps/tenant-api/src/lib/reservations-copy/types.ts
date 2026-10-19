import { type ToggleableMessageKind } from '../reservations-messaging-settings.ts'

/** Payment-flow kinds: they follow the payment state, not a message setting. */
export type PaymentEmailKind =
	| 'payment_received'
	| 'refund_issued'
	| 'fee_charged'
	| 'fee_action_required'
	| 'late_payment_refunded'

export type MessageKind = ToggleableMessageKind | PaymentEmailKind

/**
 * Shipped guest copy for one message kind. Placeholders are `{name}` style:
 * email uses `{r}` (restaurant), `{name}`, `{date}`, `{time}`, `{amount}`,
 * `{waitSentence}`; SMS uses `{r}`, `{when}`, `{n}`, `{wait}`, `{amount}`.
 * Operators never author these; custom notes are appended separately.
 */
export type KindCopy = {
	subject: string
	heading: string
	lead: string
	/** Notify-me without a single slot time. */
	leadNoTime?: string
	ctaLabel?: string
	sms: string
	smsNoTime?: string
}

export type CopyLabels = {
	restaurant: string
	date: string
	time: string
	party: string
	address: string
	phone: string
	calendar: string
	note: string
	footer: string
	/** Name used in the greeting when the guest has none ("Hi there"). */
	guestFallback: string
	/** Unit after a wait time in email ("20 min"). */
	waitUnit: string
	/** Sentence appended to the waitlist email; `{wait}` is "20 min". */
	emailWait: string
	/** Text appended to the waitlist SMS; `{min}` is the number of minutes. */
	smsWait: string
	sampleName: string
	sampleRestaurant: string
}

export type MessageCopy = {
	kinds: Record<MessageKind, KindCopy>
	labels: CopyLabels
}

export const MESSAGE_KINDS: readonly MessageKind[] = [
	'confirmation',
	'modification',
	'cancellation_guest',
	'cancellation_restaurant',
	'reminder',
	'reconfirm_request',
	'request_received',
	'request_approved',
	'request_declined',
	'waitlist_joined',
	'waitlist_ready',
	'notify_available',
	'payment_received',
	'refund_issued',
	'fee_charged',
	'fee_action_required',
	'late_payment_refunded',
]
