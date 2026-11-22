import { ORG_PERMISSIONS, userHasOrganizationPermission } from '@repo/auth'
import { alertLocale, type AlertLocale } from '@repo/common/operator-alert-copy'
import {
	pushCategoryForNotificationType,
	type PushCategory,
} from '@repo/common/operator-alerts'
import { expoPushTokenSchema } from '@repo/common/push'
import {
	and,
	db,
	desc,
	eq,
	inArray,
	lt,
	OperatorPushDelivery,
	OperatorPushDevice,
	Organization,
	UserOrganization,
} from '@repo/database'
import {
	managerAlertKindFromNotificationType,
	managerAlertPath,
} from '@repo/staffing'
import { z } from 'zod'
import {
	inventoryAlertKindFromNotificationType,
	inventoryAlertPath,
} from '#app/utils/inventory/manager-alerts.ts'
import {
	reservationAlertKindFromNotificationType,
	reservationAlertPath,
} from '#app/utils/reservations/manager-alerts.ts'
import { filterVisibleNotifications } from '#app/utils/staffing/notification-visibility.server.ts'
import { applyAlertPolicy, recordDeliveredChannels } from './policy.server.ts'
import { loadPushPreference } from './prefs.server.ts'
import {
	getOperatorPushProvider,
	type OperatorPushMessage,
} from './push-provider.server.ts'
import { isOperatorPushEnabled } from './switches.server.ts'
import { wakeOperatorAlertsAt } from './wake.server.ts'

/**
 * Operator push (#106): the device registry and the one send path. Push MIRRORS
 * the `Notification` table: a row written for a member can also go out as a
 * push when its kind is enabled; this file adds no alert logic of its own.
 *
 * A push payload passes through Apple, Google and Expo, so it is a kind, a
 * place, an order number, a count: never a guest's name, phone, email, address,
 * notes or items. The provider message carries only `{ kind, url,
 * notificationId }` as data.
 */

export const MAX_OPERATOR_DEVICES = 10
export const PUSH_TITLE_MAX = 65
export const PUSH_BODY_MAX = 178

export const registerOperatorDeviceSchema = z.strictObject({
	token: expoPushTokenSchema,
	platform: z.enum(['ios', 'android']),
	locale: z.string().trim().min(2).max(16).default('en'),
	deviceName: z.string().trim().min(1).max(80).optional(),
	appVersion: z.string().trim().min(1).max(40).optional(),
})
export type RegisterOperatorDeviceInput = z.infer<
	typeof registerOperatorDeviceSchema
>

/**
 * Registers (or re-registers) a phone for the member. The token is unique: a
 * different member signing in on the same phone takes it over, so the previous
 * member stops getting pushes there. The oldest devices beyond the limit go.
 */
export async function registerOperatorDevice(
	userId: string,
	input: RegisterOperatorDeviceInput,
	now = new Date(),
): Promise<{ id: string; movedFromUserId: string | null }> {
	// The phone may already belong to someone else: that is a move, and the
	// caller records it (ids only), because a pushed alert follows the token.
	const [previous] = await db
		.select({ userId: OperatorPushDevice.userId })
		.from(OperatorPushDevice)
		.where(eq(OperatorPushDevice.token, input.token))
		.limit(1)
	const [device] = await db
		.insert(OperatorPushDevice)
		.values({
			userId,
			token: input.token,
			platform: input.platform,
			locale: input.locale,
			deviceName: input.deviceName ?? null,
			appVersion: input.appVersion ?? null,
			createdAt: now,
			lastSeenAt: now,
		})
		.onConflictDoUpdate({
			target: OperatorPushDevice.token,
			set: {
				userId,
				platform: input.platform,
				locale: input.locale,
				deviceName: input.deviceName ?? null,
				appVersion: input.appVersion ?? null,
				lastSeenAt: now,
			},
		})
		.returning({ id: OperatorPushDevice.id })
	const mine = await db
		.select({ id: OperatorPushDevice.id })
		.from(OperatorPushDevice)
		.where(eq(OperatorPushDevice.userId, userId))
		.orderBy(desc(OperatorPushDevice.lastSeenAt))
	const extra = mine.slice(MAX_OPERATOR_DEVICES).map((row) => row.id)
	if (extra.length > 0) {
		await db
			.delete(OperatorPushDevice)
			.where(inArray(OperatorPushDevice.id, extra))
	}
	return {
		id: device!.id,
		movedFromUserId:
			previous && previous.userId !== userId ? previous.userId : null,
	}
}

