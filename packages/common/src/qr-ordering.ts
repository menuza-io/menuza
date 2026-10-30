import { z } from 'zod'
import { orderLoyaltySelectionSchema } from './order-loyalty.ts'

/**
 * QR ordering: dine-in table ordering with open tabs, and order-ahead QR
 * posters. Shared, PII-free contracts for App, tenant-api and Sites.
 *
 * A tab's rounds are ordinary `restaurant_orders` rows (`fulfillment:
 * 'dine_in'`, `paymentMethod: 'handoff'`) grouped by a regional `qr_tabs`
 * aggregate; table identity is the regional `qr_tables` registry. Capability
 * tokens are HMAC-derived by tenant-api from `AUTH_HMAC_SECRET` and never
 * stored; this module only knows their wire shape.
 */

// ---------------------------------------------------------------------------
// Feature flags (control plane ConfigFlag, default off, only literal `true`)
// ---------------------------------------------------------------------------

export const QR_ORDERING_FLAG_KEYS = {
	enabled: 'qr_ordering.enabled',
	dineIn: 'qr_ordering.dine_in',
	online: 'qr_ordering.online',
} as const

export type QrOrderingFlagName = keyof typeof QR_ORDERING_FLAG_KEYS
export type QrOrderingFlagKey =
	(typeof QR_ORDERING_FLAG_KEYS)[QrOrderingFlagName]

export const QR_ORDERING_FLAG_KEY_LIST: readonly QrOrderingFlagKey[] =
	Object.values(QR_ORDERING_FLAG_KEYS)

export type QrOrderingFeatures = {
	enabled: boolean
	dineIn: boolean
	online: boolean
}

export const QR_ORDERING_FEATURES_OFF: QrOrderingFeatures = {
	enabled: false,
	dineIn: false,
	online: false,
}

export const qrOrderingFeaturesSchema = z.strictObject({
	enabled: z.boolean(),
	dineIn: z.boolean(),
	online: z.boolean(),
})

/**
 * Folds raw flag values (short or full keys) into features. Only a literal
 * `true` counts, and children are off whenever the master is not on. Paying a
 * tab from the phone needs dine-in as well: there is no tab without it.
 */
export function foldQrOrderingFeatures(
	raw: Partial<Record<QrOrderingFlagName | QrOrderingFlagKey, unknown>>,
): QrOrderingFeatures {
	const read = (name: QrOrderingFlagName) => {
		if (name in raw) return raw[name] === true
		const fullKey = QR_ORDERING_FLAG_KEYS[name]
		if (fullKey in raw) return raw[fullKey] === true
		return false
	}
	const enabled = read('enabled')
	const dineIn = enabled && read('dineIn')
	return { enabled, dineIn, online: dineIn && read('online') }
}

/** Reads the `qrOrdering` block of an order context fail-closed. */
export function readQrOrderingFeatures(raw: unknown): QrOrderingFeatures {
	const parsed = qrOrderingFeaturesSchema.safeParse(raw)
	if (!parsed.success) return QR_ORDERING_FEATURES_OFF
	return foldQrOrderingFeatures(parsed.data)
}

// ---------------------------------------------------------------------------
// Order sources and capability tokens
// ---------------------------------------------------------------------------

/** Where a `restaurant_orders` row came from, beyond the plain online menu. */
export const QR_ORDER_SOURCE_VALUES = ['qr_table', 'qr_poster'] as const
export type QrOrderSource = (typeof QR_ORDER_SOURCE_VALUES)[number]

/** Browser headers that carry the fragment-borne capabilities. */
export const QR_TABLE_TOKEN_HEADER = 'X-Table-Token'
export const QR_TAB_TOKEN_HEADER = 'X-Tab-Token'

/** Largest serialized token we accept: `{uuid}.{version}.{64 hex}`. */
export const QR_TOKEN_MAX_LENGTH = 160

const TOKEN_PATTERN = /^([A-Za-z0-9-]{1,64})\.([1-9]\d{0,8})\.([0-9a-f]{64})$/

export type ParsedQrToken = { id: string; version: number; mac: string }

/** `{id}.{version}.{hmac}`: the id and version say what the HMAC covers. */
export function serializeQrToken(id: string, version: number, mac: string) {
	return `${id}.${version}.${mac}`
}

/** Splits a presented token; anything malformed is `null` (never thrown). */
export function parseQrToken(raw: unknown): ParsedQrToken | null {
	if (typeof raw !== 'string') return null
	const value = raw.trim()
	if (!value || value.length > QR_TOKEN_MAX_LENGTH) return null
	const match = TOKEN_PATTERN.exec(value)
	if (!match) return null
	const version = Number(match[2])
	if (!Number.isSafeInteger(version)) return null
	return { id: match[1]!, version, mac: match[3]! }
}

