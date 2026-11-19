import {
	getUserOrganizationPermissions,
	type OrganizationPermissionString,
	userHasOrganizationPermissionClient,
} from '@repo/auth'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { isUnavailableUntilExpired } from '@repo/common/location-availability'
import {
	type FulfillmentOptions,
	type SchedulingOptions,
	type SpecialHour,
} from '@repo/common/location-types'
import {
	and,
	asc,
	db,
	desc,
	eq,
	GbpListingIssue,
	GbpLocationSync,
	gt,
	HomeAttentionDismissal,
	inArray,
	Integration,
	ne,
	Organization,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuItem,
	OrganizationMenuLocationOverride,
} from '@repo/database'
import { weeklyScheduleHasOpenDay } from '@repo/opening-hours'
import { addDays, businessDateOf, startOfLocalDay } from '@repo/zoned-time'
import { getInventoryNavAccess } from '#app/utils/inventory/access.server.ts'
import { publicOrderingControls } from '#app/utils/location/ordering-pause.ts'
import {
	displayLocationName,
	orgDefaultLocale,
} from '#app/utils/location-name.server.ts'
import { loadMenuHealth } from '#app/utils/menu/menu-health.server.ts'
import { menuHealthMeetsGrade } from '#app/utils/menu/menu-health.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { loadCachedReviewRecords } from '#app/utils/reports/review-records.server.ts'
import { resolveReservationsLocationIds } from '#app/utils/reservations/access.server.ts'
import { resolveRestaurantOnlinePayment } from '#app/utils/restaurant-orders/payment-config.server.ts'
import {
	ATTENTION_DISMISS_MS,
	attentionItem,
	isDismissibleKind,
	ORDERING_PAUSED_ALERT_MS,
	orderAttentionItems,
	parseAttentionKey,
	REVIEW_REPLY_WAIT_MS,
	type AttentionData,
	type AttentionItem,
	type AttentionKind,
	type OrderChannel,
	type OverrideKind,
} from './attention.ts'
import { type HomeLocation } from './today.ts'

/**
 * The organization-wide flag a restaurant sets with "Use pay at pickup only"
 * on the launch checklist: no online payments on purpose, so "payments not
 * connected" is not a problem for it.
 */
export const PAY_AT_PICKUP_ONLY_FLAG = 'ordering.pay_at_pickup_only'

const CUSTOM_DOMAIN_BROKEN = new Set(['error', 'blocked', 'moved', 'deleted'])
/** A detector that has not answered by then is skipped for this load. */
const DETECTOR_TIMEOUT_MS = 4_000

export type AttentionOrganization = {
	id: string
	slug: string
	dataRegion: string
	sitePublished: boolean
	customDomain: string | null
	customDomainStatus: string | null
	shopPaymentProvider: string | null
	stripeConnectAccountId: string | null
	stripeConnectChargesEnabled: boolean
	checkoutSubEntityId: string | null
	checkoutChargesEnabled: boolean
	siteLocales: string | null
	siteDefaultLocale: string | null
}

export type AttentionLocation = {
	id: string
	name: string
	timezone: string
	storeHours: string | null
	onlineHours: string | null
	specialHours: string | null
	fulfillmentOptions: string | null
	scheduling: string | null
	orderingPausedAt: Date | null
	orderingPausedUntil: Date | null
	busyExtraPrepMinutes: number | null
	busyUntil: Date | null
}

export type DetectorContext = {
	organization: AttentionOrganization
	/** Active locations the viewer may see. */
	locations: AttentionLocation[]
	/** Whether the organization has locations at all (some detectors need one). */
	hasLocations: boolean
	has: (permission: OrganizationPermissionString) => boolean
	now: Date
}

export type AttentionDetector = {
	kind: AttentionKind
	/** Module flag that must be on (a literal `true`); null for core features. */
	flag: string | null
	/** What the viewer needs to see the item (and so to act on it). */
	permission: OrganizationPermissionString
	detect: (ctx: DetectorContext) => Promise<AttentionItem[]> | AttentionItem[]
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback
	try {
		return (JSON.parse(value) as T) ?? fallback
	} catch {
		return fallback
	}
}

