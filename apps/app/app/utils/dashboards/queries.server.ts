import { createId } from '@paralleldrive/cuid2'
import { getUserImgSrc } from '@repo/common'
import {
	and,
	count,
	Dashboard,
	DashboardShare,
	db,
	eq,
	ne,
	Organization,
	sql,
	User,
	UserImage,
	UserOrganization,
} from '@repo/database'
import {
	defaultHomeConfig,
	emptyDashboardConfig,
	MAX_CUSTOM_DASHBOARDS,
	parseStoredDashboardConfig,
	serializeDashboardConfig,
	type DashboardConfig,
	type DashboardShareAccess,
} from './config.ts'

// Stored for completeness only; the UI always shows a translated "Home".
const HOME_DASHBOARD_NAME = 'Home'

const byDisplayName = sql`lower(coalesce(${User.name}, ${User.username}))`

function homeDashboardWhere(userId: string, organizationId: string) {
	return and(
		eq(Dashboard.organizationId, organizationId),
		eq(Dashboard.ownerId, userId),
		eq(Dashboard.kind, 'home'),
	)
}

function ownedCustomDashboardWhere({
	dashboardId,
	organizationId,
	ownerId,
}: {
	dashboardId: string
	organizationId: string
	ownerId: string
}) {
	return and(
		eq(Dashboard.id, dashboardId),
		eq(Dashboard.organizationId, organizationId),
		eq(Dashboard.ownerId, ownerId),
		eq(Dashboard.kind, 'custom'),
	)
}

/** The user's Home in this org. `id` is null until Home is first saved. */
export async function getHomeDashboard(
	userId: string,
	organizationId: string,
): Promise<{ id: string | null; config: DashboardConfig }> {
	const [row] = await db
		.select({ id: Dashboard.id, config: Dashboard.config })
		.from(Dashboard)
		.where(homeDashboardWhere(userId, organizationId))
		.limit(1)
	if (!row) return { id: null, config: defaultHomeConfig() }
	return { id: row.id, config: parseStoredDashboardConfig(row.config, 'home') }
}

export async function getHomeConfig(userId: string, organizationId: string) {
	const home = await getHomeDashboard(userId, organizationId)
	return home.config
}

/** Creates the Home row on the first save and replaces its config after. */
export async function saveHomeConfig({
	userId,
	organizationId,
	config,
}: {
	userId: string
	organizationId: string
	config: DashboardConfig
}) {
	const serialized = serializeDashboardConfig(config)
	const [row] = await db
		.insert(Dashboard)
		.values({
			organizationId,
			ownerId: userId,
			kind: 'home',
			name: HOME_DASHBOARD_NAME,
			config: serialized,
		})
		.onConflictDoUpdate({
			target: [Dashboard.organizationId, Dashboard.ownerId],
			targetWhere: sql`${Dashboard.kind} = 'home'`,
			set: { config: serialized },
		})
		.returning({ id: Dashboard.id })
	if (!row) throw new Error('Failed to save the Home dashboard')
	return { id: row.id }
}

/** Deleting the row is how Home goes back to the default layout. */
export async function resetHome({
	userId,
	organizationId,
}: {
	userId: string
	organizationId: string
}) {
	await db.delete(Dashboard).where(homeDashboardWhere(userId, organizationId))
}

export type CreateDashboardResult =
	| { ok: true; dashboard: { id: string; name: string } }
	| { ok: false; reason: 'limit-reached' }

