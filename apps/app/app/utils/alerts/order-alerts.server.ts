import { ORG_PERMISSIONS } from '@repo/auth'
import {
	alertCopy,
	alertPath,
	alertSettingsNote,
	alertSmsText,
	type AlertSubject,
} from '@repo/common/operator-alert-copy'
import {
	type defaultAlertChannels,
	isCriticalAlert,
	ORDER_ALERT_PUSH_CATEGORY,
	ORDER_ALERT_MARKER_TYPE,
	ORDER_ALERT_HOURS_MARGIN_MS,
	STATION_ALERT_HOURS_MARGIN_MS,
	orderAlertNotificationType,
	type OrderAlertKind,
	type OrdersNotifyEvent,
	type OrdersNotifyResult,
	type PushCategory,
} from '@repo/common/operator-alerts'
import {
	and,
	db,
	eq,
	Notification,
	Organization,
	OrganizationLocation,
	AlertLog,
} from '@repo/database'
import { sendEmail, StaffingAlertEmail } from '@repo/email'
import { ENV } from 'varlock/env'
import {
	displayLocationName,
	orgDefaultLocale,
} from '#app/utils/location-name.server.ts'
import { resolveAlertMembers, type AlertMember } from './members.server.ts'
import {
	applyAlertPolicy,
	markAlertsDropped,
	recordDeliveredChannels,
	type AlertChannel,
} from './policy.server.ts'
import { loadOrderAlertPrefs } from './prefs.server.ts'
import { sendPushToUser } from './push.server.ts'
import {
	resolveLocationRecipients,
	type RecipientTopic,
} from './recipients.server.ts'
import {
	isOperatorPushEnabled,
	isOrderAlertEmailAllowed,
	isOrderAlertSmsSwitchOn,
	isOrderAlertsEnabled,
} from './switches.server.ts'
import { alertTextsAvailable, getAlertTextProvider } from './text.server.ts'
import { wakeOperatorAlertsAt } from './wake.server.ts'
import { alertWindowState } from './window.ts'

/**
 * The delivery of an order or tablet alert (#131, #241, #300, #190, and the
 * order half of #106): one function from "something needs attention at this
 * location" to a notification row, an email, a push and a text, through the
 * single quiet-hours, snooze and threshold policy (#366). It is the same
 * `Notification` table and the same notify-route pattern as staffing,
 * reservations and inventory; there is no second engine.
 *
 * Nothing it handles can name a guest: the event is ids, an order number, a
 * count, a time and a total (`ordersNotifyEventSchema` is strict).
 */

export type AlertOrganization = {
	id: string
	slug: string
	name: string
	dataRegion: string
}

export type AlertLocation = {
	id: string
	name: string
	timezone: string | null
	storeHours: string | null
	onlineHours: string | null
	specialHours: string | null
	isActive: boolean
}

export async function loadAlertOrganization(
	organizationId: string,
): Promise<AlertOrganization | null> {
	const [row] = await db
		.select({
			id: Organization.id,
			slug: Organization.slug,
			name: Organization.name,
			dataRegion: Organization.dataRegion,
		})
		.from(Organization)
		.where(
			and(
				eq(Organization.id, organizationId),
				eq(Organization.active, true),
				eq(Organization.hasProvisionedDb, true),
			),
		)
		.limit(1)
	return row ? { ...row, dataRegion: row.dataRegion || 'us' } : null
}

export async function loadAlertLocation(
	organizationId: string,
	locationId: string,
): Promise<AlertLocation | null> {
	const [row] = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
			timezone: OrganizationLocation.timezone,
			storeHours: OrganizationLocation.storeHours,
			onlineHours: OrganizationLocation.onlineHours,
			specialHours: OrganizationLocation.specialHours,
			isActive: OrganizationLocation.isActive,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.id, locationId),
				eq(OrganizationLocation.organizationId, organizationId),
			),
		)
		.limit(1)
	return row ?? null
}

