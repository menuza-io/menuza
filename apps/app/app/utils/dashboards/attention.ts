import {
	isSpareTablet,
	STATION_ALERT_HOURS_MARGIN_MS,
	STATION_OFFLINE_AFTER_MS,
	withinOpenIntervals,
} from '@repo/common/operator-alerts'
import { z } from 'zod'
import { type HomeLocation } from './today.ts'

/**
 * The home page's Needs attention feed. Items are computed on read from the
 * current state (control-plane detectors on the server, regional counts in
 * the browser); only a member's dismissals are stored. No item carries a
 * guest's name, phone, email or message text: kinds, counts, location ids
 * and names, times and links only.
 */
export const ATTENTION_KINDS = [
	'payments_not_connected',
	'payment_review',
	'ordering_paused',
	'no_active_menu',
	'site_unpublished',
	'custom_domain_error',
	'no_hours',
	'menu_health_low',
	'channel_off',
	'dishes_unavailable',
	'override_active',
	'reviews_unanswered',
	'call_follow_ups',
	'inventory_counts_waiting',
	'station_offline',
	'google_listing_status',
	'google_listing_issue',
	'customer_app_account',
	'customer_app_expiring',
] as const
export type AttentionKind = (typeof ATTENTION_KINDS)[number]

export type AttentionUrgency = 'urgent' | 'todo'

/**
 * Urgency per kind. Urgent items cost orders now and cannot be dismissed;
 * they go away only when fixed. Everything else is advice and can be
 * dismissed for a week.
 */
export const ATTENTION_URGENCY: Record<AttentionKind, AttentionUrgency> = {
	payments_not_connected: 'urgent',
	payment_review: 'urgent',
	ordering_paused: 'urgent',
	no_active_menu: 'urgent',
	site_unpublished: 'todo',
	custom_domain_error: 'todo',
	no_hours: 'todo',
	menu_health_low: 'todo',
	channel_off: 'todo',
	dishes_unavailable: 'todo',
	override_active: 'todo',
	reviews_unanswered: 'todo',
	call_follow_ups: 'todo',
	inventory_counts_waiting: 'todo',
	// A Station tablet silent for five minutes during opening hours (#190): the
	// kitchen may not see orders, so it cannot be dismissed, only fixed.
	station_offline: 'urgent',
	google_listing_status: 'urgent',
	google_listing_issue: 'todo',
	// A failing store account check: updates and the listing are at risk.
	customer_app_account: 'urgent',
	// A developer account expiring within 30 days.
	customer_app_expiring: 'todo',
}

export function isAttentionKind(value: string): value is AttentionKind {
	return (ATTENTION_KINDS as readonly string[]).includes(value)
}

export function isDismissibleKind(kind: AttentionKind) {
	return ATTENTION_URGENCY[kind] !== 'urgent'
}

/** How long "Dismiss for a week" hides an item. */
export const ATTENTION_DISMISS_MS = 7 * 24 * 60 * 60 * 1000
/** The feed shows at most this many items. */
export const ATTENTION_MAX_ITEMS = 20
/** Ordering paused for longer than this becomes an item. */
export const ORDERING_PAUSED_ALERT_MS = 2 * 60 * 60 * 1000
/** A review older than this without a reply becomes an item. */
export const REVIEW_REPLY_WAIT_MS = 48 * 60 * 60 * 1000

/** `kind:location` for a location's item, `kind:org` for an organization's. */
export function attentionKey(kind: AttentionKind, locationId: string | null) {
	return `${kind}:${locationId ?? 'org'}`
}

/** Parses a dismissal key; only well-formed keys of known kinds are accepted. */
export function parseAttentionKey(
	key: string,
): { kind: AttentionKind; locationId: string | null } | null {
	const match = /^([a-z_]+):([\w-]{1,64})$/.exec(key)
	if (!match) return null
	const [, kind, scope] = match
	if (!kind || !scope || !isAttentionKind(kind)) return null
	return { kind, locationId: scope === 'org' ? null : scope }
}

export const ORDER_CHANNELS = ['pickup', 'delivery', 'scheduled'] as const
export type OrderChannel = (typeof ORDER_CHANNELS)[number]

export const OVERRIDES = ['special_hours', 'prep_time', 'busy'] as const
export type OverrideKind = (typeof OVERRIDES)[number]

export type AttentionItem = {
	key: string
	kind: AttentionKind
	urgency: AttentionUrgency
	dismissible: boolean
	locationId: string | null
	locationName: string | null
	/** How many things the item stands for (dishes, orders, reviews). */
	count: number | null
	/** When the problem started, if known (ISO). Newer items sort first. */
	since: string | null
	/** When it ends by itself, if it does (ISO). */
	until: string | null
	/** The screen that fixes it, relative to `/<orgSlug>`. */
	href: string
	/** Channels switched off (`channel_off`). */
	channels?: OrderChannel[]
	/** Overrides in force (`override_active`). */
	overrides?: OverrideKind[]
	/** Busy mode or prep-time minutes added, when the override says so. */
	minutes?: number | null
	/** The worst menu health check, for `?health=` (`menu_health_low`). */
	score?: number
	/** `ordering_paused`: whether this viewer may resume it from the item. */
	canResume?: boolean
	/** `dishes_unavailable`: whether this viewer may mark dishes available. */
	canRestore?: boolean
}