/** HMAC message for a table token. Bumping the version burns every print. */
export function qrTableTokenMessage(
	orgId: string,
	tableId: string,
	version: number,
) {
	return `qr_table:${orgId}:${tableId}:${version}`
}

/** HMAC message for a tab token. "Lock tab" bumps the version. */
export function qrTabTokenMessage(
	orgId: string,
	tabId: string,
	version: number,
) {
	return `qr_tab:${orgId}:${tabId}:${version}`
}

/** HMAC message for the tab payment capability (hashed at rest). */
export function qrTabPaymentTokenMessage(orgId: string, tabId: string) {
	return `qr_tab_payment:${orgId}:${tabId}`
}

// ---------------------------------------------------------------------------
// Public guest URLs (Sites). Tokens ride in the fragment, never the query.
// ---------------------------------------------------------------------------

/** Dine-in QR: `{origin}/menu?location={id}#table={token}`. */
export function qrTableUrl(
	siteOrigin: string,
	locationId: string,
	tableToken: string,
	extraParams: Record<string, string> = {},
) {
	const url = new URL('/menu', siteOrigin)
	url.searchParams.set('location', locationId)
	for (const [key, value] of Object.entries(extraParams)) {
		url.searchParams.set(key, value)
	}
	url.hash = `table=${tableToken}`
	return url.toString()
}

/** Order-ahead poster QR: `{origin}/menu?location={id}&src=qr`. */
export function qrPosterUrl(
	siteOrigin: string,
	locationId: string,
	extraParams: Record<string, string> = {},
) {
	const url = new URL('/menu', siteOrigin)
	url.searchParams.set('location', locationId)
	url.searchParams.set('src', 'qr')
	for (const [key, value] of Object.entries(extraParams)) {
		url.searchParams.set(key, value)
	}
	return url.toString()
}

// ---------------------------------------------------------------------------
// Tables, settings and tabs (operator contract, /operator/qr/*)
// ---------------------------------------------------------------------------

export const QR_TABLE_LABEL_MAX = 40
export const QR_MAX_TABLES_PER_LOCATION = 500
export const QR_PER_TABLE_LIMIT_DEFAULT = 12
export const QR_PER_TABLE_LIMIT_MAX = 120
export const QR_VOID_REASON_MAX = 200
/**
 * How long a counter close marked as rung up on a Station till stays listed
 * (`GET /operator/qr/tabs?status=station`), so a mistaken mark can be removed.
 */
export const QR_STATION_MARK_LISTED_MS = 24 * 60 * 60 * 1000
export const QR_TAB_STATUS_VALUES = ['open', 'closed', 'cancelled'] as const
export type QrTabStatus = (typeof QR_TAB_STATUS_VALUES)[number]
export const QR_TAB_PAYMENT_STATUS_VALUES = [
	'unpaid',
	'pending',
	'paid',
	'review',
] as const
export type QrTabPaymentStatus = (typeof QR_TAB_PAYMENT_STATUS_VALUES)[number]

const labelSchema = z
	.string()
	.trim()
	.min(1, 'Enter a table label')
	.max(QR_TABLE_LABEL_MAX, 'Keep the label short')

export const qrTableCreateSchema = z.strictObject({
	locationId: z.string().trim().min(1).max(100),
	label: labelSchema,
})

export const qrTableBulkCreateSchema = z.strictObject({
	locationId: z.string().trim().min(1).max(100),
	labels: z.array(labelSchema).min(1).max(200),
})

export const qrTablePatchSchema = z
	.strictObject({
		label: labelSchema.optional(),
		archived: z.boolean().optional(),
		/** Bumps the token version: every printed QR for this table stops working. */
		regenerateToken: z.literal(true).optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: 'Nothing to change',
	})

export const qrFloorPlanImportSchema = z.strictObject({
	locationId: z.string().trim().min(1).max(100),
})

export const qrSettingsPatchSchema = z
	.strictObject({
		requireGuestName: z.boolean().optional(),
		requireGuestPhone: z.boolean().optional(),
		allowOnlineTabPay: z.boolean().optional(),
		perTableLimitPerHour: z
			.number()
			.int()
			.min(1)
			.max(QR_PER_TABLE_LIMIT_MAX)
			.optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: 'Nothing to change',
	})

export type QrSettingsPatch = z.infer<typeof qrSettingsPatchSchema>