/** One alert, built from an event (or from the pause job), ready to deliver. */
export type AlertRequest = {
	kind: OrderAlertKind
	entityId: string
	locationId: string | null
	subject: AlertSubject
	critical: boolean
	/** The permission a member needs to be told. */
	permission: string
	/**
	 * Opening hours plus this on each side; null means no hours check. With
	 * `strictHours` a location with no hours set is not alerted either.
	 */
	hoursMarginMs: number | null
	strictHours?: boolean
	/** Which switch of a chosen recipient this alert is for; null: members only. */
	recipientTopic: RecipientTopic | null
	test?: boolean
}

export function requestsFromEvent(event: OrdersNotifyEvent): AlertRequest[] {
	const ordersPermission = ORG_PERMISSIONS.READ_MENU_ANY
	switch (event.kind) {
		case 'order_placed': {
			const topic: RecipientTopic =
				event.scheduledForMs === null ? 'online' : 'scheduled'
			const facts = {
				orderNumber: event.orderNumber,
				fulfillment: event.fulfillment,
				scheduledForMs: event.scheduledForMs,
				totalCents: event.totalCents,
				currency: event.currency,
				dishCount: event.dishCount,
			}
			const common = {
				entityId: event.eventId,
				locationId: event.locationId,
				critical: false,
				permission: ordersPermission,
				hoursMarginMs: null,
				recipientTopic: topic,
			}
			const newOrder: AlertRequest = {
				...common,
				kind: 'orders_new',
				subject: { kind: 'orders_new', ...facts, large: event.large },
			}
			if (!event.large) return [newOrder]
			// A large order is told as a large order, once: the large alert comes
			// first and a member who has it off falls back to the new-order one.
			return [
				{
					...common,
					kind: 'orders_large',
					subject: { kind: 'orders_large', ...facts, soon: false },
				},
				newOrder,
			]
		}
		case 'large_order_soon':
			return [
				{
					kind: 'orders_large',
					entityId: event.eventId,
					locationId: event.locationId,
					subject: {
						kind: 'orders_large',
						orderNumber: event.orderNumber,
						fulfillment: event.fulfillment,
						scheduledForMs: event.scheduledForMs,
						totalCents: event.totalCents,
						currency: event.currency,
						dishCount: event.dishCount,
						soon: true,
					},
					critical: false,
					permission: ordersPermission,
					hoursMarginMs: null,
					recipientTopic: 'scheduled',
				},
			]
		case 'orders_waiting':
			return [
				{
					kind: 'orders_waiting',
					entityId: event.eventId,
					locationId: event.locationId,
					subject: { kind: 'orders_waiting', orderNumbers: event.orderNumbers },
					critical: false,
					permission: ordersPermission,
					hoursMarginMs: ORDER_ALERT_HOURS_MARGIN_MS,
					// The reminder to the people a location chose: once per order.
					recipientTopic: 'online',
				},
			]
		case 'orders_due_soon':
			return [
				{
					kind: 'orders_due_soon',
					entityId: event.eventId,
					locationId: event.locationId,
					subject: {
						kind: 'orders_due_soon',
						orderNumbers: event.orderNumbers,
						dueAtMs: event.dueAtMs,
					},
					critical: false,
					permission: ordersPermission,
					hoursMarginMs: ORDER_ALERT_HOURS_MARGIN_MS,
					recipientTopic: 'scheduled',
				},
			]
		case 'orders_payment_review':
			return [
				{
					kind: 'orders_payment_review',
					entityId: event.eventId,
					locationId: event.locationId,
					subject: {
						kind: 'orders_payment_review',
						orderNumber: event.orderNumber,
					},
					critical: true,
					permission: ordersPermission,
					hoursMarginMs: null,
					recipientTopic: null,
				},
			]
		case 'order_problem':
			// A guest's report about an order (#191): the kind is a fixed word, the
			// order a number. The note, the photo and the items stay in the region.
			return [
				{
					kind: 'orders_problem',
					entityId: event.eventId,
					locationId: event.locationId,
					subject: {
						kind: 'orders_problem',
						orderNumber: event.orderNumber,
						problemKind: event.problemKind,
						unanswered: event.unanswered,
					},
					critical: false,
					permission: ordersPermission,
					hoursMarginMs: ORDER_ALERT_HOURS_MARGIN_MS,
					recipientTopic: null,
				},
			]
		case 'station_offline': {
			const critical = isCriticalAlert('station_offline', {
				allKitchenTabletsOffline: event.allKitchenOffline,
			})
			return [
				{
					kind: 'station_offline',
					entityId: event.eventId,
					locationId: event.locationId,
					subject: {
						kind: 'station_offline',
						label: event.deviceLabel,
						state: event.state,
						minutes: event.minutes,
						allKitchenOffline: event.allKitchenOffline,
						waitingOrderNumber: event.waitingOrderNumber,
					},
					critical,
					permission: ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
					// An order that just arrived is its own proof someone is there, and
					// "back online" closes an outage whatever the hour; a plain outage
					// alerts only in opening hours plus half an hour (no hours: never).
					hoursMarginMs:
						event.state === 'offline' && !event.allKitchenOffline
							? STATION_ALERT_HOURS_MARGIN_MS
							: null,
					strictHours: true,
					recipientTopic: null,
				},
			]
		}
	}
}

