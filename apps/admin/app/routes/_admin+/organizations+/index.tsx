import { Trans } from '@lingui/macro'
import { requireUserWithRole } from '@repo/auth'
import {
	Organization,
	and,
	count,
	db,
	desc,
	isNotNull,
	like,
	or,
	eq,
} from '@repo/database'
import { PageHeader } from '@repo/ui/page-header'
import { useLoaderData } from 'react-router'
import { AdminOrganizationsTable } from '#app/components/admin-organizations-table.tsx'
import { type Route } from './+types/index.ts'

export async function loader({ request }: Route.LoaderArgs) {
	await requireUserWithRole(request, 'admin')

	const url = new URL(request.url)
	const searchQuery = url.searchParams.get('search') || ''
	const subscriptionStatusFilter =
		url.searchParams.get('subscriptionStatus') || ''
	const planFilter = url.searchParams.get('plan') || ''
	const page = parseInt(url.searchParams.get('page') || '1', 10)
	const pageSize = parseInt(url.searchParams.get('pageSize') || '10', 10)

	const where = and(
		searchQuery
			? or(
					like(Organization.name, `%${searchQuery}%`),
					like(Organization.slug, `%${searchQuery}%`),
					like(Organization.description, `%${searchQuery}%`),
				)
			: undefined,
		subscriptionStatusFilter
			? eq(Organization.subscriptionStatus, subscriptionStatusFilter)
			: undefined,
		planFilter ? eq(Organization.planName, planFilter) : undefined,
	)

	// Get organizations with pagination
	const [organizations, totalCount, subscriptionStatuses, planNames] =
		await Promise.all([
			db.query.Organization.findMany({
				where,
				with: {
					images: { limit: 1 },
					organizations: true,
					integrations: true,
				},
				orderBy: desc(Organization.createdAt),
				offset: (page - 1) * pageSize,
				limit: pageSize,
			}),
			db
				.select({ count: count() })
				.from(Organization)
				.where(where)
				.then(([row]) => row?.count ?? 0),
			db
				.select({ subscriptionStatus: Organization.subscriptionStatus })
				.from(Organization)
				.where(isNotNull(Organization.subscriptionStatus))
				.groupBy(Organization.subscriptionStatus),
			db
				.select({ planName: Organization.planName })
				.from(Organization)
				.where(isNotNull(Organization.planName))
				.groupBy(Organization.planName),
		])

	const totalPages = Math.ceil(totalCount / pageSize)

	return {
		organizations: organizations.map((org) => ({
			...org,
			image: org.images[0] ?? null,
			memberCount: org.organizations.filter((u) => u.active).length,
			totalMembers: org.organizations.length,
			noteCount: 0,
			activeIntegrations: org.integrations.filter((i) => i.isActive).length,
			totalIntegrations: org.integrations.length,
		})),
		pagination: {
			page,
			pageSize,
			totalCount,
			totalPages,
		},
		subscriptionStatuses: subscriptionStatuses
			.map((s) => s.subscriptionStatus)
			.filter((s): s is string => s !== null)
			.sort(),
		planNames: planNames
			.map((p) => p.planName)
			.filter((p): p is string => p !== null)
			.sort(),
		filters: {
			search: searchQuery,
			subscriptionStatus: subscriptionStatusFilter,
			plan: planFilter,
		},
	}
}

export default function AdminOrganizationsPage() {
	const data = useLoaderData<typeof loader>()

	return (
		<div className="space-y-6">
			<PageHeader
				title={<Trans>Organizations</Trans>}
				description={<Trans>Manage all organizations in the system</Trans>}
			/>

			<AdminOrganizationsTable
				organizations={data.organizations}
				subscriptionStatuses={data.subscriptionStatuses}
				planNames={data.planNames}
				pagination={data.pagination}
				filters={data.filters}
			/>
		</div>
	)
}