/** Channels switched off; a missing setting means on, like the public menu. */
export function channelsOff(location: {
	fulfillmentOptions: string | null
	scheduling: string | null
}): OrderChannel[] {
	const fulfillment = parseJson<Partial<FulfillmentOptions>>(
		location.fulfillmentOptions,
		{},
	)
	const scheduling = parseJson<Partial<SchedulingOptions>>(
		location.scheduling,
		{},
	)
	const off: OrderChannel[] = []
	if (fulfillment.pickup === false) off.push('pickup')
	if (fulfillment.delivery === false) off.push('delivery')
	if (scheduling.scheduledOrdersEnabled === false) off.push('scheduled')
	return off
}

/** Special hours for the location's today, ending at its local midnight. */
export function specialHoursToday(
	location: { timezone: string; specialHours: string | null },
	now: Date,
): { until: string } | null {
	const entries = parseJson<SpecialHour[]>(location.specialHours, [])
	if (!Array.isArray(entries)) return null
	const zone = location.timezone || 'UTC'
	const today = businessDateOf(now.getTime(), zone)
	if (!entries.some((entry) => entry?.date === today)) return null
	return {
		until: new Date(startOfLocalDay(addDays(today, 1), zone)).toISOString(),
	}
}

const isOff = (
	status: string | null | undefined,
	until: Date | null | undefined,
	now: Date,
) => status !== 'hidden' && !isUnavailableUntilExpired(status, until, now)

type ItemRow = {
	id: string
	availabilityStatus: string
	unavailableUntil: Date | null
}
type OverrideRow = {
	locationId: string
	entityType: string
	entityId: string
	isEnabled: boolean | null
	availabilityStatus: string | null
	unavailableUntil: Date | null
}

/**
 * Dishes sold out at a location right now: switched off by hand or by stock
 * (unavailable, or "unavailable until" not over yet). Hidden dishes and
 * dishes not offered at the location are not sold out. Without locations,
 * the dish's own status.
 */
export function soldOutItemIds(
	items: readonly ItemRow[],
	overrides: readonly OverrideRow[],
	locationId: string | null,
	now: Date,
): string[] {
	const byItem = new Map(
		overrides
			.filter(
				(row) => row.entityType === 'item' && row.locationId === locationId,
			)
			.map((row) => [row.entityId, row]),
	)
	const ids: string[] = []
	for (const item of items) {
		if (item.availabilityStatus === 'hidden') continue
		const override = locationId ? byItem.get(item.id) : undefined
		if (override?.isEnabled === false) continue
		const status = override?.availabilityStatus ?? item.availabilityStatus
		const until = override?.availabilityStatus
			? override.unavailableUntil
			: item.unavailableUntil
		if (isOff(status, until, now)) ids.push(item.id)
	}
	return ids
}

/** Whether any non-drop menu is on sale at the location now. */
export function hasActiveMenu(
	menus: readonly ItemRow[],
	overrides: readonly OverrideRow[],
	locationId: string,
	now: Date,
): boolean {
	return menus.some((menu) => {
		const override = overrides.find(
			(row) =>
				row.entityType === 'menu' &&
				row.entityId === menu.id &&
				row.locationId === locationId,
		)
		if (override?.isEnabled === false) return false
		const status = override?.availabilityStatus ?? menu.availabilityStatus
		const until = override?.availabilityStatus
			? override.unavailableUntil
			: menu.unavailableUntil
		return status !== 'hidden' && isUnavailableUntilExpired(status, until, now)
	})
}

