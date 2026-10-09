import { type FulfillmentMode } from './types.ts'

/**
 * The customer's order details (pickup vs delivery, verified delivery
 * address, ASAP vs scheduled time), kept in the browser only.
 *
 * The delivery address is typed in the browser and verified by the regional
 * tenant-api; it lives in `localStorage` like the customer token and never
 * reaches Sites SSR or a cookie (docs/tenant-data-residency.md).
 */

export type OrderDetailsDelivery = {
	quoteToken: string
	expiresAt: string
	formatted: string
	line1: string
	unit?: string
	city: string
	postalCode?: string
	deliveryFee: number
	minimumOrder: number
	zoneName: string
	eta: { min: number; max: number }
}

export type OrderDetails = {
	v: 1
	mode: FulfillmentMode
	locationId: string
	delivery?: OrderDetailsDelivery
	/** ISO-8601 UTC; `null` means ASAP. */
	scheduledFor: string | null
}

export type OrderDetailsTab = 'pickup' | 'delivery' | 'time'

export const ORDER_DETAILS_CHANGE_EVENT = 'menuza:order-details-change'
export const OPEN_ORDER_DETAILS_EVENT = 'menuza:open-order-details'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export const orderDetailsKey = (orgId: string) =>
	`menuza_order_details_${orgId}`
/** Legacy mode key read by `createModeStore`; kept in sync on every write. */
export const legacyModeKey = (orgId: string) => `menuza_mode_${orgId}`

/** A quote this close to expiry is treated as expired so checkout never races it. */
const EXPIRY_SKEW_MS = 60_000

function defaultStorage(): StorageLike | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage
	} catch {
		return null
	}
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isAmount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0

function parseDelivery(value: unknown): OrderDetailsDelivery | undefined {
	if (!value || typeof value !== 'object') return undefined
	const v = value as Record<string, unknown>
	const eta = v.eta as Record<string, unknown> | undefined
	if (
		!isString(v.quoteToken) ||
		!v.quoteToken ||
		!isString(v.expiresAt) ||
		!isString(v.formatted) ||
		!isString(v.line1) ||
		!isString(v.city) ||
		!isString(v.zoneName) ||
		!isAmount(v.deliveryFee) ||
		!isAmount(v.minimumOrder) ||
		!eta ||
		!isAmount(eta.min) ||
		!isAmount(eta.max)
	) {
		return undefined
	}
	return {
		quoteToken: v.quoteToken,
		expiresAt: v.expiresAt,
		formatted: v.formatted,
		line1: v.line1,
		...(isString(v.unit) && v.unit ? { unit: v.unit } : {}),
		city: v.city,
		...(isString(v.postalCode) && v.postalCode
			? { postalCode: v.postalCode }
			: {}),
		deliveryFee: v.deliveryFee,
		minimumOrder: v.minimumOrder,
		zoneName: v.zoneName,
		eta: { min: eta.min, max: eta.max },
	}
}

/** True while the signed quote can still be sent with an order. */
export function isQuoteValid(
	delivery: OrderDetailsDelivery | undefined | null,
	now: Date = new Date(),
): delivery is OrderDetailsDelivery {
	if (!delivery?.quoteToken) return false
	const expires = Date.parse(delivery.expiresAt)
	return Number.isFinite(expires) && expires - EXPIRY_SKEW_MS > now.getTime()
}

/** A scheduled time that has already passed falls back to ASAP. */
function freshSchedule(value: unknown, now: Date): string | null {
	if (!isString(value)) return null
	const at = Date.parse(value)
	return Number.isFinite(at) && at > now.getTime() ? value : null
}

/**
 * Validates stored JSON. Expired quotes and past schedules are dropped so
 * every reader sees only details that can still be ordered with.
 */
export function parseOrderDetails(
	raw: string | null,
	now: Date = new Date(),
): OrderDetails | null {
	if (!raw) return null
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch {
		return null
	}
	if (!value || typeof value !== 'object') return null
	const v = value as Record<string, unknown>
	if (v.v !== 1 || !isString(v.locationId) || !v.locationId) return null
	const mode: FulfillmentMode = v.mode === 'delivery' ? 'delivery' : 'pickup'
	const delivery = parseDelivery(v.delivery)
	return {
		v: 1,
		mode,
		locationId: v.locationId,
		...(isQuoteValid(delivery, now) ? { delivery } : {}),
		scheduledFor: freshSchedule(v.scheduledFor, now),
	}
}

export type LoadOrderDetailsOptions = {
	/** The location the page resolved (URL param → default → first). */
	locationId: string
	allowedModes?: FulfillmentMode[]
	storage?: StorageLike | null
	now?: Date
}

