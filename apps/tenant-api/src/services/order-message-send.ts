import { type ReservationsContext } from '@repo/reservations'
import {
	getTenantDb,
	orderMessages,
	restaurantOrders,
	type OrderMessageKind,
	type RestaurantOrder,
	type TenantDatabase,
} from '@repo/tenant-db'
import { sendSms } from '@repo/sms'
import { and, asc, count, eq, gte, inArray, lte, min } from 'drizzle-orm'
import { forEachWithBudget } from '../lib/concurrency.ts'
import { errorLogFields } from '../lib/error-log.ts'
import { queryInChunks } from '../lib/chunked-in.ts'
import { buildOrderLinkUrl } from '../lib/order-link.ts'
import {
	renderOrderEmail,
	renderOrderSms,
} from '../lib/order-messages-email.ts'
import {
	isOrdersEmailEnabled,
	isOrdersSmsEnabled,
} from '../lib/orders-switches.ts'
import { getNodeRegion } from '../lib/region.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import { normalizeReservationLocale } from '../lib/reservations-email.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { rotateOrgIds } from './loyalty-tick-service.ts'

/**
 * Sends `order_messages` rows (queued by `order-messages.ts`). A row is
 * claimed with a short lease, checked against the kill switches and the order
 * as it is now (an erased order has no contact: the row is dropped), rendered
 * in the order's language and sent. A failed send is retried after 1, 5, 30
 * and 120 minutes and then ends `failed`; only a machine code is stored.
 * Logs carry ids and codes, never an address, a number or a message body.
 *
 * The organization's name, email theme, site origin (for the "View your
 * order" link) and location time zones come from the control plane's cached,
 * non-PII organization context (`GET /resources/reservations/context`, served
 * for every active organization whatever its reservations flags).
 */

export const ORDER_MESSAGE_BACKOFF_MIN = [1, 5, 30, 120] as const
export const ORDER_MESSAGE_BATCH_LIMIT = 100
/** Order texts sent per organization in any rolling 24 hours. */
export const ORDER_SMS_DAILY_CAP = 200
export const ORDER_SMS_CAP_WINDOW_MS = 24 * 60 * 60 * 1000
const CLAIM_LEASE_MS = 5 * 60 * 1000
const DEFAULT_TICK_BUDGET_MS = 50_000

export type OrderMessageTotals = {
	sent: number
	retried: number
	failed: number
	dropped: number
}

export function emptyOrderMessageTotals(): OrderMessageTotals {
	return { sent: 0, retried: 0, failed: 0, dropped: 0 }
}

type MessageRow = typeof orderMessages.$inferSelect
type Outcome = keyof OrderMessageTotals

export type OrderMessageSendDeps = {
	getContext: (orgId: string) => Promise<ReservationsContext | null>
	sendSms: (input: { to: string; message: string }) => Promise<unknown>
	smsDailyCap: number
}

const defaultDeps: OrderMessageSendDeps = {
	getContext: (orgId) => getReservationsContext(orgId),
	sendSms: (input) => sendSms(input),
	smsDailyCap: ORDER_SMS_DAILY_CAP,
}

let depsOverride: Partial<OrderMessageSendDeps> = {}

/** Tests only: swap the context reader, the SMS sender or the daily cap. */
export function setOrderMessageSendDepsForTest(
	deps: Partial<OrderMessageSendDeps> | null,
) {
	depsOverride = deps ?? {}
}

function deps(): OrderMessageSendDeps {
	return { ...defaultDeps, ...depsOverride }
}

function nodeRegion(): 'us' | 'ksa' | null {
	try {
		return getNodeRegion()
	} catch {
		return null
	}
}

function errorCode(error: unknown, fallback: string): string {
	return error instanceof Error && /^[a-z_]{1,40}$/.test(error.message)
		? error.message
		: fallback
}

class SendFailure extends Error {}

/** What a message needs from the organization, resolved once per pass. */
type MessageSetting = {
	restaurantName: string
	defaultLocale: string
	theme: ReservationsContext['organization']['emailTheme'] | null
	siteOrigin: string | null
	timeZoneFor(locationId: string, order: RestaurantOrder): string | null
}

function settingFrom(context: ReservationsContext): MessageSetting {
	const zones = new Map(
		context.locations.map((location) => [location.id, location.timeZone]),
	)
	return {
		restaurantName:
			context.organization.emailTheme.organizationName ||
			context.organization.name,
		defaultLocale: context.organization.defaultLocale,
		theme: context.organization.emailTheme,
		siteOrigin: context.organization.siteOrigin,
		timeZoneFor: (locationId, order) =>
			order.pickupTimezone || zones.get(locationId) || null,
	}
}

