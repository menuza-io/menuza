import { z } from 'zod'
import {
	addDays,
	isValidTimeZone,
	localParts,
	parseDate,
	zonedLocalToUtc,
} from '@repo/zoned-time'

/**
 * Manager and operator alerts (#106, #366, #131, #241, #300, #190): the pure
 * rules shared by the App, tenant-api, jobs-cron and the operator phone app.
 * No I/O.
 *
 * Nothing in this file, and nothing built from it, may carry a guest's name,
 * phone, email, address, order notes or item list. An alert is a kind, a
 * location, an order number, a count, a time and a total. Schemas are strict,
 * so a field that could hold a person is a refusal, never echoed back.
 */

// ---------------------------------------------------------------------------
// Kinds and push categories
// ---------------------------------------------------------------------------

/** Alert kinds the order and tablet alerts add. Each is also a preference workflow. */
export const ORDER_ALERT_KINDS = [
	'orders_new',
	'orders_waiting',
	'orders_due_soon',
	'orders_payment_review',
	'ordering_paused_long',
	'orders_large',
	'station_offline',
] as const
export type OrderAlertKind = (typeof ORDER_ALERT_KINDS)[number]

export function isOrderAlertKind(value: unknown): value is OrderAlertKind {
	return (
		typeof value === 'string' &&
		(ORDER_ALERT_KINDS as readonly string[]).includes(value)
	)
}

/** `Notification.type` of an order alert: `orders-new`, `orders-waiting`, ... */
export const ORDER_ALERT_TYPE_PREFIX = 'orders-'
/**
 * Written for a member who has the in-app alert off but push or email on, so a
 * redelivered event does not send them twice. Already read and seen, never listed.
 */
export const ORDER_ALERT_MARKER_TYPE = 'orders-marker'
/** The tablet alert's own prefix keeps it out of the orders permission check. */
export const STATION_ALERT_TYPE = 'station-offline'

export function orderAlertNotificationType(kind: OrderAlertKind): string {
	if (kind === 'station_offline') return STATION_ALERT_TYPE
	if (kind === 'ordering_paused_long') return 'orders-paused-long'
	return `${ORDER_ALERT_TYPE_PREFIX}${kind.slice('orders_'.length).replaceAll('_', '-')}`
}

export function orderAlertKindFromNotificationType(
	type: unknown,
): OrderAlertKind | null {
	if (typeof type !== 'string') return null
	return (
		ORDER_ALERT_KINDS.find(
			(kind) => orderAlertNotificationType(kind) === type,
		) ?? null
	)
}

/** What a member picks in Notifications to get as a push (#106). */
export const PUSH_CATEGORIES = [
	'new_orders',
	'orders_waiting',
	'ordering_paused',
	'payment_review',
	'large_orders',
	'station_offline',
	'staff',
	'inventory',
	'reservations',
	'chat_mentions',
] as const
export type PushCategory = (typeof PUSH_CATEGORIES)[number]

export function isPushCategory(value: unknown): value is PushCategory {
	return (
		typeof value === 'string' &&
		(PUSH_CATEGORIES as readonly string[]).includes(value)
	)
}

/**
 * The `NotificationPreference.workflow` that holds a category's push switch.
 * The order and tablet kinds keep email, in-app and push on one row (their own
 * workflow); the older categories get a `push.<category>` row, so their
 * existing email and in-app rows are untouched.
 */
export const PUSH_CATEGORY_WORKFLOW: Record<PushCategory, string> = {
	new_orders: 'orders_new',
	orders_waiting: 'orders_waiting',
	ordering_paused: 'ordering_paused_long',
	payment_review: 'orders_payment_review',
	large_orders: 'orders_large',
	station_offline: 'station_offline',
	staff: 'push.staff',
	inventory: 'push.inventory',
	reservations: 'push.reservations',
	chat_mentions: 'push.chat_mentions',
}

/** The category an alert kind is pushed under. Due-soon shares "orders waiting". */
export const ORDER_ALERT_PUSH_CATEGORY: Record<OrderAlertKind, PushCategory> = {
	orders_new: 'new_orders',
	orders_waiting: 'orders_waiting',
	orders_due_soon: 'orders_waiting',
	orders_payment_review: 'payment_review',
	ordering_paused_long: 'ordering_paused',
	orders_large: 'large_orders',
	station_offline: 'station_offline',
}

