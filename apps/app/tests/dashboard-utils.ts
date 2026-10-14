import { faker } from '@faker-js/faker'
import { db, Dashboard, DashboardShare, User } from '@repo/database'
import {
	defaultHomeConfig,
	emptyDashboardConfig,
	serializeDashboardConfig,
	type DashboardConfig,
} from '#app/utils/dashboards/config.ts'
import { createUser } from './db-utils.ts'
import { addOrganizationMember, createTestSession } from './test-utils.ts'

/**
 * Inserts a user without a password or roles. Dashboard queries only need the
 * row, and skipping bcrypt keeps multi-user fixtures fast.
 */
export async function insertTestUser(
	overrides: { name?: string | null; username?: string } = {},
) {
	const data = createUser()
	const suffix = faker.string.alphanumeric(6).toLowerCase()
	const username = overrides.username ?? `${data.username}_${suffix}`
	const [user] = await db
		.insert(User)
		.values({
			username,
			email: `${username}@example.com`,
			name: overrides.name === undefined ? data.name : overrides.name,
		})
		.returning()
	if (!user) throw new Error('Failed to create test user')
	return user
}

/** A fast test user who is an active member of the organization and signed in. */
export async function insertTestMember(
	organizationId: string,
	overrides: { name?: string | null } = {},
) {
	const user = await insertTestUser(overrides)
	await addOrganizationMember(user.id, organizationId)
	const { cookie } = await createTestSession(user.id)
	return { user, cookie }
}

export async function insertTestDashboard(input: {
	organizationId: string
	ownerId: string
	kind?: 'home' | 'custom'
	name?: string
	config?: DashboardConfig | string
}) {
	const kind = input.kind ?? 'custom'
	const config =
		input.config ??
		(kind === 'home' ? defaultHomeConfig() : emptyDashboardConfig())
	const [dashboard] = await db
		.insert(Dashboard)
		.values({
			organizationId: input.organizationId,
			ownerId: input.ownerId,
			kind,
			name: input.name ?? (kind === 'home' ? 'Home' : 'Test dashboard'),
			config:
				typeof config === 'string' ? config : serializeDashboardConfig(config),
		})
		.returning()
	if (!dashboard) throw new Error('Failed to create test dashboard')
	return dashboard
}

export async function insertTestShare(input: {
	dashboardId: string
	userId: string
	sharedById: string
	access?: 'view' | 'edit'
}) {
	const [share] = await db
		.insert(DashboardShare)
		.values({
			dashboardId: input.dashboardId,
			userId: input.userId,
			sharedById: input.sharedById,
			access: input.access ?? 'view',
		})
		.returning()
	if (!share) throw new Error('Failed to create test share')
	return share
}