/** Sends one message for `order` right now, rendering it from the order as it is. */
async function sendForOrder(input: {
	orgId: string
	order: RestaurantOrder
	kind: OrderMessageKind
	channel: 'email' | 'sms'
	setting: MessageSetting
	messageId: string
}): Promise<void> {
	const { orgId, order, kind, channel, setting } = input
	const linkUrl = buildOrderLinkUrl({
		siteOrigin: setting.siteOrigin,
		orgId,
		orderId: order.id,
	})
	const timeZone = setting.timeZoneFor(order.locationId, order)
	const locale = normalizeReservationLocale(order.locale)
	if (channel === 'sms') {
		if (kind !== 'ready' && kind !== 'eta_changed') {
			throw new SendFailure('sms_kind')
		}
		// Second line of defense behind the queue rule: only the US node texts.
		if (nodeRegion() !== 'us') throw new SendFailure('sms_not_allowed')
		const message = renderOrderSms({
			kind,
			locale,
			restaurantName: setting.restaurantName,
			order,
			timeZone,
			linkUrl,
		})
		try {
			await deps().sendSms({ to: order.contactPhone, message })
		} catch {
			throw new SendFailure('sms_failed')
		}
		return
	}
	const rendered = renderOrderEmail({
		kind,
		locale,
		theme: setting.theme,
		restaurantName: setting.restaurantName,
		defaultLocale: setting.defaultLocale,
		order,
		timeZone,
		linkUrl,
	})
	const result = await sendTenantEmail({
		to: order.contactEmail!,
		subject: rendered.subject,
		html: rendered.html,
		text: rendered.text,
		capture: {
			orgId,
			messageKind: `order_${kind}`,
			messageId: input.messageId,
		},
	})
	if (result.status === 'error') throw new SendFailure('email_failed')
}

async function setRow(
	db: TenantDatabase,
	id: string,
	patch: Partial<MessageRow>,
): Promise<void> {
	await db.update(orderMessages).set(patch).where(eq(orderMessages.id, id))
}

async function smsSentInWindow(
	db: TenantDatabase,
	now: number,
): Promise<number> {
	const [row] = await db
		.select({ value: count() })
		.from(orderMessages)
		.where(
			and(
				eq(orderMessages.channel, 'sms'),
				eq(orderMessages.status, 'sent'),
				gte(orderMessages.sentAt, now - ORDER_SMS_CAP_WINDOW_MS),
			),
		)
	return Number(row?.value ?? 0)
}

async function processRow(options: {
	db: TenantDatabase
	orgId: string
	row: MessageRow
	now: number
	setting: () => Promise<MessageSetting | null>
}): Promise<Outcome | null> {
	const { db, orgId, row, now } = options
	// Claim: a lease, so the after-commit send and a tick never both send it.
	const claimed = await db
		.update(orderMessages)
		.set({ nextAttemptAt: now + CLAIM_LEASE_MS })
		.where(
			and(
				eq(orderMessages.id, row.id),
				eq(orderMessages.status, 'queued'),
				lte(orderMessages.nextAttemptAt, now),
			),
		)
		.returning({ id: orderMessages.id })
	if (claimed.length === 0) return null

	const drop = async (code: string): Promise<Outcome> => {
		await setRow(db, row.id, { status: 'dropped', lastError: code })
		return 'dropped'
	}

	const switchOn =
		row.channel === 'sms' ? isOrdersSmsEnabled() : isOrdersEmailEnabled()
	if (!switchOn) {
		return drop(row.channel === 'sms' ? 'sms_disabled' : 'email_disabled')
	}

	const [order] = await db
		.select()
		.from(restaurantOrders)
		.where(eq(restaurantOrders.id, row.orderId))
		.limit(1)
	if (!order) return drop('no_contact')
	if (row.channel === 'email' && !order.contactEmail) return drop('no_contact')
	if (row.channel === 'sms') {
		if (nodeRegion() !== 'us') return drop('sms_not_allowed')
		if (!order.smsUpdatesOptIn || !order.contactPhone) return drop('no_contact')
		if ((await smsSentInWindow(db, now)) >= deps().smsDailyCap) {
			console.warn('Order text over the daily cap', orgId, row.id)
			return drop('sms_daily_cap')
		}
	}

	const attempts = row.attempts + 1
	try {
		const setting = await options.setting()
		if (!setting) throw new SendFailure('context_unavailable')
		await sendForOrder({
			orgId,
			order,
			kind: row.kind,
			channel: row.channel,
			setting,
			messageId: row.id,
		})
		await setRow(db, row.id, {
			status: 'sent',
			sentAt: now,
			attempts,
			lastError: null,
		})
		return 'sent'
	} catch (error) {
		const code = errorCode(error, 'send_failed')
		const delay = ORDER_MESSAGE_BACKOFF_MIN[attempts - 1]
		if (delay === undefined) {
			await setRow(db, row.id, {
				status: 'failed',
				attempts,
				lastError: code,
				nextAttemptAt: now,
			})
			console.warn('Order message failed', orgId, row.id, row.kind, code)
			return 'failed'
		}
		await setRow(db, row.id, {
			attempts,
			lastError: code,
			nextAttemptAt: now + delay * 60_000,
		})
		return 'retried'
	}
}

