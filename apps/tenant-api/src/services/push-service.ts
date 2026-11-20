import {
	buildMarketingPush,
	MAX_PUSH_DEVICES,
	pushLocale,
	type MarketingPushContent,
	type PushCategory,
	type PushErrorCode,
	type PushPayload,
	type RegisterDeviceInput,
} from '@repo/common/push'
import {
	customerPushDevices,
	customerPushPreferences,
	customerSubscriptions,
	CUSTOMER_PUSH_CATEGORIES,
	marketingMessages,
	pushMessages,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	and,
	asc,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	lt,
	sql,
} from 'drizzle-orm'
import {
	getCustomerAppInfo,
	type CustomerAppInfo,
} from '../lib/customer-app-info.ts'
import { HttpError } from '../lib/http.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import { getNodeRegion } from '../lib/region.ts'
import {
	openPushToken,
	pushTokenHash,
	sealPushToken,
} from '../lib/push-seal.ts'
import {
	isPushKillSwitchOn,
	pushAllowedInRegion,
} from '../lib/push-switches.ts'
import { setCustomerSubscription } from './marketing-audience.ts'
import { getPushProvider } from './push-provider.ts'

/**
 * Guest push (#105): devices, preferences, the sender and its log. One sender
 * for everything: order status, bookings, rewards, broadcasts and automation
 * steps all go through `sendPushToCustomer`, which owns the rules:
 *
 *  - off unless the flag `customer_app.push` is on (and `marketing.push` for
 *    marketing), the node kill switch `PUSH_ENABLED` allows it, and, on the
 *    KSA node, `PUSH_KSA_APPROVED` is set (legal);
 *  - the platform's credentials are set in the App registry (#156);
 *  - service pushes follow the guest's own switch for their category (on
 *    unless turned off); marketing needs an active `push` subscription;
 *  - once per event: one log row per kind, reference and device, so a retried
 *    hook never sends twice;
 *  - a token the service reports invalid is deleted with its device.
 * Payloads hold no personal data (`@repo/common/push`).
 */

export type PushGate =
	{ ok: true; info: CustomerAppInfo } | { ok: false; code: PushErrorCode }

/** Whether push may be used for this organization on this node right now. */
export async function pushGate(
	orgId: string,
	options: { marketing?: boolean } = {},
): Promise<PushGate> {
	if (isPushKillSwitchOn() || !pushAllowedInRegion(getNodeRegion())) {
		return { ok: false, code: 'push_not_enabled' }
	}
	const info = await getCustomerAppInfo(orgId)
	if (!info.app || !info.push.enabled)
		return { ok: false, code: 'push_not_enabled' }
	if (options.marketing && !info.push.marketing) {
		return { ok: false, code: 'push_not_enabled' }
	}
	return { ok: true, info }
}