export function alertAppUrl(orgSlug: string, kind: OrderAlertKind) {
	const base = String(ENV.BASE_URL ?? '').replace(/\/$/, '')
	return `${base}/${orgSlug}${alertPath(kind)}`
}

/** The alert for ordering paused or busy mode left on too long (#131), once per pause. */
export function requestsFromPause(input: {
	locationId: string
	mode: 'paused' | 'busy'
	/** When the pause or busy mode started (epoch ms): the key, so one alert per pause. */
	since: number
	now: number
}): AlertRequest[] {
	const hours = Math.max(1, Math.floor((input.now - input.since) / 3_600_000))
	return [
		{
			kind: 'ordering_paused_long',
			entityId: `${input.mode}:${input.locationId}:${input.since}`,
			locationId: input.locationId,
			subject: { kind: 'ordering_paused_long', mode: input.mode, hours },
			critical: false,
			permission: ORG_PERMISSIONS.READ_MENU_ANY,
			hoursMarginMs: ORDER_ALERT_HOURS_MARGIN_MS,
			recipientTopic: null,
		},
	]
}

function appUrl(organization: AlertOrganization, request: AlertRequest) {
	return alertAppUrl(organization.slug, request.kind)
}

/** What the bell stores: facts only, enough to rebuild any channel's wording later. */
export function alertNotificationPayload(input: {
	organization: AlertOrganization
	locationId: string | null
	locationName: string | null
	timeZone: string | null
	request: AlertRequest
}) {
	return {
		kind: input.request.kind,
		orgSlug: input.organization.slug,
		locationId: input.locationId,
		locationName: input.locationName,
		timeZone: input.timeZone,
		subject: input.request.subject,
		...(input.request.test ? { test: true } : {}),
	}
}

type Delivered = {
	inApp: number
	emailed: number
	pushed: number
	texted: number
}

function emptyCounts(): Delivered {
	return { inApp: 0, emailed: 0, pushed: 0, texted: 0 }
}

export async function sendAlertEmail(
	to: string,
	copy: ReturnType<typeof alertCopy>,
	url: string,
): Promise<boolean> {
	try {
		const result = await sendEmail({
			to,
			subject: copy.subject,
			react: StaffingAlertEmail({
				eyebrow: copy.eyebrow,
				headline: copy.headline,
				detail: copy.detail,
				actionLabel: copy.actionLabel,
				actionUrl: url,
				settingsNote: alertSettingsNote('en'),
			}),
		})
		return result.status !== 'error'
	} catch {
		return false
	}
}

/**
 * Delivers one alert (the first of `requests` a member has switched on) to
 * every member who may be told, then to the location's chosen recipients.
 * Idempotent per member and per recipient: the alert log's unique key is the
 * claim, so a redelivered event sends nothing twice.
 */