/** The preference workflows of the order and tablet kinds: each kind is its own. */
export const ORDER_ALERT_WORKFLOWS = ORDER_ALERT_KINDS

/** Where the push for a `Notification.type` is filed, or null when it is not pushed. */
export function pushCategoryForNotificationType(
	type: unknown,
): PushCategory | null {
	if (typeof type !== 'string') return null
	const orderKind = orderAlertKindFromNotificationType(type)
	if (orderKind) return ORDER_ALERT_PUSH_CATEGORY[orderKind]
	if (type.startsWith('staffing-')) return 'staff'
	if (type.startsWith('inventory-') && type !== 'inventory-email-sent') {
		return 'inventory'
	}
	if (type.startsWith('reservations-')) return 'reservations'
	if (type === 'chat-mention') return 'chat_mentions'
	return null
}

/** Kinds that are never held by quiet hours or snooze and cannot be switched off. */
export function isCriticalAlert(
	kind: OrderAlertKind,
	options: { allKitchenTabletsOffline?: boolean } = {},
): boolean {
	if (kind === 'orders_payment_review') return true
	return kind === 'station_offline' && options.allKitchenTabletsOffline === true
}

/**
 * Kinds with a "tell me only after N in an hour" threshold. The others are
 * either rare enough or too important to hold back.
 */
export const THRESHOLD_KINDS = ['orders_new', 'orders_waiting'] as const
export type ThresholdKind = (typeof THRESHOLD_KINDS)[number]
export const MAX_ALERT_THRESHOLD = 50
export const THRESHOLD_WINDOW_MS = 60 * 60 * 1000

export function isThresholdKind(value: unknown): value is ThresholdKind {
	return (
		typeof value === 'string' &&
		(THRESHOLD_KINDS as readonly string[]).includes(value)
	)
}

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

/** #131: an order left New this many minutes (location setting, default). */
export const DEFAULT_ORDER_ALERT_MINUTES = 10
export const MIN_ORDER_ALERT_MINUTES = 2
export const MAX_ORDER_ALERT_MINUTES = 120
/** #131: several waiting orders this close together make one alert. */
export const WAITING_GROUP_WINDOW_MS = 5 * 60 * 1000
/** #131: a scheduled order due within this long and still New alerts. */
export const DUE_SOON_MINUTES = 15
/** #131: ordering paused longer than this alerts once per pause. */
export const PAUSE_ALERT_MS = 2 * 60 * 60 * 1000
/** #131: busy mode on for longer than this alerts once. */
export const BUSY_ALERT_MS = 3 * 60 * 60 * 1000
/** #131: no order alerts outside opening hours plus this. */
export const ORDER_ALERT_HOURS_MARGIN_MS = 60 * 60 * 1000
/** #190: a tablet silent this long during opening hours is offline. */
export const STATION_OFFLINE_AFTER_MS = 5 * 60 * 1000
/** #190: the tablet alert window is opening hours plus this on each side. */
export const STATION_ALERT_HOURS_MARGIN_MS = 30 * 60 * 1000
/** #190: the critical "every kitchen tablet is offline" alert repeats this often. */
export const STATION_CRITICAL_REPEAT_MS = 5 * 60 * 1000
/** #300: a scheduled large order is told about again this long before it starts. */
export const LARGE_ORDER_SOON_MINUTES = 60
/** #241: at most this many recipients per location. */
export const MAX_ALERT_RECIPIENTS_PER_LOCATION = 5

// ---------------------------------------------------------------------------
// The wire contract: region -> App (`POST /resources/orders/notify`)
// ---------------------------------------------------------------------------

export const ORDERS_NOTIFY_PATH = '/resources/orders/notify'
/** `GET /resources/orders/alert-settings?orgId=`: what the region may alert about. */
export const ORDERS_ALERT_SETTINGS_PATH = '/resources/orders/alert-settings'
/** `POST /resources/orders/alert-keyword`: STOP and START for a text recipient (hash only). */
export const ORDERS_ALERT_KEYWORD_PATH = '/resources/orders/alert-keyword'

const orgId = z.string().min(1).max(64)
const eventId = z
	.string()
	.min(1)
	.max(120)
	.regex(/^[A-Za-z0-9_.:-]+$/)