export async function loadMenuAvailability(organizationId: string) {
	const [menus, items, overrides] = await Promise.all([
		db
			.select({
				id: OrganizationMenu.id,
				availabilityStatus: OrganizationMenu.availabilityStatus,
				unavailableUntil: OrganizationMenu.unavailableUntil,
			})
			.from(OrganizationMenu)
			.where(
				and(
					eq(OrganizationMenu.organizationId, organizationId),
					ne(OrganizationMenu.menuType, 'drop'),
				),
			),
		db
			.select({
				id: OrganizationMenuItem.id,
				availabilityStatus: OrganizationMenuItem.availabilityStatus,
				unavailableUntil: OrganizationMenuItem.unavailableUntil,
			})
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId)),
		db
			.select({
				locationId: OrganizationMenuLocationOverride.locationId,
				entityType: OrganizationMenuLocationOverride.entityType,
				entityId: OrganizationMenuLocationOverride.entityId,
				isEnabled: OrganizationMenuLocationOverride.isEnabled,
				availabilityStatus: OrganizationMenuLocationOverride.availabilityStatus,
				unavailableUntil: OrganizationMenuLocationOverride.unavailableUntil,
			})
			.from(OrganizationMenuLocationOverride)
			.where(
				and(
					eq(OrganizationMenuLocationOverride.organizationId, organizationId),
					inArray(OrganizationMenuLocationOverride.entityType, [
						'menu',
						'item',
					]),
				),
			),
	])
	return { menus, items, overrides }
}

const menuAvailabilityCache = new WeakMap<
	DetectorContext,
	ReturnType<typeof loadMenuAvailability>
>()
function menuAvailability(ctx: DetectorContext) {
	let pending = menuAvailabilityCache.get(ctx)
	if (!pending) {
		pending = loadMenuAvailability(ctx.organization.id)
		menuAvailabilityCache.set(ctx, pending)
	}
	return pending
}

/**
 * Control-plane detectors. Each declares the module flag and the permission
 * it needs; an item is shown only to viewers who hold that permission while
 * the flag is on. Regional counts (payment review, call follow-ups,
 * inventory counts) are fetched by the browser; see `RegionalAttentionAccess`.
 */
