import {
	and,
	Dashboard,
	DashboardShare,
	db,
	eq,
	User,
	UserOrganization,
} from '@repo/database'
import {
	parseStoredDashboardConfig,
	type DashboardAccess,
	type DashboardConfig,
	type DashboardKind,
} from './config.ts'

export { canEdit, isOwner } from './config.ts'

export type AccessibleDashboard = {
	id: string
	organizationId: string
	ownerId: string
	ownerName: string
	kind: DashboardKind
	name: string
	config: DashboardConfig
}

/**
 * Loads a dashboard the user may open in this organization. The viewer needs
 * an active membership, and a Home dashboard is only ever visible to its
 * owner. Every other case is a 404 so the dashboard's existence is not leaked.
 */
export async function requireDashboardAccess({
	userId,
	organizationId,
	dashboardId,
}: {
	userId: string
	organizationId: string
	dashboardId: string
}): Promise<{ access: DashboardAccess; dashboard: AccessibleDashboard }> {
	const [row] = await db
		.select({
			id: Dashboard.id,
			organizationId: Dashboard.organizationId,
			ownerId: Dashboard.ownerId,
			kind: Dashboard.kind,
			name: Dashboard.name,
			config: Dashboard.config,
			ownerName: User.name,
			ownerUsername: User.username,
			sharedAccess: DashboardShare.access,
		})
		.from(Dashboard)
		.innerJoin(
			UserOrganization,
			and(
				eq(UserOrganization.organizationId, Dashboard.organizationId),
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
			),
		)
		.innerJoin(User, eq(User.id, Dashboard.ownerId))
		.leftJoin(
			DashboardShare,
			and(
				eq(DashboardShare.dashboardId, Dashboard.id),
				eq(DashboardShare.userId, userId),
			),
		)
		.where(
			and(
				eq(Dashboard.id, dashboardId),
				eq(Dashboard.organizationId, organizationId),
			),
		)
		.limit(1)

	let access: DashboardAccess | null = null
	if (row?.ownerId === userId) access = 'owner'
	else if (row?.kind === 'custom') access = row.sharedAccess
	if (!row || !access) throw new Response('Not Found', { status: 404 })

	return {
		access,
		dashboard: {
			id: row.id,
			organizationId: row.organizationId,
			ownerId: row.ownerId,
			ownerName: row.ownerName ?? row.ownerUsername,
			kind: row.kind,
			name: row.name,
			config: parseStoredDashboardConfig(row.config, row.kind),
		},
	}
}

/**
 * Like `requireDashboardAccess`, for the custom dashboard pages. Home is only
 * ever served at the organization's root, so its id is a 404 here too.
 */
export async function requireCustomDashboardAccess(target: {
	userId: string
	organizationId: string
	dashboardId: string
}) {
	const result = await requireDashboardAccess(target)
	if (result.dashboard.kind !== 'custom') {
		throw new Response('Not Found', { status: 404 })
	}
	return result
}