export async function createDashboard({
	userId,
	organizationId,
	name,
}: {
	userId: string
	organizationId: string
	name: string
}): Promise<CreateDashboardResult> {
	const now = Date.now()
	const config = serializeDashboardConfig(emptyDashboardConfig())
	const customCount = db
		.select({ value: count() })
		.from(Dashboard)
		.where(
			and(
				eq(Dashboard.organizationId, organizationId),
				eq(Dashboard.ownerId, userId),
				eq(Dashboard.kind, 'custom'),
			),
		)
	// INSERT ... SELECT checks the cap in the same statement as the insert, so
	// concurrent requests cannot both pass it. The organization row is only
	// the one-row source for the SELECT.
	const [created] = await db
		.insert(Dashboard)
		.select(
			db
				.select({
					id: sql<string>`${createId()}`.as('id'),
					organizationId: Organization.id,
					ownerId: sql<string>`${userId}`.as('ownerId'),
					kind: sql<'custom'>`'custom'`.as('kind'),
					name: sql<string>`${name}`.as('name'),
					config: sql<string>`${config}`.as('config'),
					createdAt: sql<number>`${now}`.as('createdAt'),
					updatedAt: sql<number>`${now}`.as('updatedAt'),
				})
				.from(Organization)
				.where(
					and(
						eq(Organization.id, organizationId),
						sql`(${customCount}) < ${MAX_CUSTOM_DASHBOARDS}`,
					),
				),
		)
		.returning({ id: Dashboard.id, name: Dashboard.name })
	if (!created) return { ok: false, reason: 'limit-reached' }
	return { ok: true, dashboard: created }
}

export async function renameDashboard({
	name,
	...target
}: {
	dashboardId: string
	organizationId: string
	ownerId: string
	name: string
}) {
	const updated = await db
		.update(Dashboard)
		.set({ name })
		.where(ownedCustomDashboardWhere(target))
		.returning({ id: Dashboard.id })
	return updated.length > 0
}

/** Shares are removed with the dashboard by the foreign key cascade. */
export async function deleteDashboard(target: {
	dashboardId: string
	organizationId: string
	ownerId: string
}) {
	const deleted = await db
		.delete(Dashboard)
		.where(ownedCustomDashboardWhere(target))
		.returning({ id: Dashboard.id })
	return deleted.length > 0
}

/** Replaces a custom dashboard's config (last write wins). */
export async function saveDashboardConfig({
	dashboardId,
	organizationId,
	config,
}: {
	dashboardId: string
	organizationId: string
	config: DashboardConfig
}) {
	const updated = await db
		.update(Dashboard)
		.set({ config: serializeDashboardConfig(config) })
		.where(
			and(
				eq(Dashboard.id, dashboardId),
				eq(Dashboard.organizationId, organizationId),
				eq(Dashboard.kind, 'custom'),
			),
		)
		.returning({ id: Dashboard.id })
	return updated.length > 0
}

export type SwitcherDashboards = {
	mine: Array<{ id: string; name: string }>
	sharedWithMe: Array<{
		id: string
		name: string
		ownerName: string
		access: DashboardShareAccess
	}>
}

/** Custom dashboards the user owns or has been given, in this org only. */
export async function listDashboardsForSwitcher(
	userId: string,
	organizationId: string,
): Promise<SwitcherDashboards> {
	const byName = sql`lower(${Dashboard.name})`
	const [mine, shared] = await Promise.all([
		db
			.select({ id: Dashboard.id, name: Dashboard.name })
			.from(Dashboard)
			.where(
				and(
					eq(Dashboard.organizationId, organizationId),
					eq(Dashboard.ownerId, userId),
					eq(Dashboard.kind, 'custom'),
				),
			)
			.orderBy(byName, Dashboard.createdAt),
		db
			.select({
				id: Dashboard.id,
				name: Dashboard.name,
				ownerName: User.name,
				ownerUsername: User.username,
				access: DashboardShare.access,
			})
			.from(DashboardShare)
			.innerJoin(Dashboard, eq(Dashboard.id, DashboardShare.dashboardId))
			.innerJoin(User, eq(User.id, Dashboard.ownerId))
			.where(
				and(
					eq(DashboardShare.userId, userId),
					eq(Dashboard.organizationId, organizationId),
					eq(Dashboard.kind, 'custom'),
					ne(Dashboard.ownerId, userId),
				),
			)
			.orderBy(byName, Dashboard.createdAt),
	])
	return {
		mine,
		sharedWithMe: shared.map(({ ownerName, ownerUsername, ...dashboard }) => ({
			...dashboard,
			ownerName: ownerName ?? ownerUsername,
		})),
	}
}

