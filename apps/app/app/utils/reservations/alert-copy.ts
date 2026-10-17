import { msg, plural } from '@lingui/macro'
import { type ReservationAlertKind } from '#app/utils/reservations/manager-alerts.ts'

type Translate = (message: any) => string
type Message = { id: string; message: string }

/**
 * Wording for a reservations alert in the notification bell. The notification
 * carries a kind, a count and at most a location name, so that is all it can
 * say; the guests are read in Reservations after opening it.
 */
export function reservationAlertCopy(
	kind: ReservationAlertKind,
	count: number,
	_: Translate,
	locationName?: string | null,
): { subject: string; body: string } {
	const n = Math.max(1, Math.floor(count) || 1)
	const { subject, step } = describe(kind, n, _)
	const body = locationName
		? `${step}\n\n${_(msg`Location: ${locationName}` as Message)}`
		: step
	return { subject, body }
}

function describe(kind: ReservationAlertKind, n: number, _: Translate) {
	switch (kind) {
		case 'large_party_request':
			return {
				subject: _(
					plural(n, {
						one: '# large-party request is waiting',
						other: '# large-party requests are waiting',
					}),
				),
				step: _(msg`Open Today to approve or decline.` as Message),
			}
		case 'waitlist_remote_join':
			return {
				subject: _(
					plural(n, {
						one: '# guest joined the waitlist remotely',
						other: '# guests joined the waitlist remotely',
					}),
				),
				step: _(msg`Open the waitlist to see who is waiting.` as Message),
			}
		case 'unassigned_conflict':
			return {
				subject: _(
					plural(n, {
						one: '# booking no longer has a table',
						other: '# bookings no longer have a table',
					}),
				),
				step: _(msg`Open Today to assign a table.` as Message),
			}
		case 'payment_failed':
			return {
				subject: _(
					plural(n, {
						one: '# booking has a failed payment',
						other: '# bookings have a failed payment',
					}),
				),
				step: _(msg`Open Today to review the bookings.` as Message),
			}
		case 'payment_review':
			return {
				subject: _(
					plural(n, {
						one: '# booking needs a payment review',
						other: '# bookings need a payment review',
					}),
				),
				step: _(msg`Open Today to review the bookings.` as Message),
			}
		case 'dispute_opened':
			return {
				subject: _(
					plural(n, {
						one: '# payment dispute was opened',
						other: '# payment disputes were opened',
					}),
				),
				step: _(
					msg`Respond with your payment provider before the deadline.` as Message,
				),
			}
		case 'message_failed_bulk':
			return {
				subject: _(
					plural(n, {
						one: '# guest message could not be delivered',
						other: '# guest messages could not be delivered',
					}),
				),
				step: _(msg`Open Today to check on the affected guests.` as Message),
			}
	}
}