export async function deliverOrderAlert(input: {
	organization: AlertOrganization
	location: AlertLocation | null
	requests: AlertRequest[]
	now?: number
}): Promise<OrdersNotifyResult> {
	const now = input.now ?? Date.now()
	const { organization, location, requests } = input
	const counts = emptyCounts()
	const first = requests[0]
	if (!first) return { ...counts, skipped: 'nothing_to_send' }

	if (!(await isOrderAlertsEnabled(organization.id))) {
		return { ...counts, skipped: 'feature_off' }
	}
	if (location && first.hoursMarginMs !== null) {
		const state = alertWindowState(location, now, first.hoursMarginMs)
		if (state === 'outside' || (state === 'unknown' && first.strictHours)) {
			return { ...counts, skipped: 'outside_hours' }
		}
	}

	const locale = await orgDefaultLocale(organization.id)
	const locationName = location
		? displayLocationName(location.name, null, locale)
		: null
	const timeZone = location?.timezone ?? null

	const members = await resolveAlertMembers({
		organizationId: organization.id,
		permission: first.permission,
		locationId: first.locationId,
	})
	const pushOn = await isOperatorPushEnabled(organization.id)
	const emailOn = isOrderAlertEmailAllowed()

	// Preferences of every kind in the list, per member.
	const prefsByKind = new Map<
		OrderAlertKind,
		Awaited<ReturnType<typeof loadOrderAlertPrefs>>
	>()
	for (const request of requests) {
		prefsByKind.set(
			request.kind,
			await loadOrderAlertPrefs({
				organizationId: organization.id,
				kind: request.kind,
				members,
				category: ORDER_ALERT_PUSH_CATEGORY[request.kind],
			}),
		)
	}

	for (const member of members) {
		// The first request this member has any channel on for.
		let chosen: {
			request: AlertRequest
			channels: ReturnType<typeof defaultAlertChannels> & { push: boolean }
		} | null = null
		for (const request of requests) {
			const prefs = prefsByKind.get(request.kind)?.get(member.userId)
			if (!prefs) continue
			const channels = request.critical
				? { inApp: true, email: true, push: true }
				: prefs
			if (channels.inApp || channels.email || channels.push) {
				chosen = { request, channels }
				break
			}
		}
		if (!chosen) continue
		await deliverToMember({
			organization,
			location,
			locationName,
			timeZone,
			member,
			request: chosen.request,
			channels: chosen.channels,
			pushOn,
			emailOn,
			now,
			counts,
		})
	}

	await deliverToRecipients({
		organization,
		locationName,
		timeZone,
		request: first.recipientTopic ? requests[0]! : null,
		locationId: first.locationId,
		now,
		counts,
	})
	return { ...counts }
}