/** Regional counts the browser may fetch for this viewer. */
export type RegionalAttentionAccess = {
	/** Orders in "Payment needs review" (orders token). */
	paymentReview: boolean
	/** Phone calls with an open follow-up (calls token). */
	callFollowUps: boolean
	/** Inventory counts waiting for review (inventory token). */
	inventoryCounts: boolean
	/** Station tablets that went silent (orders token); needs manager alerts on. */
	offlineTablets: boolean
}

export type AttentionData = {
	items: AttentionItem[]
	/** Keys this viewer dismissed and that have not expired yet. */
	dismissedKeys: string[]
	regional: RegionalAttentionAccess
	/** The locations regional counts are read for (the viewer's own). */
	locations: HomeLocation[]
	/**
	 * When each location is open (store hours, epoch ms, yesterday to tomorrow;
	 * null: not set), so the browser can tell a tablet that is off for the night
	 * from one that went silent (#190).
	 */
	openHours: Record<string, Array<{ startMs: number; endMs: number }> | null>
}

/**
 * Urgent first, then newest (`since`), then by key so the order is stable;
 * dismissed items out; at most {@link ATTENTION_MAX_ITEMS}.
 */
export function orderAttentionItems(
	items: readonly AttentionItem[],
	dismissedKeys: readonly string[] = [],
): AttentionItem[] {
	const dismissed = new Set(dismissedKeys)
	return items
		.filter((item) => !(item.dismissible && dismissed.has(item.key)))
		.sort((a, b) => {
			if (a.urgency !== b.urgency) return a.urgency === 'urgent' ? -1 : 1
			const aSince = a.since ? Date.parse(a.since) : Number.NEGATIVE_INFINITY
			const bSince = b.since ? Date.parse(b.since) : Number.NEGATIVE_INFINITY
			if (aSince !== bSince) return bSince - aSince
			return a.key.localeCompare(b.key)
		})
		.slice(0, ATTENTION_MAX_ITEMS)
}

/** Builds an item with the urgency and dismissibility its kind implies. */
export function attentionItem(
	kind: AttentionKind,
	location: { id: string; name: string } | null,
	fields: Partial<
		Omit<AttentionItem, 'key' | 'kind' | 'urgency' | 'dismissible'>
	> & { href: string },
): AttentionItem {
	return {
		key: attentionKey(kind, location?.id ?? null),
		kind,
		urgency: ATTENTION_URGENCY[kind],
		dismissible: isDismissibleKind(kind),
		locationId: location?.id ?? null,
		locationName: location?.name ?? null,
		count: null,
		since: null,
		until: null,
		...fields,
	}
}

export const paymentReviewCountsSchema = z.object({
	locations: z.array(
		z.object({
			locationId: z.string(),
			paymentReview: z.number().int().nonnegative(),
		}),
	),
})

export const callFollowUpsSchema = z.object({
	openFollowUps: z.number().int().nonnegative().catch(0),
})

export const inventoryCountsSchema = z.object({
	counts: z.array(z.object({ status: z.string() }).passthrough()),
})

export const terminalsListSchema = z.object({
	devices: z.array(
		z.object({
			id: z.string(),
			label: z.string(),
			locationId: z.string().nullable(),
			lastSeenAt: z.number().nullable(),
			revokedAt: z.number().nullable(),
		}),
	),
})

/**
 * Offline Station tablets as Needs attention items (#190): one per location
 * with a tablet silent for five minutes inside opening hours plus half an hour.
 * A removed tablet, one called "spare" and one that never connected are left out,
 * and a location with no opening hours set is never called an outage. Names and
 * counts only.
 */
export function offlineTabletItems(input: {
	devices: z.infer<typeof terminalsListSchema>['devices']
	locations: ReadonlyArray<{ id: string; name: string }>
	openHours: AttentionData['openHours']
	now: number
}): AttentionItem[] {
	const byId = new Map(
		input.locations.map((location) => [location.id, location]),
	)
	const perLocation = new Map<string, { count: number; since: number }>()
	for (const device of input.devices) {
		if (device.revokedAt !== null || device.lastSeenAt === null) continue
		if (isSpareTablet(device.label) || device.locationId === null) continue
		if (!byId.has(device.locationId)) continue
		if (input.now - device.lastSeenAt < STATION_OFFLINE_AFTER_MS) continue
		const window = withinOpenIntervals(
			input.openHours[device.locationId] ?? null,
			input.now,
			STATION_ALERT_HOURS_MARGIN_MS,
		)
		if (window !== 'inside') continue
		const entry = perLocation.get(device.locationId)
		perLocation.set(device.locationId, {
			count: (entry?.count ?? 0) + 1,
			since: Math.min(entry?.since ?? Infinity, device.lastSeenAt),
		})
	}
	return [...perLocation].map(([locationId, entry]) =>
		attentionItem('station_offline', byId.get(locationId)!, {
			count: entry.count,
			since: new Date(entry.since).toISOString(),
			href: '/settings/terminals',
		}),
	)
}
