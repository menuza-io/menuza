import {
	getDropDisplayStatus,
	isDropDiscoverable,
	type DropStatus,
	type DropVisibility,
} from '@repo/common/menu-types'
import {
	and,
	db,
	desc,
	eq,
	inArray,
	ne,
	Organization,
	OrganizationDrop,
} from '@repo/database'
import { getClientIp } from '@repo/security'
import { type LoaderFunctionArgs } from 'react-router'
import {
	checkRateLimit,
	createRateLimitResponse,
	PUBLIC_SITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'

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

	const drops = await db
		.select({
			title: OrganizationDrop.title,
			slug: OrganizationDrop.slug,
			description: OrganizationDrop.description,
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
		.limit(12)

	return Response.json(
		{
			drops: drops
				.filter((drop) =>
					isDropDiscoverable(
						drop.status as DropStatus,
						drop.visibility as DropVisibility,
					),
				)
				.map((drop) => ({
					title: drop.title,
					slug: drop.slug,
					description: drop.description,
					coverImageUrl: drop.coverImageUrl,
					status: getDropDisplayStatus(
						drop.status as DropStatus,
						drop.ordersOpenAt,
						drop.ordersCloseAt,
					),
				})),
		},
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}
