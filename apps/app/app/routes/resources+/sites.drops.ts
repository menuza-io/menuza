import {
	getDropDisplayStatus,
	isDropDiscoverable,
	type DropStatus,
	type DropVisibility,
} from '@repo/common/menu-types'
import {
	and,
	asc,
	db,
	desc,
	eq,
	inArray,
	ne,
	Organization,
	OrganizationDrop,
	OrganizationDropPickupWindow,
	OrganizationLocation,
	OrganizationMediaAsset,
} from '@repo/database'
import { getClientIp } from '@repo/security'
import { type LoaderFunctionArgs } from 'react-router'
import {
	checkRateLimit,
	createRateLimitResponse,
	PUBLIC_SITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'

const MAX_LISTED_DROPS = 60

export interface PublicDropListing {
	title: string
	slug: string
	description: string | null
	coverImageUrl: string | null
	status: DropStatus
	ordersOpenAt: string | null
	ordersCloseAt: string | null
	pickupDates: string[]
	pickupLocationNames: string[]
	pickupTimezone: string | null
}

const PHASE_RANK: Record<DropStatus, number> = {
	live: 0,
	scheduled: 1,
	closed: 2,
	completed: 2,
	draft: 3,
}

function timeOf(value: Date | null): number | null {
	return value ? value.getTime() : null
}

export async function loader({ request }: LoaderFunctionArgs) {
	const url = new URL(request.url)
	const slug = url.searchParams.get('slug')?.trim().toLowerCase()
	const host = url.searchParams.get('host')?.trim().toLowerCase().split(':')[0]
	if (!slug && !host) throw new Response('Not Found', { status: 404 })

	const rateLimit = await checkRateLimit(
		{ type: 'ip', value: getClientIp(request) },
		PUBLIC_SITE_RATE_LIMIT,
	)
	if (!rateLimit.allowed) return createRateLimitResponse(rateLimit.resetAt)

	const org = await db.query.Organization.findFirst({
		where: and(
			slug
				? eq(Organization.slug, slug)
				: and(
						eq(Organization.customDomain, host!),
						inArray(Organization.customDomainStatus, ['active', 'pending']),
					),
			eq(Organization.active, true),
			eq(Organization.sitePublished, true),
		),
		columns: { id: true },
	})
	if (!org) throw new Response('Not Found', { status: 404 })

	const rows = await db
		.select({
			id: OrganizationDrop.id,
			title: OrganizationDrop.title,
			slug: OrganizationDrop.slug,
			description: OrganizationDrop.description,
			coverImageKey: OrganizationDrop.coverImageKey,
			coverImageUrl: OrganizationDrop.coverImageUrl,
			status: OrganizationDrop.status,
			visibility: OrganizationDrop.visibility,
			ordersOpenAt: OrganizationDrop.ordersOpenAt,
			ordersCloseAt: OrganizationDrop.ordersCloseAt,
		})
		.from(OrganizationDrop)
		.where(
			and(
				eq(OrganizationDrop.organizationId, org.id),
				eq(OrganizationDrop.visibility, 'public'),
				ne(OrganizationDrop.status, 'draft'),
			),
		)
		.orderBy(desc(OrganizationDrop.createdAt))

	const now = new Date()
	const discoverable = rows
		.filter((drop) =>
			isDropDiscoverable(
				drop.status as DropStatus,
				drop.visibility as DropVisibility,
			),
		)
		.map((drop) => ({
			...drop,
			displayStatus: getDropDisplayStatus(
				drop.status as DropStatus,
				drop.ordersOpenAt,
				drop.ordersCloseAt,
				now,
			),
		}))
		.sort((a, b) => {
			const rank = PHASE_RANK[a.displayStatus] - PHASE_RANK[b.displayStatus]
			if (rank !== 0) return rank
			if (a.displayStatus === 'live') {
				// Closing soonest first; drops without a close time go last.
				return (
					(timeOf(a.ordersCloseAt) ?? Infinity) -
					(timeOf(b.ordersCloseAt) ?? Infinity)
				)
			}
			if (a.displayStatus === 'scheduled') {
				return (
					(timeOf(a.ordersOpenAt) ?? Infinity) -
					(timeOf(b.ordersOpenAt) ?? Infinity)
				)
			}
			return (
				(timeOf(b.ordersCloseAt) ?? -Infinity) -
				(timeOf(a.ordersCloseAt) ?? -Infinity)
			)
		})
		.slice(0, MAX_LISTED_DROPS)

	const dropIds = discoverable.map((drop) => drop.id)

	const windows = dropIds.length
		? await db
				.select({
					dropId: OrganizationDropPickupWindow.dropId,
					date: OrganizationDropPickupWindow.date,
					locationName: OrganizationLocation.name,
					timezone: OrganizationLocation.timezone,
				})
				.from(OrganizationDropPickupWindow)
				.innerJoin(
					OrganizationLocation,
					eq(OrganizationLocation.id, OrganizationDropPickupWindow.locationId),
				)
				.where(inArray(OrganizationDropPickupWindow.dropId, dropIds))
				.orderBy(
					asc(OrganizationDropPickupWindow.date),
					asc(OrganizationDropPickupWindow.startTime),
				)
		: []

	const windowsByDrop = new Map<string, typeof windows>()
	for (const window of windows) {
		const list = windowsByDrop.get(window.dropId) ?? []
		list.push(window)
		windowsByDrop.set(window.dropId, list)
	}

	const coverKeys = discoverable.flatMap((drop) =>
		drop.coverImageKey ? [drop.coverImageKey] : [],
	)
	const mediaAssets = coverKeys.length
		? await db
				.select({
					id: OrganizationMediaAsset.id,
					objectKey: OrganizationMediaAsset.objectKey,
					updatedAt: OrganizationMediaAsset.updatedAt,
				})
				.from(OrganizationMediaAsset)
				.where(eq(OrganizationMediaAsset.organizationId, org.id))
		: []
	const mediaMap = new Map<string, string>()
	for (const m of mediaAssets) {
		const mediaUrl = `/resources/images?mediaId=${encodeURIComponent(m.id)}&v=${m.updatedAt.getTime()}`
		mediaMap.set(m.id, mediaUrl)
		mediaMap.set(m.objectKey, mediaUrl)
	}

	const drops: PublicDropListing[] = discoverable.map((drop) => {
		const dropWindows = windowsByDrop.get(drop.id) ?? []
		return {
			title: drop.title,
			slug: drop.slug,
			description: drop.description,
			coverImageUrl: drop.coverImageKey
				? (mediaMap.get(drop.coverImageKey) ?? drop.coverImageUrl)
				: drop.coverImageUrl,
			status: drop.displayStatus,
			ordersOpenAt: drop.ordersOpenAt ? drop.ordersOpenAt.toISOString() : null,
			ordersCloseAt: drop.ordersCloseAt
				? drop.ordersCloseAt.toISOString()
				: null,
			pickupDates: Array.from(new Set(dropWindows.map((w) => w.date))).sort(),
			pickupLocationNames: Array.from(
				new Set(dropWindows.map((w) => w.locationName)),
			),
			pickupTimezone: dropWindows[0]?.timezone ?? null,
		}
	})

	return Response.json({ drops }, { headers: { 'Cache-Control': 'no-store' } })
}