export const ATTENTION_DETECTORS: readonly AttentionDetector[] = [
	{
		kind: 'payments_not_connected',
		flag: null,
		permission: ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
		async detect({ organization }) {
			if (resolveRestaurantOnlinePayment(organization).enabled) return []
			const payAtPickupOnly = await getFeatureFlag(PAY_AT_PICKUP_ONLY_FLAG, {
				organizationId: organization.id,
			})
			if (payAtPickupOnly === true) return []
			return [
				attentionItem('payments_not_connected', null, {
					href: '/settings/shop',
				}),
			]
		},
	},
	{
		kind: 'ordering_paused',
		flag: null,
		permission: ORG_PERMISSIONS.READ_MENU_ANY,
		detect({ locations, now, has }) {
			return locations.flatMap((location) => {
				const { orderingPause } = publicOrderingControls(location, now)
				const since = location.orderingPausedAt
				if (!orderingPause || !since) return []
				if (now.getTime() - since.getTime() < ORDERING_PAUSED_ALERT_MS)
					return []
				return [
					attentionItem('ordering_paused', location, {
						since: since.toISOString(),
						until: orderingPause.until,
						href: '/orders',
						canResume: has(ORG_PERMISSIONS.UPDATE_MENU_ANY),
					}),
				]
			})
		},
	},
	{
		kind: 'no_active_menu',
		flag: null,
		permission: ORG_PERMISSIONS.UPDATE_MENU_ANY,
		async detect(ctx) {
			const { menus, overrides } = await menuAvailability(ctx)
			return ctx.locations
				.filter(
					(location) => !hasActiveMenu(menus, overrides, location.id, ctx.now),
				)
				.map((location) =>
					attentionItem('no_active_menu', location, { href: '/menu/menus' }),
				)
		},
	},
	{
		kind: 'site_unpublished',
		flag: null,
		permission: ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
		detect({ organization }) {
			return organization.sitePublished
				? []
				: [attentionItem('site_unpublished', null, { href: '/website' })]
		},
	},
	{
		kind: 'custom_domain_error',
		flag: null,
		permission: ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
		detect({ organization }) {
			return organization.customDomain &&
				CUSTOM_DOMAIN_BROKEN.has(organization.customDomainStatus ?? '')
				? [attentionItem('custom_domain_error', null, { href: '/website' })]
				: []
		},
	},
	{
		kind: 'no_hours',
		flag: null,
		permission: ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
		detect({ locations }) {
			return locations
				.filter(
					(location) =>
						!weeklyScheduleHasOpenDay(location.storeHours) &&
						!weeklyScheduleHasOpenDay(location.onlineHours),
				)
				.map((location) =>
					attentionItem('no_hours', location, {
						href: `/settings/locations/${location.id}`,
					}),
				)
		},
	},
	{
		kind: 'menu_health_low',
		flag: null,
		permission: ORG_PERMISSIONS.UPDATE_MENU_ANY,
		async detect({ organization }) {
			const health = await loadMenuHealth(organization)
			// An empty menu is the launch checklist's job, not a low score.
			if (health.itemCount === 0 || menuHealthMeetsGrade(health, 'D')) return []
			const worst = health.checks.find((check) => check.count > 0)
			return [
				attentionItem('menu_health_low', null, {
					score: Math.round(health.score),
					href: worst ? `/menu/items?health=${worst.key}` : '/menu',
				}),
			]
		},
	},
	{
		kind: 'channel_off',
		flag: null,
		permission: ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
		detect({ locations }) {
			return locations.flatMap((location) => {
				const channels = channelsOff(location)
				return channels.length === 0
					? []
					: [
							attentionItem('channel_off', location, {
								channels,
								href: `/settings/locations/${location.id}`,
							}),
						]
			})
		},
	},
	{
		kind: 'dishes_unavailable',
		flag: null,
		permission: ORG_PERMISSIONS.READ_MENU_ANY,
		async detect(ctx) {
			const { items, overrides } = await menuAvailability(ctx)
			const canRestore = ctx.has(ORG_PERMISSIONS.UPDATE_MENU_ANY)
			const scopes: Array<{ id: string; name: string } | null> =
				ctx.hasLocations ? ctx.locations : [null]
			return scopes.flatMap((location) => {
				const count = soldOutItemIds(
					items,
					overrides,
					location?.id ?? null,
					ctx.now,
				).length
				return count === 0
					? []
					: [
							attentionItem('dishes_unavailable', location, {
								count,
								href: '/menu/items',
								canRestore,
							}),
						]
			})
		},
	},
	{
		kind: 'override_active',
		flag: null,
		permission: ORG_PERMISSIONS.READ_MENU_ANY,
		detect({ locations, now }) {
			return locations.flatMap((location) => {
				const overrides: OverrideKind[] = []
				const ends: string[] = []
				const special = specialHoursToday(location, now)
				if (special) {
					overrides.push('special_hours')
					ends.push(special.until)
				}
				const { busyMode } = publicOrderingControls(location, now)
				if (busyMode) {
					overrides.push('busy')
					if (busyMode.until) ends.push(busyMode.until)
				}
				if (overrides.length === 0) return []
				return [
					attentionItem('override_active', location, {
						overrides,
						minutes: busyMode?.extraPrepMinutes ?? null,
						until: ends.sort()[0] ?? null,
						href: busy(overrides)
							? '/orders'
							: `/settings/locations/${location.id}`,
					}),
				]
			})
		},
	},
	{
		kind: 'reviews_unanswered',
		flag: null,
		permission: ORG_PERMISSIONS.READ_WEBSITE_ANY,
		async detect({ organization, now }) {
			// Reviews come from connected listings; without any connection
			// there is nothing to read (and no provider call to make).
			const [connection] = await db
				.select({ id: Integration.id })
				.from(Integration)
				.where(
					and(
						eq(Integration.organizationId, organization.id),
						eq(Integration.isActive, true),
					),
				)
				.limit(1)
			if (!connection) return []
			const loaded = await loadCachedReviewRecords(organization.id)
			const records = loaded?.records ?? []
			const cutoff = now.getTime() - REVIEW_REPLY_WAIT_MS
			const waiting = records.filter((record) => {
				const created = Date.parse(String(record.createdAt))
				return record.replied === false && created <= cutoff
			})
			if (waiting.length === 0) return []
			const oldest = Math.min(
				...waiting.map((record) => Date.parse(String(record.createdAt))),
			)
			return [
				attentionItem('reviews_unanswered', null, {
					count: waiting.length,
					since: new Date(oldest).toISOString(),
					href: '/mailbox?tab=reviews',
				}),
			]
		},
	},
	{
		kind: 'google_listing_status',
		flag: 'gbp.sync',
		permission: ORG_PERMISSIONS.READ_SETTINGS_ANY,
		async detect({ organization, locations }) {
			if (locations.length === 0) return []
			const byId = new Map(locations.map((loc) => [loc.id, loc]))
			const syncs = await db
				.select({
					locationId: GbpLocationSync.organizationLocationId,
					state: GbpLocationSync.state,
					verificationState: GbpLocationSync.verificationState,
					lastError: GbpLocationSync.lastError,
					updatedAt: GbpLocationSync.updatedAt,
				})
				.from(GbpLocationSync)
				.where(
					and(
						eq(GbpLocationSync.organizationId, organization.id),
						inArray(
							GbpLocationSync.organizationLocationId,
							locations.map((l) => l.id),
						),
					),
				)
			const items: AttentionItem[] = []
			for (const sync of syncs) {
				const location = byId.get(sync.locationId)
				if (!location) continue
				const broken =
					sync.state === 'suspended' ||
					sync.state === 'access_lost' ||
					sync.state === 'token_expired' ||
					sync.state === 'not_verified' ||
					sync.verificationState === 'unverified' ||
					Boolean(sync.lastError)
				if (!broken) continue
				items.push(
					attentionItem('google_listing_status', location, {
						since: sync.updatedAt?.toISOString() ?? null,
						href: `/settings/locations/${location.id}?tab=google`,
					}),
				)
			}
			return items
		},
	},
	{
		kind: 'google_listing_issue',
		flag: 'gbp.sync',
		permission: ORG_PERMISSIONS.READ_SETTINGS_ANY,
		async detect({ organization, locations }) {
			if (locations.length === 0) return []
			const byId = new Map(locations.map((loc) => [loc.id, loc]))
			const issues = await db
				.select({
					locationId: GbpListingIssue.organizationLocationId,
					createdAt: GbpListingIssue.createdAt,
				})
				.from(GbpListingIssue)
				.where(
					and(
						eq(GbpListingIssue.organizationId, organization.id),
						eq(GbpListingIssue.status, 'open'),
						inArray(
							GbpListingIssue.organizationLocationId,
							locations.map((l) => l.id),
						),
					),
				)
			const grouped = new Map<string, { count: number; oldest: number }>()
			for (const issue of issues) {
				const ts = issue.createdAt.getTime()
				const prev = grouped.get(issue.locationId)
				if (prev) {
					prev.count += 1
					if (ts < prev.oldest) prev.oldest = ts
				} else {
					grouped.set(issue.locationId, { count: 1, oldest: ts })
				}
			}
			const items: AttentionItem[] = []
			for (const [locationId, summary] of grouped) {
				const location = byId.get(locationId)
				if (!location) continue
				items.push(
					attentionItem('google_listing_issue', location, {
						count: summary.count,
						since: new Date(summary.oldest).toISOString(),
						href: `/settings/locations/${location.id}?tab=google`,
					}),
				)
			}
			return items
		},
	},
]

