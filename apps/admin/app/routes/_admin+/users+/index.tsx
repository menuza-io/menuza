import { Trans } from '@lingui/macro'
import { requireUserWithRole } from '@repo/auth'
import {
	Organization as OrganizationTable,
	Session,
	User as UserTable,
	UserOrganization,
	and,
	count,
	db,
	desc,
	eq,
	inArray,
	like,
	or,
} from '@repo/database'
import {
	type Organization,
	type User,
	type UserImage,
} from '@repo/database/types'
import { PageHeader } from '@repo/ui/page-header'
import { useLoaderData } from 'react-router'
import { AdminUsersTable } from '#app/components/admin-users-table.tsx'
import { type Route } from './+types/index.ts'

export async function loader({ request }: Route.LoaderArgs) {
	await requireUserWithRole(request, 'admin')

	const url = new URL(request.url)
	const searchQuery = url.searchParams.get('search') || ''
	const organizationFilter = url.searchParams.get('organization') || ''
	const page = parseInt(url.searchParams.get('page') || '1', 10)
	const pageSize = parseInt(url.searchParams.get('pageSize') || '10', 10)

	const matchingOrganizationUserIds = organizationFilter
		? await db
				.select({ userId: UserOrganization.userId })
				.from(UserOrganization)
				.innerJoin(
					OrganizationTable,
					eq(UserOrganization.organizationId, OrganizationTable.id),
				)
				.where(like(OrganizationTable.name, `%${organizationFilter}%`))
		: []
	const organizationUserIds = matchingOrganizationUserIds.map(
		(row) => row.userId,
	)
	const where = and(
		searchQuery
			? or(
					like(UserTable.name, `%${searchQuery}%`),
					like(UserTable.email, `%${searchQuery}%`),
					like(UserTable.username, `%${searchQuery}%`),
				)
			: undefined,
		organizationFilter ? inArray(UserTable.id, organizationUserIds) : undefined,
	)

	// Get users with pagination
	const [users, totalCount, organizations] = await Promise.all([
		db.query.User.findMany({
			where,
			with: {
				image: { columns: { id: true, altText: true } },
				organizations: {
					with: {
						organization: { columns: { id: true, name: true } },
					},
				},
				sessions: {
					columns: { createdAt: true },
					orderBy: desc(Session.createdAt),
					limit: 1,
				},
			},
			orderBy: desc(UserTable.createdAt),
			offset: (page - 1) * pageSize,
			limit: pageSize,
		}),
		db
			.select({ count: count() })
			.from(UserTable)
			.where(where)
			.then(([row]) => row?.count ?? 0),
		db
			.select({ id: OrganizationTable.id, name: OrganizationTable.name })
			.from(OrganizationTable)
			.orderBy(OrganizationTable.name),
	])

	const totalPages = Math.ceil(totalCount / pageSize)

	return Response.json({
		users: users.map((user) => ({
			...user,
			organizationCount: user.organizations.length,
			lastLoginAt: user.sessions[0]?.createdAt || null,
		})),
		pagination: {
			page,
			pageSize,
			totalCount,
			totalPages,
		},
		organizations,
		filters: {
			search: searchQuery,
			organization: organizationFilter,
		},
	})
}

type LoaderData = {
	users: (Omit<
		User,
		'createdAt' | 'updatedAt' | 'banExpiresAt' | 'bannedAt'
	> & {
		createdAt: string
		updatedAt: string
		banExpiresAt: string | null
		bannedAt: string | null
		image: Pick<UserImage, 'id' | 'altText'> | null
		organizations: {
			organization: Pick<Organization, 'id' | 'name'>
		}[]
		organizationCount: number
		lastLoginAt: string | null
	})[]
	pagination: {
		page: number
		pageSize: number
		totalCount: number
		totalPages: number
	}
	organizations: Pick<Organization, 'id' | 'name'>[]
	filters: {
		search: string
		organization: string
	}
}

export default function AdminUsersPage() {
	const data = useLoaderData() as LoaderData

	return (
		<div className="space-y-6">
			<PageHeader
				title={<Trans>Users</Trans>}
				description={<Trans>Manage all users in the system</Trans>}
			/>

			<AdminUsersTable
				users={data.users}
				organizations={data.organizations}
				pagination={data.pagination}
				filters={data.filters}
			/>
		</div>
	)
}
