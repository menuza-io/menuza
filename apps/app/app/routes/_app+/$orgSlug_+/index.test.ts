import { and, Dashboard, db, eq, UserOrganization } from '@repo/database'
import { describe, expect, it } from 'vitest'
import { defaultHomeConfig } from '#app/utils/dashboards/config.ts'
import { removeBlock } from '#app/utils/dashboards/layout.ts'
import { insertTestDashboard } from '#tests/dashboard-utils.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader } from './index.tsx'

function loadHome(slug: string, cookie: string) {
	const request = createAuthenticatedRequest(
		`http://localhost:3000/${slug}`,
		{},
		cookie,
	)
	return loader({ request, params: { orgSlug: slug }, context: {} } as any)
}

async function homeRowCount(userId: string, organizationId: string) {
	const rows = await db
		.select({ id: Dashboard.id })
		.from(Dashboard)
		.where(
			and(
				eq(Dashboard.ownerId, userId),
				eq(Dashboard.organizationId, organizationId),
				eq(Dashboard.kind, 'home'),
			),
		)
	return rows.length
}

describe('Home dashboard loader', () => {
	it('serves the default Home without creating a row', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('member')

		const data = await loadHome(organization.slug, cookie)

		expect(data.organization).toEqual({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
		})
		expect(data.dashboard).toEqual({
			id: null,
			kind: 'home',
			access: 'owner',
			config: defaultHomeConfig(),
		})
		expect(data.blockData.notes?.points.length).toBeGreaterThanOrEqual(7)
		expect(data.blockData.onboarding).not.toBeNull()
		expect(data.blockData.leaderboard).toEqual([])
		expect(await homeRowCount(user.id, organization.id)).toBe(0)
	})

	it('makes the organization the default one for the user', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')
		const other = await createTestOrganization(user.id, 'admin')
		await db
			.update(UserOrganization)
			.set({ isDefault: true })
			.where(
				and(
					eq(UserOrganization.userId, user.id),
					eq(UserOrganization.organizationId, other.id),
				),
			)

		await loadHome(organization.slug, cookie)

		const memberships = await db
			.select({
				organizationId: UserOrganization.organizationId,
				isDefault: UserOrganization.isDefault,
			})
			.from(UserOrganization)
			.where(eq(UserOrganization.userId, user.id))
		expect(
			memberships.find((row) => row.organizationId === organization.id)
				?.isDefault,
		).toBe(true)
		expect(
			memberships.find((row) => row.organizationId === other.id)?.isDefault,
		).toBe(false)
	})

	it('uses the saved Home and only loads data for its blocks', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')
		const config = removeBlock(
			removeBlock(defaultHomeConfig(), 'leaderboard'),
			'onboarding',
		)
		const home = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: user.id,
			kind: 'home',
			config,
		})

		const data = await loadHome(organization.slug, cookie)

		expect(data.dashboard).toEqual({
			id: home.id,
			kind: 'home',
			access: 'owner',
			config,
		})
		expect(data.blockData.notes).not.toBeNull()
		expect(data.blockData.leaderboard).toBeNull()
		expect(data.blockData.onboarding).toBeNull()
	})

	it("ignores other members' Home dashboards", async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const { user: otherUser } = await setupTestOrgWithUser('admin')
		await db.insert(UserOrganization).values({
			userId: otherUser.id,
			organizationId: organization.id,
			organizationRoleId: 'org_role_member',
		})
		await insertTestDashboard({
			organizationId: organization.id,
			ownerId: otherUser.id,
			kind: 'home',
			config: removeBlock(defaultHomeConfig(), 'stats'),
		})

		const data = await loadHome(organization.slug, cookie)

		expect(data.dashboard.id).toBeNull()
		expect(data.dashboard.config).toEqual(defaultHomeConfig())
	})

	it('returns 404 for an organization the user is not a member of', async () => {
		const { cookie } = await setupTestOrgWithUser('admin')
		const { organization: otherOrganization } =
			await setupTestOrgWithUser('admin')

		const error = await loadHome(otherOrganization.slug, cookie).catch(
			(caught: unknown) => caught,
		)

		expect(error).toBeInstanceOf(Response)
		expect((error as Response).status).toBe(404)
	})
})