function busy(overrides: readonly OverrideKind[]) {
	return overrides.includes('busy') && !overrides.includes('special_hours')
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('timeout')), ms)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

/**
 * Runs every detector the viewer may see. A detector that fails or does not
 * answer in time is skipped and logged by kind and organization id only; it
 * never blanks the feed.
 */
export async function runAttentionDetectors(
	ctx: DetectorContext,
	detectors: readonly AttentionDetector[] = ATTENTION_DETECTORS,
): Promise<AttentionItem[]> {
	const flags = new Map<string, boolean>()
	for (const flag of new Set(detectors.map((detector) => detector.flag))) {
		if (!flag) continue
		flags.set(
			flag,
			(await getFeatureFlag(flag, { organizationId: ctx.organization.id })) ===
				true,
		)
	}
	const results = await Promise.all(
		detectors.map(async (detector) => {
			if (detector.flag && !flags.get(detector.flag)) return []
			if (!ctx.has(detector.permission)) return []
			try {
				return await withTimeout(
					Promise.resolve(detector.detect(ctx)),
					DETECTOR_TIMEOUT_MS,
				)
			} catch (error) {
				console.error('attention detector failed', {
					kind: detector.kind,
					organizationId: ctx.organization.id,
					reason:
						error instanceof Error ? error.message.slice(0, 80) : 'unknown',
				})
				return []
			}
		}),
	)
	return results.flat()
}