export const qrTabCloseSchema = z.strictObject({
	paymentMethod: z.literal('counter'),
	tipCents: z.number().int().min(0).max(10_000_000).optional(),
	/** Staff checked an online payment that landed for review. */
	acknowledgeReview: z.literal(true).optional(),
	/** The total staff saw (before tip): a changed tab answers 409 `stale_tab`. */
	expectedTotalCents: z.number().int().min(0).max(100_000_000).optional(),
	/**
	 * Staff rang the tab up on a Station till: the till sale earns loyalty
	 * points, so the tab itself never does (a purchase counts once).
	 */
	rungUpOnStation: z.boolean().optional(),
})

export const qrTabVoidSchema = z.strictObject({
	reason: z.string().trim().min(1, 'Give a reason').max(QR_VOID_REASON_MAX),
	acknowledgeReview: z.literal(true).optional(),
	expectedTotalCents: z.number().int().min(0).max(100_000_000).optional(),
})

export type QrTableView = {
	id: string
	locationId: string
	label: string
	tokenVersion: number
	/** Present only for writers: the current token, to build a printable QR. */
	token: string | null
	importedRsvTableId: string | null
	archivedAt: string | null
	openTabId: string | null
}

export type QrSettingsView = {
	requireGuestName: boolean
	requireGuestPhone: boolean
	allowOnlineTabPay: boolean
	perTableLimitPerHour: number
}

export const QR_SETTINGS_DEFAULTS: QrSettingsView = {
	requireGuestName: false,
	requireGuestPhone: false,
	allowOnlineTabPay: true,
	perTableLimitPerHour: QR_PER_TABLE_LIMIT_DEFAULT,
}

export type QrTabRoundView = {
	id: string
	number: string
	status: string
	createdAt: string | null
	subtotalCents: number
	taxCents: number
	totalCents: number
	lines: Array<{
		itemName: string
		quantity: number
		totalCents: number
		options: Array<{ optionName: string; quantity: number }>
		instructions: string | null
	}>
}

export type QrTabTotals = {
	currency: string
	subtotalCents: number
	taxCents: number
	/** Tax already contained in the subtotal (VAT-inclusive menus). */
	taxInclusive: boolean
	tipCents: number
	/**
	 * A loyalty reward taken off before tax. Only a tab paid from the phone
	 * carries one (a counter close never does), so it is 0 while the tab is open.
	 */
	loyaltyDiscountCents: number
	totalCents: number
}

/** The guest-facing tab aggregate (`GET /orders/tab`). No contact fields. */
export type QrPublicTab = {
	id: string
	tabNumber: string
	status: QrTabStatus
	paymentStatus: QrTabPaymentStatus
	table: { id: string; label: string; locationId: string }
	openedAt: string
	closedAt: string | null
	rounds: QrTabRoundView[]
	totals: QrTabTotals
	/** True while a round is still `accepted` or `preparing`. */
	roundsPending: boolean
}

// ---------------------------------------------------------------------------
// Paying a tab from the phone (hosted checkout through the order bridge)
// ---------------------------------------------------------------------------

/**
 * A tab rides the restaurant-order payment bridge under a namespaced id, so
 * provider metadata, idempotency, bind-race recovery and reconciliation are
 * the same code paths as for online orders. The region resolves `tab:` ids
 * to the tab; the amount is the tab total plus the guest's tip.
 */
export const QR_TAB_ORDER_PREFIX = 'tab:'

export function tabOrderRef(tabId: string) {
	return `${QR_TAB_ORDER_PREFIX}${tabId}`
}

export function parseTabOrderRef(orderId: string): string | null {
	if (!orderId.startsWith(QR_TAB_ORDER_PREFIX)) return null
	const tabId = orderId.slice(QR_TAB_ORDER_PREFIX.length)
	return /^[A-Za-z0-9-]{1,64}$/.test(tabId) ? tabId : null
}

export const QR_TAB_TIP_PERCENTS = [0, 10, 15, 20] as const

export const qrTabPayRequestSchema = z.strictObject({
	slug: z.string().trim().min(1).max(100).optional(),
	host: z.string().trim().min(1).max(253).optional(),
	tipPercent: z.number().int().min(0).max(30),
	contact: z.strictObject({
		name: z.string().trim().min(1, 'Enter your name').max(120),
		phone: z
			.string()
			.trim()
			.transform((value) => value.replace(/[\s\-().]/g, ''))
			.refine((value) => /^\+?\d{7,20}$/.test(value), {
				message: 'Enter a valid phone number',
			}),
	}),
	/**
	 * A reward the signed-in member spends on the tab (customer token
	 * required). The region re-quotes it on the tab's rounds and takes it off
	 * before tax; a changed reward or cart is refused.
	 */
	loyalty: orderLoyaltySelectionSchema.optional(),
})
export type QrTabPayRequest = z.infer<typeof qrTabPayRequestSchema>
