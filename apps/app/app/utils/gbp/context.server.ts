/**
 * Shared loading for the Google Business Profile modules (#87 and the
 * features built on it): flags, the location and link rows, what Menuza wants
 * Google to show, and the append-only sync history. Business data only.
 */
import {
	parseActionTargets,
	targetFor,
	type PublicActionTargets,
} from '@repo/common/action-targets'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	type GoogleSpecialHourPeriod,
	desiredOpenStatus,
	localDateIso,
	specialHoursToGoogle,
	weeklyToGooglePeriods,
} from '@repo/common/gbp-hours'
import {
	GBP_FLAGS,
	GbpError,
	connectionStateForError,
} from '@repo/common/gbp-listing'
import { buildLink } from '@repo/common/links'
import {
	DEFAULT_FULFILLMENT_OPTIONS,
	type FulfillmentOptions,
	type LocationAddress,
	type SpecialHour,
	type WeeklySchedule,
} from '@repo/common/location-types'
import {
	and,
	count,
	db,
	eq,
	GbpLocationSync,
	GbpSyncEvent,
	Integration,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { ENV } from 'varlock/env'
import { resolveSitesOrigin } from '#app/utils/sites/sites-origin.server.ts'

export type GbpFlags = {
	sync: boolean
	write: boolean
	insights: boolean
	socialGoogle: boolean
}

/** Only a literal `true` counts. */
export async function gbpFlags(organizationId: string): Promise<GbpFlags> {
	const [sync, write, insights, socialGoogle] = await Promise.all(
		[
			GBP_FLAGS.sync,
			GBP_FLAGS.write,
			GBP_FLAGS.insights,
			GBP_FLAGS.socialGoogle,
		].map((key) => getFeatureFlag(key, { organizationId })),
	)
	return {
		sync: sync === true,
		write: write === true,
		insights: insights === true,
		socialGoogle: socialGoogle === true,
	}
}

export type GbpOrganization = {
	id: string
	slug: string
	name: string
	customDomain: string | null
	customDomainStatus: string | null
	dataRegion: string
	/** Where the Order and Reservations buttons go (#318), JSON. */
	actionTargets?: string | null
}

export type GbpLocationRow = typeof OrganizationLocation.$inferSelect
export type GbpSyncRow = typeof GbpLocationSync.$inferSelect
export type GbpIntegrationRow = typeof Integration.$inferSelect

export type GbpContext = {
	organization: GbpOrganization
	location: GbpLocationRow
	sync: GbpSyncRow
	integration: GbpIntegrationRow | null
	locationCount: number
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback
	try {
		return (JSON.parse(value) as T) ?? fallback
	} catch {
		return fallback
	}
}

export async function loadOrganization(
	organizationId: string,
): Promise<GbpOrganization | null> {
	const [organization] = await db
		.select({
			id: Organization.id,
			slug: Organization.slug,
			name: Organization.name,
			customDomain: Organization.customDomain,
			customDomainStatus: Organization.customDomainStatus,
			dataRegion: Organization.dataRegion,
			actionTargets: Organization.actionTargets,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return organization
		? { ...organization, dataRegion: organization.dataRegion ?? 'us' }
		: null
}

/** The link, the location and the integration, or null when not linked. */
export async function loadGbpContext(
	organizationId: string,
	organizationLocationId: string,
): Promise<GbpContext | null> {
	const [organization, [row], [counted]] = await Promise.all([
		loadOrganization(organizationId),
		db
			.select({ location: OrganizationLocation, sync: GbpLocationSync })
			.from(GbpLocationSync)
			.innerJoin(
				OrganizationLocation,
				eq(OrganizationLocation.id, GbpLocationSync.organizationLocationId),
			)
			.where(
				and(
					eq(GbpLocationSync.organizationId, organizationId),
					eq(GbpLocationSync.organizationLocationId, organizationLocationId),
					eq(OrganizationLocation.organizationId, organizationId),
				),
			)
			.limit(1),
		db
			.select({ total: count() })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, organizationId),
					eq(OrganizationLocation.isActive, true),
				),
			),
	])
	if (!organization || !row) return null
	const [integration] = row.sync.integrationId
		? await db
				.select()
				.from(Integration)
				.where(eq(Integration.id, row.sync.integrationId))
				.limit(1)
		: []
	return {
		organization,
		location: row.location,
		sync: row.sync,
		integration: integration ?? null,
		locationCount: counted?.total ?? 1,
	}
}

export function siteOrigin(organization: GbpOrganization): string {
	return resolveSitesOrigin({
		slug: organization.slug,
		customDomain:
			organization.customDomain && organization.customDomainStatus === 'active'
				? organization.customDomain
				: null,
		baseUrl: ENV.BASE_URL ?? '',
		hostSuffixes: (ENV as { PUBLIC_SITE_HOST_SUFFIXES?: string })
			.PUBLIC_SITE_HOST_SUFFIXES,
	}).replace(/\/$/, '')
}

/** Online ordering is off when neither pickup nor delivery is offered. */
export function onlineOrderingOn(location: GbpLocationRow): boolean {
	if (!location.isActive) return false
	const options = parseJson<Partial<FulfillmentOptions>>(
		location.fulfillmentOptions,
		DEFAULT_FULFILLMENT_OPTIONS,
	)
	return (
		(options.pickup ?? DEFAULT_FULFILLMENT_OPTIONS.pickup) ||
		(options.delivery ?? DEFAULT_FULFILLMENT_OPTIONS.delivery)
	)
}

export type SiteLinks = {
	website: string
	order: string
	reservation: string
}

