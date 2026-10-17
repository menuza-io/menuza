import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { type MessageLocale } from '#app/utils/reservations/messages-api.ts'

export const MESSAGE_KIND_LABELS: Record<string, MessageDescriptor> = {
	confirmation: msg`Booking confirmation`,
	modification: msg`Booking changed`,
	cancellation_guest: msg`Cancelled by the guest`,
	cancellation_restaurant: msg`Cancelled by the restaurant`,
	reminder: msg`Reminder before the booking`,
	reconfirm_request: msg`Reconfirmation request`,
	request_received: msg`Large-party request received`,
	request_approved: msg`Large-party request approved`,
	request_declined: msg`Large-party request declined`,
	waitlist_joined: msg`Waitlist: guest joined`,
	waitlist_ready: msg`Waitlist: table is ready`,
	notify_available: msg`Notify me: a table opened up`,
}

export const MESSAGE_KIND_DESCRIPTIONS: Record<string, MessageDescriptor> = {
	confirmation: msg`Sent when a booking is made, with the manage link.`,
	modification: msg`Sent when a guest or host changes the time or party size.`,
	cancellation_guest: msg`Confirms a cancellation the guest made.`,
	cancellation_restaurant: msg`Tells the guest the restaurant cancelled.`,
	reminder: msg`Sent ahead of the booking, at the lead time set below.`,
	reconfirm_request: msg`Asks the guest to confirm they are still coming.`,
	request_received: msg`Acknowledges a request that needs a manager's decision.`,
	request_approved: msg`Sent when a manager approves a request.`,
	request_declined: msg`Sent when a manager declines a request.`,
	waitlist_joined: msg`Confirms the guest is on the waitlist.`,
	waitlist_ready: msg`Tells the guest their table is ready.`,
	notify_available: msg`Tells a guest who asked to be notified that a table opened.`,
}

export const MESSAGE_LOCALE_LABELS: Record<MessageLocale, MessageDescriptor> = {
	en: msg`English`,
	ar: msg`Arabic`,
}