async function deliverToMember(input: {
	organization: AlertOrganization
	location: AlertLocation | null
	locationName: string | null
	timeZone: string | null
	member: AlertMember
	request: AlertRequest
	channels: { inApp: boolean; email: boolean; push: boolean }
	pushOn: boolean
	emailOn: boolean
	now: number
	counts: Delivered
}) {
	const { organization, member, request, channels, now, counts } = input
	const wantsEmail = channels.email && input.emailOn
	const wantsPush = channels.push && input.pushOn
	const owed: AlertChannel[] = [
		...(wantsEmail ? (['email'] as const) : []),
		...(wantsPush ? (['push'] as const) : []),
	]
	const applied = await applyAlertPolicy({
		userId: member.userId,
		organizationId: organization.id,
		locationId: request.locationId,
		kind: request.kind,
		entityId: request.entityId,
		critical: request.critical,
		channelsOwed: owed,
		now,
	})
	// Logged before: a redelivered event, or one below the member's threshold,
	// sends nothing (the log keeps the occurrence).
	if (applied.replay || applied.decision.outcome === 'below_threshold') return
	// Held for the end of quiet hours: ask jobs-cron to wake the App then.
	if (applied.decision.outcome === 'held') {
		void wakeOperatorAlertsAt(new Date(applied.decision.until))
	}

	const type = orderAlertNotificationType(request.kind)
	const payload = alertNotificationPayload({
		organization,
		locationId: request.locationId,
		locationName: input.locationName,
		timeZone: input.timeZone,
		request,
	})
	// The row is the in-app alert, and the claim for the other channels when the
	// member has in-app off (then it is a hidden, already-read marker).
	const [notification] = await db
		.insert(Notification)
		.values({
			userId: member.userId,
			organizationId: organization.id,
			type: channels.inApp ? type : ORDER_ALERT_MARKER_TYPE,
			entityId: `${request.kind}:${request.entityId}`,
			payload: JSON.stringify(channels.inApp ? payload : {}),
			isRead: !channels.inApp,
			isSeen: !channels.inApp,
		})
		.onConflictDoNothing()
		.returning({ id: Notification.id })
	if (!notification) return
	if (channels.inApp) counts.inApp++

	const delivered: AlertChannel[] = channels.inApp ? ['in_app'] : []
	const outcome = applied.decision.outcome
	if (outcome === 'deliver' || outcome === 'critical') {
		const url = appUrl(organization, request)
		if (wantsEmail) {
			const copy = alertCopy(request.subject, {
				locale: 'en',
				locationName: input.locationName,
				timeZone: input.timeZone,
				test: request.test,
			})
			if (await sendAlertEmail(member.email, copy, url)) {
				counts.emailed++
				delivered.push('email')
			}
		}
		if (wantsPush) {
			const sent = await sendPushToUser({
				userId: member.userId,
				notificationId: notification.id,
				kind: type,
				url,
				copyFor: (locale) => {
					const copy = alertCopy(request.subject, {
						locale,
						locationName: input.locationName,
						timeZone: input.timeZone,
						test: request.test,
					})
					return { title: copy.title, body: copy.body }
				},
			})
			if (sent > 0) {
				counts.pushed++
				delivered.push('push')
			}
		}
	}
	await recordDeliveredChannels(applied.logId, delivered, {
		notificationId: notification.id,
	})
}

async function deliverToRecipients(input: {
	organization: AlertOrganization
	locationName: string | null
	timeZone: string | null
	request: AlertRequest | null
	locationId: string | null
	now: number
	counts: Delivered
}) {
	const { organization, request, counts } = input
	if (!request || !request.recipientTopic || !input.locationId) return
	const recipients = await resolveLocationRecipients({
		organizationId: organization.id,
		locationId: input.locationId,
		topic: request.recipientTopic,
		dataRegion: organization.dataRegion,
	})
	if (recipients.length === 0) return
	const copy = alertCopy(request.subject, {
		locale: 'en',
		locationName: input.locationName,
		timeZone: input.timeZone,
		test: request.test,
	})
	const url = appUrl(organization, request)
	const emailOn = isOrderAlertEmailAllowed()
	const smsOn =
		isOrderAlertSmsSwitchOn() && alertTextsAvailable(organization.dataRegion)
	for (const recipient of recipients) {
		// One alert per order per recipient: the log's unique key is the claim.
		const claimed = await db
			.insert(AlertLog)
			.values({
				organizationId: organization.id,
				recipientId: recipient.id,
				locationId: input.locationId,
				kind: request.kind,
				entityId: request.entityId,
				outcome: 'delivered',
				critical: false,
				channels: '[]',
				createdAt: new Date(input.now),
			})
			.onConflictDoNothing()
			.returning({ id: AlertLog.id })
		const logId = claimed[0]?.id
		if (!logId) continue
		if (recipient.kind === 'email') {
			if (!emailOn) {
				await markAlertsDropped([logId])
				continue
			}
			if (await sendAlertEmail(recipient.address, copy, url)) {
				counts.emailed++
				await recordDeliveredChannels(logId, ['email'])
			}
			continue
		}
		if (!smsOn) {
			await markAlertsDropped([logId])
			continue
		}
		const result = await getAlertTextProvider().send({
			orgId: organization.id,
			to: recipient.address,
			text: alertSmsText(copy, url),
		})
		if (result.ok) {
			counts.texted++
			await recordDeliveredChannels(logId, ['sms'])
		}
	}
}

export type { PushCategory }