export function pushFailure(code: PushErrorCode, status = 409): HttpError {
	return new HttpError(status, code)
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export async function registerPushDevice(
	db: TenantDatabase,
	orgId: string,
	customerId: string,
	input: RegisterDeviceInput,
	now = Date.now(),
): Promise<{ id: string; dropped: number }> {
	const gate = await pushGate(orgId)
	if (!gate.ok) throw pushFailure(gate.code)
	const credentials = gate.info.push.credentials
	// The app needs its platform's credentials (APNs for iOS, FCM for Android).
	if (!(input.platform === 'ios' ? credentials.ios : credentials.android)) {
		throw pushFailure('push_not_enabled')
	}
	const hash = pushTokenHash(input.token)
	const existing = await db
		.select({ id: customerPushDevices.id })
		.from(customerPushDevices)
		.where(eq(customerPushDevices.tokenHash, hash))
		.get()
	let id: string
	if (existing) {
		// The same phone signing in again (maybe as another guest): one row.
		id = existing.id
		await db
			.update(customerPushDevices)
			.set({
				customerId,
				platform: input.platform,
				appId: input.appId ?? null,
				locale: input.locale,
				lastSeenAt: new Date(now),
			})
			.where(eq(customerPushDevices.id, id))
	} else {
		id = crypto.randomUUID()
		await db.insert(customerPushDevices).values({
			id,
			customerId,
			platform: input.platform,
			tokenCiphertext: sealPushToken(input.token),
			tokenHash: hash,
			appId: input.appId ?? null,
			locale: input.locale,
			createdAt: new Date(now),
			lastSeenAt: new Date(now),
		})
	}
	// At most 10 devices per customer: the oldest (by last use) is dropped.
	const all = await db
		.select({ id: customerPushDevices.id })
		.from(customerPushDevices)
		.where(eq(customerPushDevices.customerId, customerId))
		.orderBy(
			desc(customerPushDevices.lastSeenAt),
			desc(customerPushDevices.createdAt),
		)
	const extra = all.slice(MAX_PUSH_DEVICES).map((row) => row.id)
	if (extra.length > 0) {
		await db
			.delete(customerPushDevices)
			// bounded: at most one device beyond the cap (one registration per call)
			.where(inArray(customerPushDevices.id, extra))
	}
	return { id, dropped: extra.length }
}

/** Signing out (or leaving the app) deletes the device from the server. */
export async function removePushDevice(
	db: TenantDatabase,
	customerId: string,
	deviceId: string,
): Promise<boolean> {
	const removed = await db
		.delete(customerPushDevices)
		.where(
			and(
				eq(customerPushDevices.id, deviceId),
				eq(customerPushDevices.customerId, customerId),
			),
		)
		.returning({ id: customerPushDevices.id })
	return removed.length > 0
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export type PushPreferences = Record<PushCategory, boolean> & {
	marketing: boolean
	/** Whether the guest has a device registered. */
	hasDevice: boolean
}

export async function getPushPreferences(
	db: TenantDatabase,
	customerId: string,
): Promise<PushPreferences> {
	const rows = await db
		.select()
		.from(customerPushPreferences)
		.where(eq(customerPushPreferences.customerId, customerId))
	const subscription = await db
		.select({ unsubscribedAt: customerSubscriptions.unsubscribedAt })
		.from(customerSubscriptions)
		.where(
			and(
				eq(customerSubscriptions.customerId, customerId),
				eq(customerSubscriptions.topic, 'marketing'),
				eq(customerSubscriptions.channel, 'push'),
			),
		)
		.get()
	const devices = await db
		.select({ n: sql<number>`count(*)` })
		.from(customerPushDevices)
		.where(eq(customerPushDevices.customerId, customerId))
	const byCategory = new Map(rows.map((row) => [row.category, row.enabled]))
	return {
		orders: byCategory.get('orders') ?? true,
		bookings: byCategory.get('bookings') ?? true,
		rewards: byCategory.get('rewards') ?? true,
		// Marketing is off until the guest opts in.
		marketing: Boolean(subscription && !subscription.unsubscribedAt),
		hasDevice: Number(devices[0]?.n ?? 0) > 0,
	}
}

export async function setPushPreferences(
	db: TenantDatabase,
	orgId: string,
	customerId: string,
	input: Partial<Record<PushCategory | 'marketing', boolean>> & {
		source?: 'profile' | 'app_prompt'
	},
	now = Date.now(),
): Promise<PushPreferences> {
	const gate = await pushGate(orgId)
	if (!gate.ok) throw pushFailure(gate.code)
	for (const category of CUSTOMER_PUSH_CATEGORIES) {
		const enabled = input[category]
		if (enabled === undefined) continue
		await db
			.insert(customerPushPreferences)
			.values({ customerId, category, enabled, updatedAt: new Date(now) })
			.onConflictDoUpdate({
				target: [
					customerPushPreferences.customerId,
					customerPushPreferences.category,
				],
				set: { enabled, updatedAt: new Date(now) },
			})
	}
	if (input.marketing !== undefined) {
		if (input.marketing) {
			// Explicit consent: needs the marketing flag and a phone that can receive it.
			const marketing = await pushGate(orgId, { marketing: true })
			if (!marketing.ok) throw pushFailure(marketing.code)
			const current = await getPushPreferences(db, customerId)
			if (!current.hasDevice) throw pushFailure('push_not_enabled')
		}
		await setCustomerSubscription(db, {
			customerId,
			topic: 'marketing',
			channel: 'push',
			subscribed: input.marketing,
			source: input.source ?? 'profile',
			now: new Date(now),
		})
	}
	return getPushPreferences(db, customerId)
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type PushBuilder = (context: {
	locale: string
	siteOrigin: string | null
}) => PushPayload | null

export type SendPushInput = {
	orgId: string
	customerId: string
	kind: 'order_status' | 'booking' | 'reward' | 'marketing'
	/** What this push is about; with the kind and the device it makes the send once-only. */
	ref: string
	build: PushBuilder
	/** The service category whose switch the guest controls (not for marketing). */
	category?: PushCategory
	campaignId?: string | null
	now?: number
}

export type SendPushResult = {
	sent: number
	skipped: number
	reason?: 'not_enabled' | 'category_off' | 'no_consent' | 'no_device'
}

async function siteOriginOf(orgId: string): Promise<string | null> {
	try {
		return (
			(await getReservationsContext(orgId))?.organization.siteOrigin ?? null
		)
	} catch {
		return null
	}
}

/**
 * Sends one push to every device of a guest, once per event. Never throws for
 * an unreachable provider: the row is `failed` with a short code and the
 * caller's own retry (the tick) is not needed, because a push never waits.
 */
export async function sendPushToCustomer(
	db: TenantDatabase,
	input: SendPushInput,
): Promise<SendPushResult> {
	const now = input.now ?? Date.now()
	const marketing = input.kind === 'marketing'
	const gate = await pushGate(input.orgId, { marketing })
	if (!gate.ok) return { sent: 0, skipped: 0, reason: 'not_enabled' }
	if (input.category) {
		const prefs = await getPushPreferences(db, input.customerId)
		if (!prefs[input.category])
			return { sent: 0, skipped: 0, reason: 'category_off' }
	}
	if (marketing) {
		const prefs = await getPushPreferences(db, input.customerId)
		if (!prefs.marketing) return { sent: 0, skipped: 0, reason: 'no_consent' }
	}
	const devices = await db
		.select()
		.from(customerPushDevices)
		.where(eq(customerPushDevices.customerId, input.customerId))
		.orderBy(asc(customerPushDevices.createdAt))
		.limit(MAX_PUSH_DEVICES)
	if (devices.length === 0) return { sent: 0, skipped: 0, reason: 'no_device' }
	const siteOrigin = await siteOriginOf(input.orgId)
	const credentials = gate.info.push.credentials

	const deliveries: Array<{
		token: string
		payload: PushPayload
		messageId: string
		deviceId: string
	}> = []
	let skipped = 0
	for (const device of devices) {
		if (!(device.platform === 'ios' ? credentials.ios : credentials.android)) {
			skipped += 1
			continue
		}
		const token = openPushToken(device.tokenCiphertext)
		const payload = token
			? input.build({ locale: pushLocale(device.locale), siteOrigin })
			: null
		if (!token || !payload) {
			skipped += 1
			continue
		}
		// The log row is the claim: a second hook for the same event finds it taken.
		const messageId = crypto.randomUUID()
		const claimed = await db
			.insert(pushMessages)
			.values({
				id: messageId,
				kind: input.kind,
				ref: input.ref,
				customerId: input.customerId,
				deviceId: device.id,
				campaignId: input.campaignId ?? null,
				status: 'queued',
				createdAt: new Date(now),
			})
			.onConflictDoNothing()
			.returning({ id: pushMessages.id })
		if (claimed.length === 0) {
			skipped += 1
			continue
		}
		deliveries.push({
			token,
			deviceId: device.id,
			messageId,
			payload: { ...payload, data: { ...payload.data, messageId } },
		})
	}
	if (deliveries.length === 0) return { sent: 0, skipped }

	let tickets
	try {
		tickets = await getPushProvider().send(
			deliveries.map(({ token, payload, messageId }) => ({
				token,
				payload,
				messageId,
			})),
		)
	} catch {
		tickets = deliveries.map((d) => ({
			messageId: d.messageId,
			status: 'error' as const,
			code: 'provider_unreachable',
		}))
	}
	let sent = 0
	for (const delivery of deliveries) {
		const ticket = tickets.find((t) => t.messageId === delivery.messageId)
		if (ticket?.status === 'ok') {
			sent += 1
			await db
				.update(pushMessages)
				.set({
					status: 'sent',
					ticketId: ticket.ticketId,
					sentAt: new Date(now),
				})
				.where(eq(pushMessages.id, delivery.messageId))
		} else if (ticket?.status === 'invalid_token') {
			await db
				.update(pushMessages)
				.set({ status: 'invalid_token', errorCode: 'push_token_invalid' })
				.where(eq(pushMessages.id, delivery.messageId))
			await db
				.delete(customerPushDevices)
				.where(eq(customerPushDevices.id, delivery.deviceId))
		} else {
			await db
				.update(pushMessages)
				.set({
					status: 'failed',
					errorCode:
						ticket?.status === 'error' ? ticket.code : 'provider_error',
				})
				.where(eq(pushMessages.id, delivery.messageId))
		}
	}
	return { sent, skipped: skipped + (deliveries.length - sent) }
}

/** A marketing push from an operator's words (broadcast or automation step). */
export function marketingBuilder(content: MarketingPushContent): PushBuilder {
	return ({ locale, siteOrigin }) =>
		buildMarketingPush(content, { locale, siteOrigin })
}

// ---------------------------------------------------------------------------
// Opens and delivery receipts
// ---------------------------------------------------------------------------

/** The app reports a tap: the guest's own send-log row, once. */
export async function markPushOpened(
	db: TenantDatabase,
	customerId: string,
	messageId: string,
	now = Date.now(),
): Promise<boolean> {
	const row = await db
		.select({ id: pushMessages.id, campaignId: pushMessages.campaignId })
		.from(pushMessages)
		.where(
			and(
				eq(pushMessages.id, messageId),
				eq(pushMessages.customerId, customerId),
			),
		)
		.get()
	if (!row) return false
	await db
		.update(pushMessages)
		.set({ openedAt: new Date(now) })
		.where(and(eq(pushMessages.id, row.id), isNull(pushMessages.openedAt)))
	if (row.campaignId) {
		await db
			.update(marketingMessages)
			.set({ openedAt: new Date(now) })
			.where(
				and(
					eq(marketingMessages.campaignId, row.campaignId),
					eq(marketingMessages.customerId, customerId),
					isNull(marketingMessages.openedAt),
				),
			)
	}
	return true
}

/**
 * Reads delivery receipts for pushes sent a while ago: delivered, or a token
 * that turned out invalid (deleted with its device). Bounded per run; the tick
 * calls it. Receipts older than a day are given up on.
 */
export async function processPushReceipts(
	db: TenantDatabase,
	now = Date.now(),
): Promise<{ checked: number; delivered: number; invalid: number }> {
	const rows = await db
		.select({
			id: pushMessages.id,
			ticketId: pushMessages.ticketId,
			deviceId: pushMessages.deviceId,
		})
		.from(pushMessages)
		.where(
			and(
				eq(pushMessages.status, 'sent'),
				isNotNull(pushMessages.ticketId),
				lt(pushMessages.sentAt, new Date(now - 60_000)),
			),
		)
		.limit(500)
	if (rows.length === 0) return { checked: 0, delivered: 0, invalid: 0 }
	let receipts
	try {
		receipts = await getPushProvider().receipts(
			rows.map((row) => row.ticketId!),
		)
	} catch {
		return { checked: 0, delivered: 0, invalid: 0 }
	}
	let delivered = 0
	let invalid = 0
	for (const receipt of receipts) {
		const row = rows.find(
			(candidate) => candidate.ticketId === receipt.ticketId,
		)
		if (!row) continue
		if (receipt.status === 'delivered') {
			delivered += 1
			await db
				.update(pushMessages)
				.set({ status: 'delivered', deliveredAt: new Date(now) })
				.where(eq(pushMessages.id, row.id))
		} else if (receipt.status === 'invalid_token') {
			invalid += 1
			await db
				.update(pushMessages)
				.set({ status: 'invalid_token', errorCode: 'push_token_invalid' })
				.where(eq(pushMessages.id, row.id))
			await db
				.delete(customerPushDevices)
				.where(eq(customerPushDevices.id, row.deviceId))
		} else {
			await db
				.update(pushMessages)
				.set({ status: 'failed', errorCode: 'provider_error' })
				.where(eq(pushMessages.id, row.id))
		}
	}
	return { checked: rows.length, delivered, invalid }
}

/** Sent, delivered and opened counts of one broadcast. */
export async function pushCampaignMetrics(
	db: TenantDatabase,
	campaignId: string,
): Promise<{ sent: number; delivered: number; opened: number }> {
	const rows = await db
		.select({
			status: pushMessages.status,
			opened: pushMessages.openedAt,
		})
		.from(pushMessages)
		.where(eq(pushMessages.campaignId, campaignId))
	return {
		sent: rows.filter((r) => r.status === 'sent' || r.status === 'delivered')
			.length,
		delivered: rows.filter((r) => r.status === 'delivered').length,
		opened: rows.filter((r) => r.opened !== null).length,
	}
}