/**
 * Everyone a dashboard is shared with. Recipients who left the org keep their
 * share row but lose access, which `isActiveMember` lets the UI show.
 */
export async function listShares(dashboardId: string) {
	const rows = await db
		.select({
			userId: DashboardShare.userId,
			name: User.name,
			username: User.username,
			imageObjectKey: UserImage.objectKey,
			access: DashboardShare.access,
			membershipActive: UserOrganization.active,
		})
		.from(DashboardShare)
		.innerJoin(Dashboard, eq(Dashboard.id, DashboardShare.dashboardId))
		.innerJoin(User, eq(User.id, DashboardShare.userId))
		.leftJoin(UserImage, eq(UserImage.userId, User.id))
		.leftJoin(
			UserOrganization,
			and(
				eq(UserOrganization.userId, DashboardShare.userId),
				eq(UserOrganization.organizationId, Dashboard.organizationId),
			),
		)
		.where(eq(DashboardShare.dashboardId, dashboardId))
		.orderBy(byDisplayName, User.username)
	return rows.map(({ membershipActive, ...share }) => ({
		...share,
		isActiveMember: membershipActive === true,
	}))
}

export async function upsertShare({
	dashboardId,
	userId,
	access,
	sharedById,
}: {
	dashboardId: string
	userId: string
	access: DashboardShareAccess
	sharedById: string
}) {
	await db
		.insert(DashboardShare)
		.values({ dashboardId, userId, access, sharedById })
		.onConflictDoUpdate({
			target: [DashboardShare.dashboardId, DashboardShare.userId],
			set: { access, sharedById },
		})
}

export async function removeShare({
	dashboardId,
	userId,
}: {
	dashboardId: string
	userId: string
}) {
	const deleted = await db
		.delete(DashboardShare)
		.where(
			and(
				eq(DashboardShare.dashboardId, dashboardId),
				eq(DashboardShare.userId, userId),
			),
		)
		.returning({ userId: DashboardShare.userId })
	return deleted.length > 0
}

/** Active members of the org the owner can share with (everyone but them). */
export async function listShareableMembers(
	organizationId: string,
	ownerId: string,
) {
	return db
		.select({
			id: User.id,
			name: User.name,
			username: User.username,
			imageObjectKey: UserImage.objectKey,
		})
		.from(UserOrganization)
		.innerJoin(User, eq(User.id, UserOrganization.userId))
		.leftJoin(UserImage, eq(UserImage.userId, User.id))
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
				ne(UserOrganization.userId, ownerId),
			),
		)
		.orderBy(byDisplayName, User.username)
}

export type DashboardSharing = {
	shares: Array<{
		userId: string
		name: string | null
		username: string
		image: string | null
		access: DashboardShareAccess
		isActiveMember: boolean
	}>
	members: Array<{
		id: string
		name: string | null
		username: string
		image: string | null
	}>
}

function userImage(objectKey: string | null) {
	return objectKey ? getUserImgSrc(objectKey) : null
}

/** What the owner's Share dialog shows: who has access and who could get it. */
export async function loadDashboardSharing({
	dashboardId,
	organizationId,
	ownerId,
}: {
	dashboardId: string
	organizationId: string
	ownerId: string
}): Promise<DashboardSharing> {
	const [shares, members] = await Promise.all([
		listShares(dashboardId),
		listShareableMembers(organizationId, ownerId),
	])
	return {
		shares: shares.map(({ imageObjectKey, ...share }) => ({
			...share,
			image: userImage(imageObjectKey),
		})),
		members: members.map(({ imageObjectKey, ...member }) => ({
			...member,
			image: userImage(imageObjectKey),
		})),
	}
}

export async function isShareableMember({
	organizationId,
	ownerId,
	userId,
}: {
	organizationId: string
	ownerId: string
	userId: string
}) {
	if (userId === ownerId) return false
	const [membership] = await db
		.select({ userId: UserOrganization.userId })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
			),
		)
		.limit(1)
	return Boolean(membership)
}