const ATTENTION_ORGANIZATION_COLUMNS = {
	id: Organization.id,
	slug: Organization.slug,
	dataRegion: Organization.dataRegion,
	sitePublished: Organization.sitePublished,
	customDomain: Organization.customDomain,
	customDomainStatus: Organization.customDomainStatus,
	shopPaymentProvider: Organization.shopPaymentProvider,
	stripeConnectAccountId: Organization.stripeConnectAccountId,
	stripeConnectChargesEnabled: Organization.stripeConnectChargesEnabled,
	checkoutSubEntityId: Organization.checkoutSubEntityId,
	checkoutChargesEnabled: Organization.checkoutChargesEnabled,
	siteLocales: Organization.siteLocales,
	siteDefaultLocale: Organization.siteDefaultLocale,
}

export async function loadAttentionOrganization(
	organizationId: string,
): Promise<AttentionOrganization | null> {
	const [row] = await db
		.select(ATTENTION_ORGANIZATION_COLUMNS)
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!row) return null
	return {
		...row,
		dataRegion: row.dataRegion || 'us',
		sitePublished: Boolean(row.sitePublished),
		stripeConnectChargesEnabled: Boolean(row.stripeConnectChargesEnabled),
		checkoutChargesEnabled: Boolean(row.checkoutChargesEnabled),
	}
}

/** Active locations of the organization the member may see, default first. */
export async function loadAttentionLocations(
	userId: string,
	organizationId: string,
): Promise<{ locations: AttentionLocation[]; hasLocations: boolean }> {
	const [rows, allowedIds, defaultLocale] = await Promise.all([
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				timezone: OrganizationLocation.timezone,
				storeHours: OrganizationLocation.storeHours,
				onlineHours: OrganizationLocation.onlineHours,
				specialHours: OrganizationLocation.specialHours,
				fulfillmentOptions: OrganizationLocation.fulfillmentOptions,
				scheduling: OrganizationLocation.scheduling,
				orderingPausedAt: OrganizationLocation.orderingPausedAt,
				orderingPausedUntil: OrganizationLocation.orderingPausedUntil,
				busyExtraPrepMinutes: OrganizationLocation.busyExtraPrepMinutes,
				busyUntil: OrganizationLocation.busyUntil,
			})
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, organizationId),
					eq(OrganizationLocation.isActive, true),
				),
			)
			.orderBy(
				desc(OrganizationLocation.isDefault),
				asc(OrganizationLocation.createdAt),
			),
		resolveReservationsLocationIds(userId, organizationId),
		orgDefaultLocale(organizationId),
	])
	return {
		hasLocations: rows.length > 0,
		locations: rows
			.filter((row) => allowedIds === null || allowedIds.includes(row.id))
			.map((row) => ({
				...row,
				name: displayLocationName(row.name, defaultLocale, defaultLocale),
				timezone: row.timezone || 'UTC',
			})),
	}
}