export async function listOperatorDevices(userId: string) {
	return db
		.select({
			id: OperatorPushDevice.id,
			platform: OperatorPushDevice.platform,
			deviceName: OperatorPushDevice.deviceName,
			appVersion: OperatorPushDevice.appVersion,
			createdAt: OperatorPushDevice.createdAt,
			lastSeenAt: OperatorPushDevice.lastSeenAt,
		})
		.from(OperatorPushDevice)
		.where(eq(OperatorPushDevice.userId, userId))
		.orderBy(desc(OperatorPushDevice.lastSeenAt))
}

/** Removes the member's own device by id or token (sign out, or "Remove" in Devices). */
export async function removeOperatorDevice(
	userId: string,
	which: { deviceId?: string; token?: string },
): Promise<number> {
	const target = which.deviceId
		? eq(OperatorPushDevice.id, which.deviceId)
		: which.token
			? eq(OperatorPushDevice.token, which.token)
			: null
	if (!target) return 0
	const removed = await db
		.delete(OperatorPushDevice)
		.where(and(eq(OperatorPushDevice.userId, userId), target))
		.returning({ id: OperatorPushDevice.id })
	return removed.length
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type PushCopy = { title: string; body: string }

export type PushRequest = {
	userId: string
	notificationId: string
	/** `data.kind`: the notification type. */
	kind: string
	/** Where a tap goes (the App URL), or null. */
	url: string | null
	copyFor: (locale: AlertLocale) => PushCopy
}

function clip(value: string, max: number) {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/**
 * Sends one notification to every device of the member, at most once per
 * device (the delivery row is the claim). A token the service refuses is
 * deleted at once; a send that failed releases its claim so a redelivered event
 * can try again. Returns how many devices were sent to.
 */
export async function sendPushToUser(request: PushRequest): Promise<number> {
	const devices = await db
		.select({
			id: OperatorPushDevice.id,
			token: OperatorPushDevice.token,
			locale: OperatorPushDevice.locale,
		})
		.from(OperatorPushDevice)
		.where(eq(OperatorPushDevice.userId, request.userId))
	if (devices.length === 0) return 0

	const messages: Array<OperatorPushMessage & { deviceId: string }> = []
	for (const device of devices) {
		const claim = await db
			.insert(OperatorPushDelivery)
			.values({ notificationId: request.notificationId, deviceId: device.id })
			.onConflictDoNothing()
			.returning({ id: OperatorPushDelivery.id })
		if (claim.length === 0) continue
		const copy = request.copyFor(alertLocale(device.locale))
		messages.push({
			deviceId: device.id,
			token: device.token,
			title: clip(copy.title, PUSH_TITLE_MAX),
			body: clip(copy.body, PUSH_BODY_MAX),
			data: {
				kind: request.kind,
				url: request.url,
				notificationId: request.notificationId,
			},
			messageId: claim[0]!.id,
		})
	}
	if (messages.length === 0) return 0

	let tickets
	try {
		tickets = await getOperatorPushProvider().send(
			messages.map(({ deviceId: ignoredDeviceId, ...message }) => message),
		)
	} catch {
		tickets = messages.map((message) => ({
			messageId: message.messageId,
			status: 'error' as const,
			code: 'provider_unreachable',
		}))
	}
	let sent = 0
	for (const message of messages) {
		const ticket = tickets.find((t) => t.messageId === message.messageId)
		if (ticket?.status === 'ok') {
			sent++
			await db
				.update(OperatorPushDelivery)
				.set({ status: 'sent', ticketId: ticket.ticketId })
				.where(eq(OperatorPushDelivery.id, message.messageId))
		} else if (ticket?.status === 'invalid_token') {
			// Dead token: the device goes, and its delivery rows with it.
			await db
				.delete(OperatorPushDevice)
				.where(eq(OperatorPushDevice.id, message.deviceId))
		} else {
			await db
				.delete(OperatorPushDelivery)
				.where(eq(OperatorPushDelivery.id, message.messageId))
		}
	}
	return sent
}

/** Receipts are asked for this long after the send (Expo advises at least 15 minutes). */
export const PUSH_RECEIPT_AFTER_MS = 15 * 60 * 1000
/** Delivery rows are kept this long (they only guard against duplicates). */
export const PUSH_DELIVERY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

/**
 * The receipts sweep (jobs-cron, hourly): asks the push service what became of
 * the pushes sent a while ago. A token it reports dead is deleted with its
 * device. Old delivery rows are pruned.
 */
export async function processOperatorPushReceipts(
	now = Date.now(),
): Promise<{ checked: number; removedDevices: number }> {
	const due = await db
		.select({
			id: OperatorPushDelivery.id,
			ticketId: OperatorPushDelivery.ticketId,
			deviceId: OperatorPushDelivery.deviceId,
		})
		.from(OperatorPushDelivery)
		.where(
			and(
				eq(OperatorPushDelivery.status, 'sent'),
				lt(
					OperatorPushDelivery.createdAt,
					new Date(now - PUSH_RECEIPT_AFTER_MS),
				),
			),
		)
		.limit(1000)
	let removedDevices = 0
	const withTicket = due.filter((row) => row.ticketId)
	if (withTicket.length > 0) {
		const receipts = await getOperatorPushProvider().receipts(
			withTicket.map((row) => row.ticketId!),
		)
		for (const row of withTicket) {
			const receipt = receipts.find((r) => r.ticketId === row.ticketId)
			if (!receipt) continue
			if (receipt.status === 'invalid_token') {
				const gone = await db
					.delete(OperatorPushDevice)
					.where(eq(OperatorPushDevice.id, row.deviceId))
					.returning({ id: OperatorPushDevice.id })
				removedDevices += gone.length
			} else {
				await db
					.update(OperatorPushDelivery)
					.set({
						status: receipt.status === 'delivered' ? 'delivered' : 'failed',
						checkedAt: new Date(now),
					})
					.where(eq(OperatorPushDelivery.id, row.id))
			}
		}
	}
	await db
		.delete(OperatorPushDelivery)
		.where(
			lt(
				OperatorPushDelivery.createdAt,
				new Date(now - PUSH_DELIVERY_RETENTION_MS),
			),
		)
	return { checked: withTicket.length, removedDevices }
}

// ---------------------------------------------------------------------------
// Mirroring the Notification table
// ---------------------------------------------------------------------------

const LEGACY_COPY: Record<
	Extract<
		PushCategory,
		'staff' | 'inventory' | 'reservations' | 'chat_mentions'
	>,
	Record<AlertLocale, PushCopy>
> = {
	staff: {
		en: {
			title: 'Staff alert',
			body: 'Something needs your attention in Staff.',
		},
		ar: {
			title: 'تنبيه الموظفين',
			body: 'هناك أمر يحتاج إلى انتباهك في قسم الموظفين.',
		},
	},
	inventory: {
		en: {
			title: 'Stock alert',
			body: 'Something needs your attention in Inventory.',
		},
		ar: {
			title: 'تنبيه المخزون',
			body: 'هناك أمر يحتاج إلى انتباهك في المخزون.',
		},
	},
	reservations: {
		en: {
			title: 'Reservations alert',
			body: 'Something needs your attention in Reservations.',
		},
		ar: {
			title: 'تنبيه الحجوزات',
			body: 'هناك أمر يحتاج إلى انتباهك في الحجوزات.',
		},
	},
	chat_mentions: {
		en: { title: 'You were mentioned', body: 'Open team chat to read it.' },
		ar: { title: 'تمت الإشارة إليك', body: 'افتح محادثة الفريق لقراءتها.' },
	},
}

/** The push words of a non-order notification: fixed wording, never a message or a name. */
export function legacyPushCopy(
	category: PushCategory,
	locale: AlertLocale,
	locationName?: string | null,
): PushCopy {
	const copy =
		LEGACY_COPY[category as keyof typeof LEGACY_COPY]?.[locale] ??
		LEGACY_COPY.staff[locale]
	return locationName
		? { title: copy.title, body: `${copy.body} · ${locationName}` }
		: copy
}

/** Where a tap on a non-order push goes, relative to `/<orgSlug>`. */
export function legacyPushPath(
	type: string,
	payload: Record<string, unknown>,
): string {
	const staffing = managerAlertKindFromNotificationType(type)
	if (staffing) {
		return managerAlertPath(
			staffing,
			typeof payload.scopeId === 'string' ? payload.scopeId : null,
		)
	}
	const reservations = reservationAlertKindFromNotificationType(type)
	if (reservations) return reservationAlertPath(reservations)
	const inventory = inventoryAlertKindFromNotificationType(type)
	if (inventory) return inventoryAlertPath(inventory)
	if (type === 'chat-mention') return '/chat'
	return ''
}

export type StoredNotification = {
	id: string
	userId: string
	organizationId: string
	type: string
	entityId: string
	payload: unknown
}

function parsePayload(payload: unknown): Record<string, unknown> {
	if (payload && typeof payload === 'object') {
		return payload as Record<string, unknown>
	}
	try {
		const parsed: unknown = JSON.parse(String(payload))
		return parsed && typeof parsed === 'object'
			? (parsed as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}

/**
 * Pushes the staffing, reservations, inventory and team chat notifications
 * that were just written (#106). Each row is checked at send time: the
 * organization has push on, the member is still active and could still open it,
 * the member turned that category on, and the quiet-hours, snooze and threshold
 * rules of #366 allow it now (otherwise it is logged, or held for the end of
 * quiet hours). Never throws and never blocks the caller.
 */
export async function pushStoredNotifications(
	rows: readonly StoredNotification[],
): Promise<number> {
	let pushed = 0
	const enabledOrgs = new Map<string, boolean>()
	for (const row of rows) {
		try {
			const category = pushCategoryForNotificationType(row.type)
			if (!category) continue
			let enabled = enabledOrgs.get(row.organizationId)
			if (enabled === undefined) {
				enabled = await isOperatorPushEnabled(row.organizationId)
				enabledOrgs.set(row.organizationId, enabled)
			}
			if (!enabled) continue

			const [membership] = await db
				.select({
					slug: Organization.slug,
					active: UserOrganization.active,
				})
				.from(UserOrganization)
				.innerJoin(
					Organization,
					eq(Organization.id, UserOrganization.organizationId),
				)
				.where(
					and(
						eq(UserOrganization.userId, row.userId),
						eq(UserOrganization.organizationId, row.organizationId),
					),
				)
				.limit(1)
			if (!membership?.active) continue
			const visible = await filterVisibleNotifications(row.userId, [row])
			if (visible.length === 0) continue

			const isManager = await userHasOrganizationPermission(
				row.userId,
				row.organizationId,
				ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
			)
			if (
				!(await loadPushPreference({
					organizationId: row.organizationId,
					userId: row.userId,
					category,
					isManager,
				}))
			) {
				continue
			}
			const payload = parsePayload(row.payload)
			const policy = await applyAlertPolicy({
				userId: row.userId,
				organizationId: row.organizationId,
				locationId:
					typeof payload.locationId === 'string' ? payload.locationId : null,
				kind: row.type,
				entityId: row.entityId,
				critical: false,
				notificationId: row.id,
				channelsOwed: ['push'],
			})
			if (policy.replay) continue
			if (policy.decision.outcome === 'held') {
				void wakeOperatorAlertsAt(new Date(policy.decision.until))
			}
			if (
				policy.decision.outcome !== 'deliver' &&
				policy.decision.outcome !== 'critical'
			) {
				continue
			}
			const locationName =
				typeof payload.locationName === 'string' ? payload.locationName : null
			const base = String(process.env.BASE_URL ?? '').replace(/\/$/, '')
			const path = legacyPushPath(row.type, payload)
			const sent = await sendPushToUser({
				userId: row.userId,
				notificationId: row.id,
				kind: row.type,
				url: base ? `${base}/${membership.slug}${path}` : null,
				copyFor: (locale) => legacyPushCopy(category, locale, locationName),
			})
			await recordDeliveredChannels(policy.logId, sent > 0 ? ['push'] : [])
			pushed += sent
		} catch (error) {
			console.error('Operator push failed', {
				type: row.type,
				reason: error instanceof Error ? error.name : 'unknown',
			})
		}
	}
	return pushed
}