async function deliverRows(
	db: TenantDatabase,
	orgId: string,
	rows: readonly MessageRow[],
	now: number,
): Promise<OrderMessageTotals> {
	const totals = emptyOrderMessageTotals()
	if (rows.length === 0) return totals
	let loaded: Promise<MessageSetting | null> | null = null
	const setting = () => {
		loaded ??= deps()
			.getContext(orgId)
			.then((context) => (context ? settingFrom(context) : null))
			.catch(() => null)
		return loaded
	}
	// Sends run one after another: each row's claim, lease and backoff use the
	// time it is actually reached, so a slow batch never claims a row with a
	// lease that has already lapsed (which would let another tick send it too).
	const started = Date.now()
	for (const row of rows) {
		try {
			const outcome = await processRow({
				db,
				orgId,
				row,
				now: now + Math.max(0, Date.now() - started),
				setting,
			})
			if (outcome) totals[outcome]++
		} catch (error) {
			// A database hiccup on one row: the lease lapses and the tick retries.
			console.error('Order message step failed', {
				orgId,
				messageId: row.id,
				...errorLogFields(error),
			})
		}
	}
	return totals
}

const DUE = (now: number) =>
	and(eq(orderMessages.status, 'queued'), lte(orderMessages.nextAttemptAt, now))

/** Right after an order write commits: the rows it queued. */
export async function deliverOrderMessagesByIds(
	orgId: string,
	ids: readonly string[],
	options: { db?: TenantDatabase; now?: number } = {},
): Promise<OrderMessageTotals> {
	if (ids.length === 0) return emptyOrderMessageTotals()
	const db = options.db ?? (await getTenantDb(orgId))
	const now = options.now ?? Date.now()
	const rows = await queryInChunks([...ids], (chunk) =>
		db
			.select()
			.from(orderMessages)
			.where(and(inArray(orderMessages.id, chunk), DUE(now))),
	)
	return deliverRows(db, orgId, rows, now)
}

/** Tick: the next due rows, oldest first, bounded per pass. */
export async function deliverDueOrderMessages(
	orgId: string,
	options: { db?: TenantDatabase; now?: number; limit?: number } = {},
): Promise<OrderMessageTotals> {
	const db = options.db ?? (await getTenantDb(orgId))
	const now = options.now ?? Date.now()
	const rows = await db
		.select()
		.from(orderMessages)
		.where(DUE(now))
		.orderBy(asc(orderMessages.nextAttemptAt))
		.limit(options.limit ?? ORDER_MESSAGE_BATCH_LIMIT)
	return deliverRows(db, orgId, rows, now)
}

/** When the earliest queued message is due (epoch ms), or null when none waits. */
export async function nextOrderMessageDueAt(
	db: TenantDatabase,
): Promise<number | null> {
	const [row] = await db
		.select({ at: min(orderMessages.nextAttemptAt) })
		.from(orderMessages)
		.where(eq(orderMessages.status, 'queued'))
	return typeof row?.at === 'number' ? row.at : null
}

export type OrderMessagesTickResult = OrderMessageTotals & {
	needsFollowUp: boolean
	nextDueAt: number | null
}

/**
 * The order messages tick for one organization: sends what is due and says
 * whether anything still waits (so the Durable Object alarm re-arms only
 * while queued rows exist). Counts only.
 */