/**
 * The restaurant's own pages Google should point to: the order page
 * (`/menu`, with `?location=` once there are several), the booking page
 * (`/reserve`), and as the website either the location landing page (#137,
 * when the organization has several locations and the page is on) or the
 * home page.
 */
export function siteLinks(
	organization: GbpOrganization,
	location: Pick<GbpLocationRow, 'id' | 'slug' | 'sitePageEnabled'>,
	locationCount: number,
): SiteLinks {
	const origin = siteOrigin(organization)
	const several = locationCount > 1
	// Google's Order and Reserve buttons go where the site's do (#318): a
	// location's own choice wins, else the organization's.
	const targets: PublicActionTargets = {
		organization: parseActionTargets(organization.actionTargets),
		locations: {
			[location.id]: parseActionTargets(
				(location as { actionTargets?: string | null }).actionTargets,
			),
		},
	}
	const order = targetFor(targets, 'order', location.id)
	const reservation = targetFor(targets, 'reservations', location.id)
	return {
		website:
			several && location.sitePageEnabled
				? `${origin}/locations/${encodeURIComponent(location.slug)}`
				: `${origin}/`,
		order:
			order.mode === 'external'
				? order.url
				: (buildLink('menu_home', several ? { location: location.id } : {}, {
						origin,
					}) ?? origin),
		reservation:
			reservation.mode === 'external'
				? reservation.url
				: (buildLink('reserve', {}, { origin }) ?? origin),
	}
}

export type DesiredListing = {
	hoursPeriods: ReturnType<typeof weeklyToGooglePeriods>
	specialPeriods: GoogleSpecialHourPeriod[]
	phone: string | null
	website: string
	openStatus: 'OPEN' | 'CLOSED_TEMPORARILY'
	links: SiteLinks
	storeHours: WeeklySchedule | null
	specialHours: SpecialHour[]
	address: LocationAddress | null
}

/** What Menuza wants Google to show for a location right now. */
export function desiredListing(ctx: GbpContext, now: Date): DesiredListing {
	const { location, organization } = ctx
	const storeHours = parseJson<WeeklySchedule | null>(location.storeHours, null)
	const specialHours = parseJson<SpecialHour[]>(location.specialHours, [])
	const today = localDateIso(now, location.timezone || 'UTC')
	return {
		hoursPeriods: weeklyToGooglePeriods(storeHours),
		specialPeriods: specialHoursToGoogle(specialHours, today),
		phone: location.phone?.trim() || null,
		website: siteLinks(organization, location, ctx.locationCount).website,
		openStatus: desiredOpenStatus(
			{
				temporarilyClosed: location.temporarilyClosed,
				temporarilyClosedUntil: location.temporarilyClosedUntil,
			},
			now,
		),
		links: siteLinks(organization, location, ctx.locationCount),
		storeHours,
		specialHours,
		address: parseJson<LocationAddress | null>(location.address, null),
	}
}

/** Menuza's address in Google's `storefrontAddress` shape. */
export function addressToGoogle(address: LocationAddress | null) {
	if (!address) return null
	const street = [address.streetNumber, address.streetName]
		.filter(Boolean)
		.join(' ')
		.trim()
	const lines = [street || address.formattedAddress.split(',')[0]?.trim() || '']
	if (address.unit) lines.push(address.unit)
	return {
		addressLines: lines.filter(Boolean),
		locality: address.city || undefined,
		administrativeArea: address.state || undefined,
		postalCode: address.postalCode || undefined,
		regionCode: address.country || undefined,
	}
}

export type GbpEventInput = {
	sync: Pick<GbpSyncRow, 'id' | 'organizationId' | 'organizationLocationId'>
	kind:
		| 'push'
		| 'pull'
		| 'resolve'
		| 'verify'
		| 'menu'
		| 'media'
		| 'attributes'
		| 'links'
	field?: string | null
	actorId?: string | null
	summary: string
	request?: unknown
	result: 'accepted' | 'pending_google' | 'rejected' | 'failed' | 'skipped'
	response?: string | null
}

/** Appends one line to the sync history (never updated afterwards). */
export async function recordGbpEvent(input: GbpEventInput) {
	await db.insert(GbpSyncEvent).values({
		syncId: input.sync.id,
		organizationId: input.sync.organizationId,
		organizationLocationId: input.sync.organizationLocationId,
		kind: input.kind,
		field: input.field ?? null,
		actorId: input.actorId ?? null,
		summary: input.summary.slice(0, 300),
		request:
			input.request === undefined
				? null
				: JSON.stringify(input.request).slice(0, 4000),
		result: input.result,
		response: input.response ? input.response.slice(0, 500) : null,
	})
}

/** Google account and location name for API calls. */
export function googleLocationName(ctx: Pick<GbpContext, 'sync'>): string {
	return ctx.sync.googleLocationName
}

export async function saveSync(
	syncId: string,
	patch: Partial<typeof GbpLocationSync.$inferInsert>,
) {
	await db
		.update(GbpLocationSync)
		.set(patch)
		.where(eq(GbpLocationSync.id, syncId))
}

/** Records a connection problem on the link. Returns the state set, if any. */
export async function recordGbpError(
	ctx: Pick<GbpContext, 'sync'>,
	error: unknown,
): Promise<GbpError | null> {
	if (!(error instanceof GbpError)) return null
	const state = connectionStateForError(error.code)
	await saveSync(ctx.sync.id, {
		...(state ? { state } : {}),
		lastError: error.code,
		...(error.code === 'gbp_not_verified'
			? { verificationState: 'unverified' }
			: {}),
	})
	return error
}