/** The viewer's dismissals that have not expired yet. */
export async function loadActiveDismissals(
	userId: string,
	organizationId: string,
	now: Date,
): Promise<string[]> {
	const rows = await db
		.select({ key: HomeAttentionDismissal.key })
		.from(HomeAttentionDismissal)
		.where(
			and(
				eq(HomeAttentionDismissal.userId, userId),
				eq(HomeAttentionDismissal.organizationId, organizationId),
				gt(HomeAttentionDismissal.dismissedUntil, now),
			),
		)
	return rows.map((row) => row.key)
}

/** A checker over the member's permissions, loaded once. */
export async function loadPermissionChecker(
	userId: string,
	organizationId: string,
) {
	const permissions = await getUserOrganizationPermissions(
		userId,
		organizationId,
	)
	return (permission: OrganizationPermissionString) =>
		userHasOrganizationPermissionClient(permissions, permission)
}

/**
 * Everything the Needs attention block shows for this viewer: control-plane
 * items (dismissals applied, urgent first, at most 20), the viewer's active
 * dismissals (for regional items the browser adds), which regional counts
 * the browser may fetch, and the locations they are read for.
 */
export async function loadAttention({
	userId,
	organization: { id: organizationId },
	now = new Date(),
}: {
	userId: string
	organization: { id: string }
	request?: Request
	now?: Date
}): Promise<AttentionData> {
	const [organization, { locations, hasLocations }, has, dismissedKeys] =
		await Promise.all([
			loadAttentionOrganization(organizationId),
			loadAttentionLocations(userId, organizationId),
			loadPermissionChecker(userId, organizationId),
			loadActiveDismissals(userId, organizationId, now),
		])
	const homeLocations: HomeLocation[] = locations.map((location) => ({
		id: location.id,
		name: location.name,
		timeZone: location.timezone,
	}))
	if (!organization) {
		return {
			items: [],
			dismissedKeys: [],
			regional: {
				paymentReview: false,
				callFollowUps: false,
				inventoryCounts: false,
			},
			locations: [],
		}
	}
	const ctx: DetectorContext = {
		organization,
		locations,
		hasLocations,
		has,
		now,
	}
	const [items, inventory] = await Promise.all([
		runAttentionDetectors(ctx),
		getInventoryNavAccess(userId, organizationId).catch(() => null),
	])
	const scoped = hasLocations && locations.length > 0
	return {
		items: orderAttentionItems(items, dismissedKeys),
		dismissedKeys,
		regional: {
			// The orders token needs menu read; location-scoped tokens see
			// only their locations.
			paymentReview: has(ORG_PERMISSIONS.READ_MENU_ANY),
			callFollowUps: has(ORG_PERMISSIONS.READ_PHONE_CALL_ANY),
			inventoryCounts: Boolean(inventory?.counts) && scoped,
		},
		locations: homeLocations,
	}
}

export type DismissAttentionResult =
	| { ok: true; dismissedUntil: string }
	| { ok: false; error: 'invalid_key' | 'not_dismissible' }

/**
 * "Dismiss for a week": stored per user and item key. Urgent kinds are
 * refused here, server-side, whatever the browser sent. Dismissing again
 * restarts the week.
 */
export async function dismissAttention({
	userId,
	organizationId,
	key,
	now = new Date(),
}: {
	userId: string
	organizationId: string
	key: string
	now?: Date
}): Promise<DismissAttentionResult> {
	const parsed = parseAttentionKey(key)
	if (!parsed) return { ok: false, error: 'invalid_key' }
	if (!isDismissibleKind(parsed.kind)) {
		return { ok: false, error: 'not_dismissible' }
	}
	const dismissedUntil = new Date(now.getTime() + ATTENTION_DISMISS_MS)
	await db
		.insert(HomeAttentionDismissal)
		.values({ userId, organizationId, key, dismissedUntil })
		.onConflictDoUpdate({
			target: [
				HomeAttentionDismissal.userId,
				HomeAttentionDismissal.organizationId,
				HomeAttentionDismissal.key,
			],
			set: { dismissedUntil, createdAt: now },
		})
	return { ok: true, dismissedUntil: dismissedUntil.toISOString() }
}
