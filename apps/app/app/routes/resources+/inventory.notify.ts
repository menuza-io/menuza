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
import {
	DEFAULT_INVENTORY_LOCATION_ID,
	type InventoryNotifyEvent,
	inventoryNotifyEventSchema,
	type InventoryNotifyResult,
	inventoryNotifyResultSchema,
} from '@repo/inventory'
import { type ActionFunctionArgs } from 'react-router'
import { ENV } from 'varlock/env'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { getInventoryFeatureState } from '#app/utils/inventory/access.server.ts'
import {
	loadInventoryChannelPreferences,
	resolveInventoryAlertRecipients,
} from '#app/utils/inventory/manager-alerts.server.ts'
import {
	describeInventoryAlert,
	INVENTORY_ALERT_MARKER_TYPE,
	inventoryAlertNotificationType,
	inventoryAlertPath,
} from '#app/utils/inventory/manager-alerts.ts'
import {
	displayLocationName,
	orgDefaultLocale,
} from '#app/utils/location-name.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function answer(result: InventoryNotifyResult) {
	return Response.json(inventoryNotifyResultSchema.parse(result), {
		headers: NO_STORE,
	})
}

function skipped(reason: string) {
	return answer({ inApp: 0, emailed: 0, skipped: reason })
}

function featureOn(
	features: Awaited<ReturnType<typeof getInventoryFeatureState>>,
	kind: InventoryNotifyEvent['kind'],
) {
	if (!features.enabled) return false
	// Orders and prices only exist with Purchasing.
	return kind === 'inventory_delivery_due' || kind === 'inventory_price_rise'
		? features.purchasing
		: true
}

/**
 * `POST /resources/inventory/notify`: where the regional inventory tick tells
 * managers something needs attention at a location (items below their level,
 * a count waiting for review, a delivery due, a price rise).
 *
 * The event is a kind, a location id, a count and an event id (the contract's
 * `inventoryNotifyEventSchema`, strict, so a field that could carry an item or
 * an amount is a 400 and a rejected value is never echoed). Recipients come
 * from permissions and location scope, each member's preferences apply
 * (defaults: in-app and email on), and the in-app notification carries only the
 * kind, the location id and the count.
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
		// Machine-to-machine endpoint: the 401 from internal auth is the answer.
		if (error instanceof Response && error.status === 401) return error
		throw error
	}

	const raw = await request.json().catch(() => null)
	const parsed = inventoryNotifyEventSchema.safeParse(raw)
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

	if (!featureOn(await getInventoryFeatureState(organization.id), event.kind)) {
		return skipped('feature_off')
	}

	const [{ value: locationCount } = { value: 0 }] = await db
		.select({ value: count() })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))
	let locationName: string | null = null
	if (locationCount === 0) {
		// An organization without locations keeps its stock at the implicit
		// location `main`, named after the organization: nothing to add to copy.
		if (event.locationId !== DEFAULT_INVENTORY_LOCATION_ID) {
			return skipped('unknown_location')
		}
	} else {
		const location = await db.query.OrganizationLocation.findFirst({
			where: and(
				eq(OrganizationLocation.id, event.locationId),
				eq(OrganizationLocation.organizationId, organization.id),
			),
			columns: { name: true },
		})
		if (!location) return skipped('unknown_location')
		// With one location "at <name>" would only repeat the organization.
		locationName =
			locationCount > 1
				? displayLocationName(
						location.name,
						null,
						await orgDefaultLocale(organization.id),
					)
				: null
	}

	const recipients = await resolveInventoryAlertRecipients({
		organizationId: organization.id,
		locationId: event.locationId,
		kind: event.kind,
	})
	if (recipients.length === 0) return skipped('no_recipients')

	const type = inventoryAlertNotificationType(event.kind)
	const userIds = recipients.map((recipient) => recipient.userId)
	const [preferences, alreadyHandled] = await Promise.all([
		loadInventoryChannelPreferences({
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
					inArray(Notification.type, [type, INVENTORY_ALERT_MARKER_TYPE]),
					inArray(Notification.userId, userIds),
				),
			),
	])
	const handled = new Set(alreadyHandled.map((row) => row.userId))

	const copy = describeInventoryAlert({
		kind: event.kind,
		count: event.count,
		locationName,
	})
	const baseUrl = String(ENV.BASE_URL ?? '').replace(/\/$/, '')
	const actionUrl = `${baseUrl}/${organization.slug}${inventoryAlertPath(event.kind)}`

	let inApp = 0
	let emailed = 0
	for (const recipient of recipients) {
		if (handled.has(recipient.userId)) continue
		const channels = preferences.get(recipient.userId) ?? {
			inApp: true,
			email: true,
		}
		if (!channels.inApp && !channels.email) continue

		// The row is also the claim for this event and member: a concurrent or
		// retried delivery that loses the insert sends nothing.
		const claimed = await db
			.insert(Notification)
			.values({
				userId: recipient.userId,
				organizationId: organization.id,
				type: channels.inApp ? type : INVENTORY_ALERT_MARKER_TYPE,
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

		if (channels.email) {
			let sent = false
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
					console.error('Failed to send inventory alert email')
				} else {
					sent = true
					emailed++
				}
			} catch {
				console.error('Failed to send inventory alert email')
			}
			if (!sent && !channels.inApp && claimed[0]?.id) {
				await db.delete(Notification).where(eq(Notification.id, claimed[0].id))
			}
		}
	}

	return answer({ inApp, emailed })
}
