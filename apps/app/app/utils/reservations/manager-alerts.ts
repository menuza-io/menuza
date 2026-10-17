import {
	grantsSatisfying,
	RESERVATIONS_PERMISSIONS,
	type ReservationsPermission,
} from '@repo/reservations'
import { z } from 'zod'

/**
 * Manager alerts raised by the regional reservations tick. An alert is a kind,
 * a location id and a count: nothing about a guest ever crosses to the control
 * plane, so none can be stored, shown or emailed here.
 */

export const RESERVATION_ALERT_KINDS = [
	'large_party_request',
	'waitlist_remote_join',
	'unassigned_conflict',
	'payment_failed',
	'payment_review',
	'dispute_opened',
	'message_failed_bulk',
] as const
export type ReservationAlertKind = (typeof RESERVATION_ALERT_KINDS)[number]

const opaqueIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, 'Invalid id')

export const reservationAlertEventSchema = z
	.object({
		orgId: opaqueIdSchema,
		eventId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, 'Invalid event id'),
		kind: z.enum(RESERVATION_ALERT_KINDS),
		locationId: opaqueIdSchema,
		count: z.number().int().min(1).max(10_000),
	})
	.strict()
export type ReservationAlertEvent = z.infer<typeof reservationAlertEventSchema>

export const reservationAlertResultSchema = z
	.object({
		inApp: z.number().int().nonnegative(),
		emailed: z.number().int().nonnegative(),
		skipped: z.string().max(64).optional(),
	})
	.strict()
export type ReservationAlertResult = z.infer<
	typeof reservationAlertResultSchema
>

export function reservationAlertWorkflow(kind: ReservationAlertKind) {
	return `reservations.${kind}` as const
}

export const RESERVATION_ALERT_WORKFLOWS = [
	'reservations.large_party_request',
	'reservations.waitlist_remote_join',
	'reservations.unassigned_conflict',
	'reservations.payment_failed',
	'reservations.payment_review',
	'reservations.dispute_opened',
	'reservations.message_failed_bulk',
] as const satisfies readonly ReturnType<typeof reservationAlertWorkflow>[]

export function isReservationAlertWorkflow(value: unknown): boolean {
	return (
		typeof value === 'string' &&
		(RESERVATION_ALERT_WORKFLOWS as readonly string[]).includes(value)
	)
}

export const RESERVATION_ALERT_TYPE_PREFIX = 'reservations-'

/**
 * Written for members who chose email only, so a retried delivery does not
 * email them twice. Already read and seen, and never listed.
 */
export const RESERVATION_ALERT_MARKER_TYPE = 'reservations-email-sent'

export function reservationAlertNotificationType(kind: ReservationAlertKind) {
	return `${RESERVATION_ALERT_TYPE_PREFIX}${kind.replaceAll('_', '-')}` as const
}

export function reservationAlertKindFromNotificationType(
	type: unknown,
): ReservationAlertKind | null {
	if (typeof type !== 'string') return null
	return (
		RESERVATION_ALERT_KINDS.find(
			(kind) => reservationAlertNotificationType(kind) === type,
		) ?? null
	)
}

/** Members holding one of these (a stronger grant counts) may be told. */
export const RESERVATION_ALERT_GRANTS: readonly ReservationsPermission[] = [
	...new Set([
		...grantsSatisfying(RESERVATIONS_PERMISSIONS.READ_RESERVATION),
		RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
	]),
]

export function reservationAlertPath(kind: ReservationAlertKind): string {
	return kind === 'waitlist_remote_join'
		? '/reservations/waitlist'
		: '/reservations/today'
}

export type ReservationAlertCopy = {
	eyebrow: string
	subject: string
	headline: string
	detail: string
	actionLabel: string
}

function bookings(count: number): string {
	return count === 1 ? '1 booking' : `${count} bookings`
}

/** Plain English for the email. The in-app copy is translated in the bell. */
export function describeReservationAlert(input: {
	kind: ReservationAlertKind
	count: number
	locationName: string | null
}): ReservationAlertCopy {
	const { kind, count } = input
	const place = input.locationName ? ` at ${input.locationName}` : ''
	switch (kind) {
		case 'large_party_request':
			return {
				eyebrow: 'Reservations',
				subject:
					count === 1
						? `A large-party request is waiting${place}`
						: `${count} large-party requests are waiting${place}`,
				headline:
					count === 1
						? 'A large-party request is waiting'
						: `${count} large-party requests are waiting`,
				detail: `${count === 1 ? 'A request needs' : `${count} requests need`} your decision${place}. Open Today to review ${count === 1 ? 'it' : 'them'}.`,
				actionLabel: 'Review requests',
			}
		case 'waitlist_remote_join':
			return {
				eyebrow: 'Waitlist',
				subject:
					count === 1
						? `A guest joined the waitlist remotely${place}`
						: `${count} guests joined the waitlist remotely${place}`,
				headline:
					count === 1
						? 'A guest joined the waitlist remotely'
						: `${count} guests joined the waitlist remotely`,
				detail: `${count === 1 ? 'A party was' : `${count} parties were`} added to the waitlist from the website${place}.`,
				actionLabel: 'Open the waitlist',
			}
		case 'unassigned_conflict':
			return {
				eyebrow: 'Reservations',
				subject: `${bookings(count)} no longer ${count === 1 ? 'has' : 'have'} a table${place}`,
				headline: `${bookings(count)} no longer ${count === 1 ? 'has' : 'have'} a table`,
				detail: `${bookings(count)}${place} could not keep ${count === 1 ? 'its' : 'their'} table after a change and ${count === 1 ? 'needs' : 'need'} one assigned.`,
				actionLabel: 'Assign tables',
			}
		case 'payment_failed':
			return {
				eyebrow: 'Payments',
				subject: `${bookings(count)} ${count === 1 ? 'has' : 'have'} a failed payment${place}`,
				headline: `${bookings(count)} ${count === 1 ? 'has' : 'have'} a failed payment`,
				detail: `A deposit or fee could not be collected for ${bookings(count)}${place}.`,
				actionLabel: 'Review reservations',
			}
		case 'payment_review':
			return {
				eyebrow: 'Payments',
				subject: `${bookings(count)} ${count === 1 ? 'needs' : 'need'} a payment review${place}`,
				headline: `${bookings(count)} ${count === 1 ? 'needs' : 'need'} a payment review`,
				detail: `A payment on ${bookings(count)}${place} needs a decision before it can settle.`,
				actionLabel: 'Review reservations',
			}
		case 'dispute_opened':
			return {
				eyebrow: 'Payments',
				subject:
					count === 1
						? `A payment dispute was opened${place}`
						: `${count} payment disputes were opened${place}`,
				headline:
					count === 1
						? 'A payment dispute was opened'
						: `${count} payment disputes were opened`,
				detail: `${count === 1 ? 'A guest disputed a payment' : `${count} payments were disputed`}${place}. Respond with your payment provider before the deadline.`,
				actionLabel: 'Review reservations',
			}
		case 'message_failed_bulk':
			return {
				eyebrow: 'Messages',
				subject: `${count} guest messages could not be delivered${place}`,
				headline: `${count} guest messages could not be delivered`,
				detail: `${count} confirmations or reminders${place} failed to send in the last few minutes. Guests may not have received them.`,
				actionLabel: 'Open Today',
			}
	}
}