export async function runOrderMessagesTickForOrg(
	orgId: string,
	options: { now?: number; db?: TenantDatabase } = {},
): Promise<OrderMessagesTickResult> {
	const now = options.now ?? Date.now()
	const db = options.db ?? (await getTenantDb(orgId))
	const waiting = await nextOrderMessageDueAt(db)
	if (waiting === null) {
		return {
			...emptyOrderMessageTotals(),
			needsFollowUp: false,
			nextDueAt: null,
		}
	}
	const totals =
		waiting <= now
			? await deliverDueOrderMessages(orgId, { db, now })
			: emptyOrderMessageTotals()
	const nextDueAt = await nextOrderMessageDueAt(db)
	return { ...totals, needsFollowUp: nextDueAt !== null, nextDueAt }
}

export async function runOrderMessagesTickLogged(
	orgId: string,
): Promise<OrderMessagesTickResult | null> {
	try {
		return await runOrderMessagesTickForOrg(orgId)
	} catch (error) {
		console.error(
			'Order messages tick failed for organization',
			orgId,
			errorLogFields(error),
		)
		return null
	}
}

export type OrderMessagesTickAggregate = OrderMessageTotals & {
	orgs: number
	orgsDeferred: number
	errors: number
}

/**
 * Runs the tick for many organizations with bounded concurrency and a time
 * budget, starting at a different organization each hour (like the loyalty
 * and inventory ticks). Counts only.
 */
export async function fanOutOrderMessagesTick(options: {
	orgIds: readonly string[]
	run: (orgId: string) => Promise<OrderMessagesTickResult | null>
	budgetMs?: number
	concurrency?: number
	now?: () => number
}): Promise<OrderMessagesTickAggregate> {
	const now = options.now ?? Date.now
	const total: OrderMessagesTickAggregate = {
		...emptyOrderMessageTotals(),
		orgs: 0,
		orgsDeferred: 0,
		errors: 0,
	}
	const orgIds = rotateOrgIds(
		options.orgIds,
		Math.floor(now() / (60 * 60 * 1000)),
	)
	const run = await forEachWithBudget(
		orgIds,
		{
			concurrency: options.concurrency ?? 4,
			deadline: now() + (options.budgetMs ?? DEFAULT_TICK_BUDGET_MS),
			now,
		},
		async (orgId) => {
			const result = await options.run(orgId)
			if (!result) {
				total.errors++
				return
			}
			total.orgs++
			total.sent += result.sent
			total.retried += result.retried
			total.failed += result.failed
			total.dropped += result.dropped
		},
	)
	total.orgsDeferred = run.skipped
	return total
}

export type ReceiptResendOutcome =
	'sent' | 'not_found' | 'not_available' | 'no_email' | 'disabled' | 'failed'

/**
 * Sends the receipt email for one order now, outside the once-per-kind queue
 * (for "resend my link": the caller has already checked the capability and
 * its own rate limit). Only for an order that guest messages applied to when
 * it was placed (`guest_messages` set, pickup or delivery, standing), with an
 * email address; honors `ORDERS_EMAIL_ENABLED`. Never throws.
 */
export async function sendOrderReceiptNow(
	orgId: string,
	orderId: string,
	options: { db?: TenantDatabase } = {},
): Promise<ReceiptResendOutcome> {
	try {
		const db = options.db ?? (await getTenantDb(orgId))
		const [order] = await db
			.select()
			.from(restaurantOrders)
			.where(
				and(
					eq(restaurantOrders.id, orderId),
					eq(restaurantOrders.orgId, orgId),
				),
			)
			.limit(1)
		if (!order) return 'not_found'
		const stands =
			order.paymentMethod === 'handoff' ||
			order.paymentStatus === 'paid' ||
			order.paymentStatus === 'not_required'
		if (
			order.fulfillment === 'dine_in' ||
			order.tabId ||
			!order.guestMessages ||
			order.guestMessages.receipt !== true ||
			!stands
		) {
			return 'not_available'
		}
		if (!order.contactEmail) return 'no_email'
		if (!isOrdersEmailEnabled()) return 'disabled'
		const context = await deps()
			.getContext(orgId)
			.catch(() => null)
		if (!context) return 'failed'
		await sendForOrder({
			orgId,
			order,
			kind: 'receipt',
			channel: 'email',
			setting: settingFrom(context),
			messageId: `resend:${order.id}`,
		})
		return 'sent'
	} catch (error) {
		console.warn(
			'Order receipt resend failed',
			orgId,
			orderId,
			errorCode(error, 'send_failed'),
		)
		return 'failed'
	}
}