/**
 * Reads the details for this org. Falls back to the legacy mode key, and
 * resets the quote when the page is showing a different location (a quote
 * is only valid for the location it was issued for).
 */
export function loadOrderDetails(
	orgId: string,
	options: LoadOrderDetailsOptions,
): OrderDetails {
	const storage =
		options.storage === undefined ? defaultStorage() : options.storage
	const now = options.now ?? new Date()
	const allowed = options.allowedModes?.length
		? options.allowedModes
		: (['pickup', 'delivery'] as FulfillmentMode[])
	let stored: OrderDetails | null = null
	let legacyMode: string | null = null
	try {
		stored = parseOrderDetails(
			storage?.getItem(orderDetailsKey(orgId)) ?? null,
			now,
		)
		legacyMode = storage?.getItem(legacyModeKey(orgId)) ?? null
	} catch {
		// Storage blocked: start from defaults.
	}
	const base: OrderDetails = stored ?? {
		v: 1,
		mode: legacyMode === 'delivery' ? 'delivery' : 'pickup',
		locationId: options.locationId,
		scheduledFor: null,
	}
	const sameLocation = base.locationId === options.locationId
	const mode = allowed.includes(base.mode)
		? base.mode
		: (allowed[0] ?? 'pickup')
	return {
		v: 1,
		mode,
		locationId: options.locationId,
		...(sameLocation && base.delivery ? { delivery: base.delivery } : {}),
		scheduledFor: sameLocation ? base.scheduledFor : null,
	}
}

/** Delivery is ready to order only with a valid, unexpired quote. */
export function hasValidDeliveryQuote(
	details: OrderDetails | null | undefined,
	now: Date = new Date(),
): boolean {
	return Boolean(details && isQuoteValid(details.delivery, now))
}

type EventTargetLike = Pick<Window, 'dispatchEvent'>

function defaultTarget(): EventTargetLike | null {
	return typeof window === 'undefined' ? null : window
}

/** Persists the details, syncs the legacy mode key, and notifies listeners. */
export function saveOrderDetails(
	orgId: string,
	details: OrderDetails,
	options: {
		storage?: StorageLike | null
		target?: EventTargetLike | null
	} = {},
): OrderDetails {
	const storage =
		options.storage === undefined ? defaultStorage() : options.storage
	const target = options.target === undefined ? defaultTarget() : options.target
	const next: OrderDetails = {
		v: 1,
		mode: details.mode,
		locationId: details.locationId,
		...(details.delivery ? { delivery: details.delivery } : {}),
		scheduledFor: details.scheduledFor ?? null,
	}
	try {
		storage?.setItem(orderDetailsKey(orgId), JSON.stringify(next))
		storage?.setItem(legacyModeKey(orgId), next.mode)
	} catch {
		// Storage full or blocked: listeners still get the in-memory value.
	}
	target?.dispatchEvent(
		new CustomEvent<OrderDetails>(ORDER_DETAILS_CHANGE_EVENT, { detail: next }),
	)
	return next
}

/** Merges a change into the current details and saves the result. */
export function updateOrderDetails(
	orgId: string,
	current: OrderDetails,
	patch: Partial<Omit<OrderDetails, 'v'>>,
	options?: Parameters<typeof saveOrderDetails>[2],
): OrderDetails {
	const merged: OrderDetails = { ...current, ...patch, v: 1 }
	if ('delivery' in patch && !patch.delivery) delete merged.delivery
	return saveOrderDetails(orgId, merged, options)
}

/**
 * Calls `listener` when the details change in this tab (custom event) or in
 * another tab (storage event). Returns an unsubscribe function.
 */
export function subscribeOrderDetails(
	orgId: string,
	listener: (details: OrderDetails | null) => void,
): () => void {
	if (typeof window === 'undefined') return () => {}
	const onChange = (event: Event) => {
		listener((event as CustomEvent<OrderDetails>).detail ?? null)
	}
	const onStorage = (event: StorageEvent) => {
		if (event.key !== orderDetailsKey(orgId)) return
		listener(parseOrderDetails(event.newValue))
	}
	window.addEventListener(ORDER_DETAILS_CHANGE_EVENT, onChange)
	window.addEventListener('storage', onStorage)
	return () => {
		window.removeEventListener(ORDER_DETAILS_CHANGE_EVENT, onChange)
		window.removeEventListener('storage', onStorage)
	}
}

/** Opens the mounted `<OrderDetailsSheet>` on a tab from any script. */
export function openOrderDetails(tab?: OrderDetailsTab): void {
	if (typeof window === 'undefined') return
	window.dispatchEvent(
		new CustomEvent<{ tab?: OrderDetailsTab }>(OPEN_ORDER_DETAILS_EVENT, {
			detail: { tab },
		}),
	)
}
