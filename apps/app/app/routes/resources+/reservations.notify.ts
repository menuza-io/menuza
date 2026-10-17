import {
	and,
	count,
	db,
	eq,
	inArray,
	Notification,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { StaffingAlertEmail, sendEmail } from '@repo/email'
import { type ActionFunctionArgs } from 'react-router'
import { ENV } from 'varlock/env'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	displayLocationName,
	orgDefaultLocale,
} from '#app/utils/location-name.server.ts'
import { isReservationsFeatureEnabled } from '#app/utils/reservations/access.server.ts'
import { isReservationsEmailEnabled } from '#app/utils/reservations/email-switch.server.ts'
import {
	loadReservationChannelPreferences,
	resolveReservationAlertRecipients,
} from '#app/utils/reservations/manager-alerts.server.ts'
import {
	describeReservationAlert,
	RESERVATION_ALERT_MARKER_TYPE,
	reservationAlertEventSchema,
	reservationAlertNotificationType,
	reservationAlertPath,
	type ReservationAlertResult,
} from '#app/utils/reservations/manager-alerts.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function answer(result: ReservationAlertResult) {
	return Response.json(result, { headers: NO_STORE })
}

function skipped(reason: string) {
	return answer({ inApp: 0, emailed: 0, skipped: reason })
}

/**
 * `POST /resources/reservations/notify`: where the regional tick tells managers
 * something in Reservations needs attention at a location (a large-party
 * request, a failed payment, a burst of undelivered messages).
 *
 * The event is a kind, a location id, a count and an event id; the schema is
 * strict, so a field that could carry a guest is a 400 and a rejected value is
 * never echoed. Recipients come from permissions and location scope, each
 * member's preferences apply (defaults: in-app and email on), the in-app
 * notification carries only the kind, the location id and the count, and the
 * guests are read in the app after the manager opens the item.
 *
 * Authenticated with `INTERNAL_COMMAND_TOKEN` only. Idempotent per event id and
 * member. A flag that is off, an unknown location or nobody to tell answers 200
 * with a `skipped` reason, so the node stops retrying what cannot succeed.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		// Machine-to-machine endpoint: a plain 401 instead of the browser redirect.
		if (error instanceof Response && error.status === 302) {
			return new Response('Unauthorized', { status: 401 })
		}
		throw error
	}

	const raw = await request.json().catch(() => null)
	const parsed = reservationAlertEventSchema.safeParse(raw)
	if (!parsed.success) {
		return Response.json(
			{
				error: 'invalid_request',
				issues: parsed.error.issues.slice(0, 10).map((issue) => ({
					path: issue.path.join('.'),
					code: issue.code,
				})),
			},
			{ status: 400, headers: NO_STORE },
		)
	}
	const event = parsed.data

	const organization = await db.query.Organization.findFirst({
		where: and(
			eq(Organization.id, event.orgId),
			eq(Organization.active, true),
			eq(Organization.hasProvisionedDb, true),
		),
		columns: { id: true, slug: true },
	})
	if (!organization) {
		return Response.json(
			{ error: 'org_not_found' },
			{ status: 404, headers: NO_STORE },
		)
	}

	if (!(await isReservationsFeatureEnabled(organization.id))) {
		return skipped('feature_off')
	}

	const location = await db.query.OrganizationLocation.findFirst({
		where: and(
			eq(OrganizationLocation.id, event.locationId),
			eq(OrganizationLocation.organizationId, organization.id),
		),
		columns: { name: true },
	})
	if (!location) return skipped('unknown_location')
	const [{ value: locationCount } = { value: 0 }] = await db
		.select({ value: count() })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))
	// With one location "at <name>" would only repeat the organization.
	const locationName =
		locationCount > 1
			? displayLocationName(
					location.name,
					null,
					await orgDefaultLocale(organization.id),
				)
			: null

	const recipients = await resolveReservationAlertRecipients({
		organizationId: organization.id,
		locationId: event.locationId,
	})
	if (recipients.length === 0) return skipped('no_recipients')

	const type = reservationAlertNotificationType(event.kind)
	const userIds = recipients.map((recipient) => recipient.userId)
	const [preferences, alreadyHandled] = await Promise.all([
		loadReservationChannelPreferences({
			organizationId: organization.id,
			kind: event.kind,
			userIds,
		}),
		db
			.select({ userId: Notification.userId })
			.from(Notification)
			.where(
				and(
					eq(Notification.organizationId, organization.id),
					eq(Notification.entityId, event.eventId),
					inArray(Notification.type, [type, RESERVATION_ALERT_MARKER_TYPE]),
					inArray(Notification.userId, userIds),
				),
			),
	])
	const handled = new Set(alreadyHandled.map((row) => row.userId))

	const copy = describeReservationAlert({
		kind: event.kind,
		count: event.count,
		locationName,
	})
	const baseUrl = String(ENV.BASE_URL ?? '').replace(/\/$/, '')
	const actionUrl = `${baseUrl}/${organization.slug}${reservationAlertPath(event.kind)}`
	const emailAllowed = isReservationsEmailEnabled()

	let inApp = 0
	let emailed = 0
	for (const recipient of recipients) {
		if (handled.has(recipient.userId)) continue
		const channels = preferences.get(recipient.userId) ?? {
			inApp: true,
			email: true,
		}
		const wantsEmail = channels.email && emailAllowed
		if (!channels.inApp && !wantsEmail) continue

		// The row is also the claim for this event and member: a concurrent or
		// retried delivery that loses the insert sends nothing.
		const claimed = await db
			.insert(Notification)
			.values({
				userId: recipient.userId,
				organizationId: organization.id,
				type: channels.inApp ? type : RESERVATION_ALERT_MARKER_TYPE,
				entityId: event.eventId,
				payload: JSON.stringify(
					channels.inApp
						? {
								kind: event.kind,
								locationId: event.locationId,
								count: event.count,
								orgSlug: organization.slug,
								...(locationName ? { locationName } : {}),
							}
						: {},
				),
				isRead: !channels.inApp,
				isSeen: !channels.inApp,
			})
			.onConflictDoNothing()
			.returning({ id: Notification.id })
		if (claimed.length === 0) continue
		if (channels.inApp) inApp++

		if (wantsEmail) {
			try {
				const result = await sendEmail({
					to: recipient.email,
					subject: copy.subject,
					react: StaffingAlertEmail({
						eyebrow: copy.eyebrow,
						headline: copy.headline,
						detail: copy.detail,
						actionLabel: copy.actionLabel,
						actionUrl,
						settingsNote:
							'You can change these alerts in your notification settings.',
					}),
				})
				if (result.status === 'error') {
					console.error('Failed to send reservations alert email')
				} else {
					emailed++
				}
			} catch {
				console.error('Failed to send reservations alert email')
			}
		}
	}

	return answer({ inApp, emailed })
}