const locationId = z.string().min(1).max(100)
/** An order number as the region issues it (`W-0042`, `T1-0042`). No spaces. */
const orderNumber = z
	.string()
	.min(1)
	.max(40)
	.regex(/^[A-Za-z0-9_.#-]+$/)
const currency = z.string().regex(/^[A-Z]{3}$/)

export const orderPlacedEventSchema = z.strictObject({
	kind: z.literal('order_placed'),
	orgId,
	eventId,
	locationId,
	orderNumber,
	fulfillment: z.enum(['pickup', 'delivery']),
	/** The time the guest asked for (epoch ms), null for as soon as possible. */
	scheduledForMs: z.number().int().positive().nullable(),
	totalCents: z.number().int().nonnegative().max(1_000_000_000),
	currency,
	dishCount: z.number().int().nonnegative().max(10_000),
	/** The region applied the large-order rule at placement. */
	large: z.boolean(),
})

export const ordersWaitingEventSchema = z.strictObject({
	kind: z.literal('orders_waiting'),
	orgId,
	eventId,
	locationId,
	orderNumbers: z.array(orderNumber).min(1).max(20),
})

export const ordersDueSoonEventSchema = z.strictObject({
	kind: z.literal('orders_due_soon'),
	orgId,
	eventId,
	locationId,
	orderNumbers: z.array(orderNumber).min(1).max(20),
	/** The earliest start time of them (epoch ms). */
	dueAtMs: z.number().int().positive(),
})

export const ordersPaymentReviewEventSchema = z.strictObject({
	kind: z.literal('orders_payment_review'),
	orgId,
	eventId,
	locationId,
	orderNumber,
})

/** A scheduled large order, a set time before it starts (#300). */
export const largeOrderSoonEventSchema = z.strictObject({
	kind: z.literal('large_order_soon'),
	orgId,
	eventId,
	locationId,
	orderNumber,
	fulfillment: z.enum(['pickup', 'delivery']),
	scheduledForMs: z.number().int().positive(),
	totalCents: z.number().int().nonnegative().max(1_000_000_000),
	currency,
	dishCount: z.number().int().nonnegative().max(10_000),
})

export const stationOfflineEventSchema = z.strictObject({
	kind: z.literal('station_offline'),
	orgId,
	eventId,
	locationId: locationId.nullable(),
	deviceId: z.string().min(1).max(64),
	/** The tablet's name as a manager typed it ("Kitchen"), never a person's. */
	deviceLabel: z.string().trim().min(1).max(60),
	state: z.enum(['offline', 'back_online']),
	/** Whole minutes silent (offline) or offline for (back online). */
	minutes: z.number().int().nonnegative().max(100_000),
	/** Every kitchen tablet of the location is offline and an order is waiting. */
	allKitchenOffline: z.boolean(),
	/** The waiting order that makes it critical (an order number). */
	waitingOrderNumber: orderNumber.nullable(),
})

export const ordersNotifyEventSchema = z.discriminatedUnion('kind', [
	orderPlacedEventSchema,
	ordersWaitingEventSchema,
	ordersDueSoonEventSchema,
	ordersPaymentReviewEventSchema,
	largeOrderSoonEventSchema,
	stationOfflineEventSchema,
])
export type OrdersNotifyEvent = z.infer<typeof ordersNotifyEventSchema>
export type OrderPlacedEvent = z.infer<typeof orderPlacedEventSchema>

export const ordersNotifyResultSchema = z.strictObject({
	inApp: z.number().int().nonnegative(),
	emailed: z.number().int().nonnegative(),
	pushed: z.number().int().nonnegative(),
	texted: z.number().int().nonnegative(),
	skipped: z.string().max(60).optional(),
})
export type OrdersNotifyResult = z.infer<typeof ordersNotifyResultSchema>

/** What the region needs to know before it looks for anything to alert about. */
export const ordersAlertSettingsSchema = z.object({
	/** The organization's `orders.manager_alerts` flag. */
	enabled: z.boolean(),
	locations: z.array(
		z.object({
			id: z.string(),
			/** #131: minutes an order may stay New before managers hear of it. */
			waitingMinutes: z.number().int().min(1).max(MAX_ORDER_ALERT_MINUTES),
			/**
			 * When the location is open (store hours, epoch ms, yesterday to
			 * tomorrow), or null when its hours are not set. The region applies the
			 * alert margins (an hour for orders, half an hour for tablets) itself.
			 */
			openIntervals: z
				.array(z.object({ startMs: z.number(), endMs: z.number() }))
				.nullable(),
			/** #300: the alert threshold, when "tell me about large orders" is on. */
			largeOrder: z
				.object({
					itemThreshold: z.number().int().positive().optional(),
					amountThresholdMinor: z.number().int().positive().optional(),
					/** Minutes before a scheduled large order starts that it is told about again. */
					remindMinutes: z
						.number()
						.int()
						.min(5)
						.max(24 * 60),
				})
				.nullable(),
		}),
	),
})
export type OrdersAlertSettings = z.infer<typeof ordersAlertSettingsSchema>

export const alertKeywordEventSchema = z.strictObject({
	keyword: z.enum(['stop', 'start']),
	/** HMAC of the E.164 number (see `alertPhoneHash`); the number itself never travels. */
	phoneHash: z.string().regex(/^[a-f0-9]{64}$/),
	providerMessageId: z.string().min(1).max(120),
})
export type AlertKeywordEvent = z.infer<typeof alertKeywordEventSchema>

// ---------------------------------------------------------------------------
// Large orders (#300)
// ---------------------------------------------------------------------------

/** The thresholds that make an order large for alerts. Either may be missing. */
export type LargeOrderAlertRule = {
	itemThreshold?: number
	amountThresholdMinor?: number
}

/**
 * Strictly over a threshold, like the existing large-order rule: more than
 * `itemThreshold` dishes, or an item subtotal over `amountThresholdMinor`
 * (minor units, before tax, tip, delivery and discounts).
 */
export function isLargeForAlert(
	rule: LargeOrderAlertRule | null | undefined,
	order: { subtotalCents: number; itemCount: number },
): boolean {
	if (!rule) return false
	if (
		rule.itemThreshold !== undefined &&
		order.itemCount > rule.itemThreshold
	) {
		return true
	}
	return (
		rule.amountThresholdMinor !== undefined &&
		order.subtotalCents > rule.amountThresholdMinor
	)
}

const largeOrderAlertRuleSchema = z.object({
	itemThreshold: z.number().int().positive().optional(),
	amountThresholdMinor: z.number().int().positive().optional(),
})

/**
 * One location's alert threshold from the order context's `largeOrderAlert`.
 * Fails safe: anything missing or malformed is no rule, so nothing is flagged
 * and ordering is never blocked.
 */
export function readLargeOrderAlertRule(
	value: unknown,
	locationId: string,
): LargeOrderAlertRule | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	if (!Object.prototype.hasOwnProperty.call(value, locationId)) return null
	const parsed = largeOrderAlertRuleSchema.safeParse(
		(value as Record<string, unknown>)[locationId],
	)
	if (!parsed.success) return null
	const rule = parsed.data
	return rule.itemThreshold === undefined &&
		rule.amountThresholdMinor === undefined
		? null
		: rule
}

export const largeOrderAlertSettingsSchema = z.object({
	enabled: z.boolean().default(false),
	/** Dishes: more than this many. Missing means "use the location's own threshold". */
	itemThreshold: z
		.number()
		.int()
		.positive()
		.max(10_000)
		.nullable()
		.default(null),
	/** An item subtotal over this, in the location's currency units (not minor). */
	amountThreshold: z
		.number()
		.positive()
		.max(10_000_000)
		.nullable()
		.default(null),
	remindMinutes: z
		.number()
		.int()
		.min(5)
		.max(24 * 60)
		.default(LARGE_ORDER_SOON_MINUTES),
})
export type LargeOrderAlertSettings = z.infer<
	typeof largeOrderAlertSettingsSchema
>

/**
 * The rule a location alerts on. The alert's own thresholds win. With none, the
 * location's existing large-order rule is the default: the dish count and item
 * amount of the "Large orders add prep time" rule (`saved`, #355), or its older
 * single threshold (an amount in major units, or a dish count). A restaurant
 * that already said "more than 8 items" gets the alert without saying it twice.
 */
export function largeOrderAlertRule(input: {
	alert: Partial<LargeOrderAlertSettings> | null | undefined
	/** The #355 rule: a dish count and/or an item amount in minor units. */
	saved?: {
		itemThreshold?: number | null
		amountMinor?: number | null
	} | null
	threshold: number | null | undefined
	thresholdType: string | null | undefined
}): LargeOrderAlertRule | null {
	const items =
		typeof input.alert?.itemThreshold === 'number'
			? Math.floor(input.alert.itemThreshold)
			: undefined
	const amountMinor =
		typeof input.alert?.amountThreshold === 'number' &&
		input.alert.amountThreshold > 0
			? Math.round(input.alert.amountThreshold * 100)
			: undefined
	if (items !== undefined || amountMinor !== undefined) {
		return {
			...(items !== undefined && items > 0 ? { itemThreshold: items } : {}),
			...(amountMinor !== undefined && amountMinor > 0
				? { amountThresholdMinor: amountMinor }
				: {}),
		}
	}
	const savedItems =
		typeof input.saved?.itemThreshold === 'number' &&
		input.saved.itemThreshold > 0
			? Math.floor(input.saved.itemThreshold)
			: undefined
	const savedAmount =
		typeof input.saved?.amountMinor === 'number' && input.saved.amountMinor > 0
			? Math.floor(input.saved.amountMinor)
			: undefined
	if (savedItems !== undefined || savedAmount !== undefined) {
		return {
			...(savedItems !== undefined ? { itemThreshold: savedItems } : {}),
			...(savedAmount !== undefined
				? { amountThresholdMinor: savedAmount }
				: {}),
		}
	}
	const base = input.threshold
	if (typeof base !== 'number' || !Number.isFinite(base) || base <= 0) {
		return null
	}
	if (input.thresholdType === 'items') {
		return { itemThreshold: Math.floor(base) }
	}
	return { amountThresholdMinor: Math.round(base * 100) }
}

// ---------------------------------------------------------------------------
// Quiet hours, snooze, thresholds and the preview (#366)
// ---------------------------------------------------------------------------

export type AlertPolicySettings = {
	/** `HH:MM` local, when alerts start being held. Null with `quietEnd`: no quiet hours. */
	quietStart: string | null
	quietEnd: string | null
	/** The member's IANA zone for the quiet hours. */
	timeZone: string | null
	/** Epoch ms; alerts are snoozed until then. */
	snoozedUntil: number | null
}

export const EMPTY_ALERT_POLICY: AlertPolicySettings = {
	quietStart: null,
	quietEnd: null,
	timeZone: null,
	snoozedUntil: null,
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

export function isHhmm(value: unknown): value is string {
	return typeof value === 'string' && HHMM.test(value)
}

function toMinutes(value: string): number {
	const [h, m] = value.split(':').map(Number) as [number, number]
	return h * 60 + m
}

function policyZone(settings: AlertPolicySettings): string {
	return settings.timeZone && isValidTimeZone(settings.timeZone)
		? settings.timeZone
		: 'UTC'
}

export function hasQuietHours(settings: AlertPolicySettings): boolean {
	return (
		isHhmm(settings.quietStart) &&
		isHhmm(settings.quietEnd) &&
		settings.quietStart !== settings.quietEnd
	)
}

/** Whether `nowMs` falls inside the member's quiet hours (the window may wrap midnight). */
export function inQuietHours(
	settings: AlertPolicySettings,
	nowMs: number,
): boolean {
	if (!hasQuietHours(settings)) return false
	const parts = localParts(nowMs, policyZone(settings))
	const minute = parts.hour * 60 + parts.minute
	const start = toMinutes(settings.quietStart!)
	const end = toMinutes(settings.quietEnd!)
	return start < end
		? minute >= start && minute < end
		: minute >= start || minute < end
}

/** The next instant quiet hours end, or null when they are not active. */
export function quietHoursEnd(
	settings: AlertPolicySettings,
	nowMs: number,
): number | null {
	if (!inQuietHours(settings, nowMs)) return null
	const zone = policyZone(settings)
	const parts = localParts(nowMs, zone)
	const end = toMinutes(settings.quietEnd!)
	const minute = parts.hour * 60 + parts.minute
	const today = `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
	const endDate = minute < end ? today : addDays(today, 1)
	const { year, month, day } = parseDate(endDate)
	return zonedLocalToUtc(year, month, day, Math.floor(end / 60), end % 60, zone)
}

export const SNOOZE_OPTIONS = ['1h', 'tomorrow', 'custom'] as const
export type SnoozeOption = (typeof SNOOZE_OPTIONS)[number]
/** "Until tomorrow" ends at this local time the next morning. */
export const SNOOZE_TOMORROW_HOUR = 6
export const MAX_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000

/** The instant a snooze ends, or null when a custom end is missing or not in the future. */
export function snoozeEnd(
	option: SnoozeOption,
	nowMs: number,
	timeZone: string | null,
	customUntilMs?: number | null,
): number | null {
	if (option === '1h') return nowMs + 60 * 60 * 1000
	if (option === 'custom') {
		if (typeof customUntilMs !== 'number' || !Number.isFinite(customUntilMs)) {
			return null
		}
		if (customUntilMs <= nowMs) return null
		return Math.min(customUntilMs, nowMs + MAX_SNOOZE_MS)
	}
	const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC'
	const parts = localParts(nowMs, zone)
	const today = `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
	const { year, month, day } = parseDate(addDays(today, 1))
	return zonedLocalToUtc(year, month, day, SNOOZE_TOMORROW_HOUR, 0, zone)
}

export type DeliveryDecision =
	/** Send on every channel the member chose. */
	| { outcome: 'deliver' }
	/** Critical: always on, never held, never snoozed. */
	| { outcome: 'critical' }
	/** Snoozed: the in-app row and the log only. */
	| { outcome: 'snoozed'; until: number }
	/** Quiet hours: the in-app row and the log now, push/email/text when they end. */
	| { outcome: 'held'; until: number }
	/** Fewer than the threshold happened in the hour: nothing, only the log. */
	| { outcome: 'below_threshold' }

/**
 * The one decision for whether an alert is delivered now. `occurrencesInHour`
 * counts this alert and the earlier ones of the same kind in the last hour.
 * Critical comes first, then the threshold, then snooze, then quiet hours.
 */
export function decideDelivery(input: {
	settings: AlertPolicySettings
	critical: boolean
	nowMs: number
	threshold?: number | null
	occurrencesInHour?: number
}): DeliveryDecision {
	if (input.critical) return { outcome: 'critical' }
	const threshold = input.threshold ?? 1
	if (threshold > 1 && (input.occurrencesInHour ?? 1) < threshold) {
		return { outcome: 'below_threshold' }
	}
	const snoozed = input.settings.snoozedUntil
	if (snoozed !== null && snoozed > input.nowMs) {
		return { outcome: 'snoozed', until: snoozed }
	}
	const quietEnds = quietHoursEnd(input.settings, input.nowMs)
	if (quietEnds !== null) return { outcome: 'held', until: quietEnds }
	return { outcome: 'deliver' }
}

export type AlertPreview = {
	/** Occurrences looked at. */
	occurrences: number
	/** Alerts that would reach the member at once. */
	delivered: number
	/** Alerts held for the end of quiet hours. */
	held: number
	/** Occurrences below the threshold, so nothing would be sent. */
	belowThreshold: number
	days: number
	/** About how many alerts a day arrive at once. */
	perDay: number
}

/**
 * "Roughly how many alerts would these settings produce": the same decision
 * as {@link decideDelivery} run over the occurrences of the last `days` days
 * (timestamps in epoch ms). Snooze is a temporary state and not part of it.
 */
export function previewAlertCount(input: {
	occurrences: readonly number[]
	settings: AlertPolicySettings
	threshold?: number | null
	days?: number
}): AlertPreview {
	const days = Math.max(1, input.days ?? 7)
	const sorted = [...input.occurrences].sort((a, b) => a - b)
	let delivered = 0
	let held = 0
	let below = 0
	const window: number[] = []
	for (const at of sorted) {
		window.push(at)
		while (window.length > 0 && at - window[0]! >= THRESHOLD_WINDOW_MS) {
			window.shift()
		}
		const decision = decideDelivery({
			settings: { ...input.settings, snoozedUntil: null },
			critical: false,
			nowMs: at,
			threshold: input.threshold,
			occurrencesInHour: window.length,
		})
		if (decision.outcome === 'below_threshold') below++
		else if (decision.outcome === 'held') held++
		else delivered++
	}
	return {
		occurrences: sorted.length,
		delivered,
		held,
		belowThreshold: below,
		days,
		perDay: Math.round((delivered / days) * 10) / 10,
	}
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

/** The reserved `NotificationPreference.workflow` that holds a member's person-level settings. */
export const ALERT_SETTINGS_WORKFLOW = 'alerts.settings'

export const alertSettingsInputSchema = z.object({
	quietStart: z.string().regex(HHMM).nullable(),
	quietEnd: z.string().regex(HHMM).nullable(),
	timeZone: z
		.string()
		.min(1)
		.max(80)
		.refine((value) => isValidTimeZone(value), { error: 'invalid_time_zone' })
		.nullable(),
})

export const thresholdInputSchema = z.object({
	workflow: z.enum(THRESHOLD_KINDS),
	/** 1 means every time. */
	threshold: z.number().int().min(1).max(MAX_ALERT_THRESHOLD),
})

/**
 * Email and in-app when the member never chose. New orders reach the bell but
 * do not email every manager for every order; everything else is on.
 */
export function defaultAlertChannels(kind: OrderAlertKind): {
	inApp: boolean
	email: boolean
} {
	return { inApp: true, email: kind !== 'orders_new' }
}

/**
 * Whether a push goes out when the member never chose: new orders is on for
 * owners and managers, everything else off until the member switches it on.
 * Critical kinds are always on.
 */
export function defaultPushEnabled(
	category: PushCategory,
	isManager: boolean,
): boolean {
	if (category === 'payment_review') return true
	return (category === 'new_orders' || category === 'large_orders') && isManager
}

// ---------------------------------------------------------------------------
// Recipients (#241)
// ---------------------------------------------------------------------------

export const ALERT_RECIPIENT_KINDS = ['email', 'phone'] as const
export type AlertRecipientKind = (typeof ALERT_RECIPIENT_KINDS)[number]

/** Digits and a leading plus, the way the provider reports the sender. */
export function alertPhoneForHash(phone: string): string {
	return phone.replace(/[^\d+]/g, '')
}

/** The value committed in the `.env.schema` files. Refused outside development and test. */
export const DEV_ORDER_ALERT_HASH_SECRET =
	'dev-order-alert-hash-secret-do-not-use-in-prod-32b'
export const ORDER_ALERT_HASH_SECRET_MIN_LENGTH = 32

/**
 * The key for `alertPhoneHash` and the one-time-code hash, from
 * `ORDER_ALERT_HASH_SECRET`. Its own secret on purpose: `INTERNAL_COMMAND_TOKEN`
 * is held by every node and the cron worker, and rotating it must not silently
 * break STOP matching. Empty (unusable) when it is missing, short, equal to the
 * internal token, or still the development default outside development and test.
 */
export function resolveOrderAlertHashSecret(input: {
	secret: string | undefined | null
	internalCommandToken?: string | undefined | null
	placeholderAllowed: boolean
}): string {
	const secret = input.secret ?? ''
	if (secret.length < ORDER_ALERT_HASH_SECRET_MIN_LENGTH) return ''
	if (input.internalCommandToken && secret === input.internalCommandToken) {
		return ''
	}
	if (secret === DEV_ORDER_ALERT_HASH_SECRET && !input.placeholderAllowed) {
		return ''
	}
	return secret
}

/**
 * HMAC-SHA256 of the E.164 number, keyed by `ORDER_ALERT_HASH_SECRET` (see
 * `resolveOrderAlertHashSecret`). tenant-api hashes the sender of a STOP reply
 * with it and the App compares against the hash it stored for each text
 * recipient, so a number never travels to match one. The `v1` in the message is
 * the hash version: a rotation adds `v2` beside it.
 */
export async function alertPhoneHash(
	phone: string,
	secret: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(`alert-phone:v1:${alertPhoneForHash(phone)}`),
	)
	return [...new Uint8Array(signature)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

export const ALERT_VERIFY_CODE_LENGTH = 6
export const ALERT_VERIFY_TTL_MS = 10 * 60 * 1000
export const ALERT_VERIFY_MAX_ATTEMPTS = 5
/** At most this many codes per recipient per hour. */
export const ALERT_VERIFY_SENDS_PER_HOUR = 3

// ---------------------------------------------------------------------------
// Tablets (#190)
// ---------------------------------------------------------------------------

/** A tablet renamed "spare" is kept in a drawer: it never alerts and is never listed as offline. */
export function isSpareTablet(label: string): boolean {
	return /\bspare\b/i.test(label)
}

/**
 * Whether `nowMs` is inside the open intervals widened by `marginMs` on each
 * side. `null` intervals mean the location's opening hours are not set:
 * `unknown`, which the caller decides how to treat (an order that just arrived
 * alerts, a silent tablet is not called an outage).
 */
export function withinOpenIntervals(
	openIntervals: ReadonlyArray<{ startMs: number; endMs: number }> | null,
	nowMs: number,
	marginMs: number,
): 'inside' | 'outside' | 'unknown' {
	if (openIntervals === null) return 'unknown'
	return openIntervals.some(
		(interval) =>
			nowMs >= interval.startMs - marginMs && nowMs < interval.endMs + marginMs,
	)
		? 'inside'
		: 'outside'
}
