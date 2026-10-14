import {
	and,
	Dashboard,
	DashboardShare,
	db,
	eq,
	UserOrganization,
} from '@repo/database'
import { describe, expect, it } from 'vitest'
import {
	insertTestDashboard,
	insertTestShare,
	insertTestUser,
} from '#tests/dashboard-utils.ts'
import {
	addOrganizationMember,
	createTestOrganization,
} from '#tests/test-utils.ts'
import {
	defaultHomeConfig,
	emptyDashboardConfig,
	MAX_CUSTOM_DASHBOARDS,
	type DashboardConfig,
} from './config.ts'
import { appendBlock, removeBlock } from './layout.ts'
import {
	createDashboard,
	deleteDashboard,
	getHomeConfig,
	getHomeDashboard,
	isShareableMember,
	listDashboardsForSwitcher,
	listShareableMembers,
	listShares,
	removeShare,
	renameDashboard,
	resetHome,
	saveDashboardConfig,
	saveHomeConfig,
	upsertShare,
} from './queries.server.ts'

const customHome: DashboardConfig = removeBlock(
	defaultHomeConfig(),
	'leaderboard',
)

async function homeRows(userId: string, organizationId: string) {
	return db
		.select()
		.from(Dashboard)
		.where(
			and(
				eq(Dashboard.ownerId, userId),
				eq(Dashboard.organizationId, organizationId),
				eq(Dashboard.kind, 'home'),
			),
		)
}

async function getDashboardRow(id: string) {
	const [row] = await db.select().from(Dashboard).where(eq(Dashboard.id, id))
	return row ?? null
}

async function setupOrg() {
	const owner = await insertTestUser({ name: 'Olive Owner' })
	const organization = await createTestOrganization(owner.id, 'admin')
	return { owner, organization }
}

describe('Home dashboard', () => {
	it('returns the default config without creating a row', async () => {
		const { owner, organization } = await setupOrg()
		const home = await getHomeDashboard(owner.id, organization.id)
		expect(home).toEqual({ id: null, config: defaultHomeConfig() })
		expect(await getHomeConfig(owner.id, organization.id)).toEqual(
			defaultHomeConfig(),
		)
		expect(await homeRows(owner.id, organization.id)).toHaveLength(0)
	})

	it('creates the Home row on the first save and updates it afterwards', async () => {
		const { owner, organization } = await setupOrg()
		const first = await saveHomeConfig({
			userId: owner.id,
			organizationId: organization.id,
			config: customHome,
		})
		const rows = await homeRows(owner.id, organization.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ id: first.id, kind: 'home', name: 'Home' })
		expect(await getHomeDashboard(owner.id, organization.id)).toEqual({
			id: first.id,
			config: customHome,
		})

		const withReport = appendBlock(customHome, {
			id: 'report-1',
			type: 'report',
			config: { source: 'template', templateId: 'customer-count' },
		})
		const second = await saveHomeConfig({
			userId: owner.id,
			organizationId: organization.id,
			config: withReport,
		})
		expect(second.id).toBe(first.id)
		expect(await homeRows(owner.id, organization.id)).toHaveLength(1)
		expect(await getHomeConfig(owner.id, organization.id)).toEqual(withReport)
	})

	it('keeps Home separate for each user and each organization', async () => {
		const { owner, organization } = await setupOrg()
		const colleague = await insertTestUser()
		await addOrganizationMember(colleague.id, organization.id)
		const otherOrganization = await createTestOrganization(owner.id, 'admin')

		await saveHomeConfig({
			userId: owner.id,
			organizationId: organization.id,
			config: customHome,
		})

		expect(await getHomeDashboard(colleague.id, organization.id)).toEqual({
			id: null,
			config: defaultHomeConfig(),
		})
		expect(await getHomeDashboard(owner.id, otherOrganization.id)).toEqual({
			id: null,
			config: defaultHomeConfig(),
		})
		expect(await getHomeConfig(owner.id, organization.id)).toEqual(customHome)
	})

	it('falls back to the default Home when the stored config is invalid', async () => {
		const { owner, organization } = await setupOrg()
		const home = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.id,
			kind: 'home',
			config: '{not json',
		})
		expect(await getHomeDashboard(owner.id, organization.id)).toEqual({
			id: home.id,
			config: defaultHomeConfig(),
		})
	})

	it('removes the Home row on reset', async () => {
		const { owner, organization } = await setupOrg()
		await saveHomeConfig({
			userId: owner.id,
			organizationId: organization.id,
			config: customHome,
		})
		await resetHome({ userId: owner.id, organizationId: organization.id })
		expect(await homeRows(owner.id, organization.id)).toHaveLength(0)
		expect(await getHomeDashboard(owner.id, organization.id)).toEqual({
			id: null,
			config: defaultHomeConfig(),
		})
	})

	it('allows at most one Home row per user and organization', async () => {
		const { owner, organization } = await setupOrg()
		await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.id,
			kind: 'home',
		})
		await expect(
			insertTestDashboard({
				organizationId: organization.id,
				ownerId: owner.id,
				kind: 'home',
			}),
		).rejects.toThrow()
	})
})

describe('custom dashboards', () => {
	it('creates an empty custom dashboard', async () => {
		const { owner, organization } = await setupOrg()
		const result = await createDashboard({
			userId: owner.id,
			organizationId: organization.id,
			name: 'Sales overview',
		})
		if (!result.ok) throw new Error('expected the dashboard to be created')
		expect(result.dashboard).toEqual({
			id: expect.any(String),
			name: 'Sales overview',
		})
		const row = await getDashboardRow(result.dashboard.id)
		expect(row).toMatchObject({
			organizationId: organization.id,
			ownerId: owner.id,
			kind: 'custom',
			name: 'Sales overview',
		})
		expect(JSON.parse(row!.config)).toEqual(emptyDashboardConfig())
	})

	it('limits each user to 25 custom dashboards per organization', async () => {
		const { owner, organization } = await setupOrg()
		const colleague = await insertTestUser()
		await addOrganizationMember(colleague.id, organization.id)
		const otherOrganization = await createTestOrganization(owner.id, 'admin')
		await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.id,
			kind: 'home',
		})
		for (let index = 0; index < MAX_CUSTOM_DASHBOARDS; index++) {
			const created = await createDashboard({
				userId: owner.id,
				organizationId: organization.id,
				name: `Dashboard ${index + 1}`,
			})
			expect(created.ok).toBe(true)
		}

		expect(
			await createDashboard({
				userId: owner.id,
				organizationId: organization.id,
				name: 'One too many',
			}),
		).toEqual({ ok: false, reason: 'limit-reached' })

		const inOtherOrg = await createDashboard({
			userId: owner.id,
			organizationId: otherOrganization.id,
			name: 'Elsewhere',
		})
		expect(inOtherOrg.ok).toBe(true)
		const byColleague = await createDashboard({
			userId: colleague.id,
			organizationId: organization.id,
			name: 'Mine',
		})
		expect(byColleague.ok).toBe(true)
	})

	it('renames only custom dashboards the user owns in the organization', async () => {
		const { owner, organization } = await setupOrg()
		const colleague = await insertTestUser()
		await addOrganizationMember(colleague.id, organization.id)
		const dashboard = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.id,
			name: 'Before',
		})
		const home = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.id,
			kind: 'home',
		})
		const otherOrganization = await createTestOrganization(owner.id, 'admin')

		expect(
			await renameDashboard({
				dashboardId: dashboard.id,
				organizationId: organization.id,
				ownerId: colleague.id,
				name: 'Hijacked',
			}),
		).toBe(false)
		expect(
			await renameDashboard({
				dashboardId: dashboard.id,
				organizationId: otherOrganization.id,
				ownerId: owner.id,
				name: 'Wrong org',
			}),
		).toBe(false)
		expect(
			await renameDashboard({
				dashboardId: home.id,
				organizationId: organization.id,
				ownerId: owner.id,
				name: 'Not home',
			}),
		).toBe(false)
		expect((await getDashboardRow(dashboard.id))?.name).toBe('Before')
		expect((await getDashboardRow(home.id))?.name).toBe('Home')

		expect(
			await renameDashboard({
				dashboardId: dashboard.id,
				organizationId: organization.id,
				ownerId: owner.id,
				name: 'Q3 metrics',
			}),
		).toBe(true)
		expect((await getDashboardRow(dashboard.id))?.name).toBe('Q3 metrics')
	})

	it('deletes only custom dashboards the user owns and removes their shares', async () => {
		const { owner, organization } = await setupOrg()
		const colleague = await insertTestUser()
		await addOrganizationMember(colleague.id, organization.id)
		const dashboard = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.id,
		})
		await insertTestShare({
			dashboardId: dashboard.id,
			userId: colleague.id,
			sharedById: owner.id,
		})
		const home = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.id,
			kind: 'home',
		})

		expect(
			await deleteDashboard({
				dashboardId: dashboard.id,
				organizationId: organization.id,
				ownerId: colleague.id,
			}),
		).toBe(false)
		expect(
			await deleteDashboard({
				dashboardId: home.id,
				organizationId: organization.id,
				ownerId: owner.id,
			}),
		).toBe(false)
		expect(await getDashboardRow(home.id)).not.toBeNull()

		expect(
			await deleteDashboard({
				dashboardId: dashboard.id,
				organizationId: organization.id,
				ownerId: owner.id,
			}),
		).toBe(true)
		expect(await getDashboardRow(dashboard.id)).toBeNull()
		const shares = await db
			.select()
			.from(DashboardShare)
			.where(eq(DashboardShare.dashboardId, dashboard.id))
		expect(shares).toHaveLength(0)
	})

	it('saves the config of a custom dashboard in the organization', async () => {
		const { owner, organization } = await setupOrg()
		const dashboard = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.id,
		})
		const home = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.id,
			kind: 'home',
		})
		const otherOrganization = await createTestOrganization(owner.id, 'admin')
		const config = appendBlock(emptyDashboardConfig(), {
			id: 'stats',
			type: 'stats',
		})

		expect(
			await saveDashboardConfig({
				dashboardId: dashboard.id,
				organizationId: otherOrganization.id,
				config,
			}),
		).toBe(false)
		expect(
			await saveDashboardConfig({
				dashboardId: home.id,
				organizationId: organization.id,
				config,
			}),
		).toBe(false)
		expect(
			await saveDashboardConfig({
				dashboardId: dashboard.id,
				organizationId: organization.id,
				config,
			}),
		).toBe(true)
		expect(JSON.parse((await getDashboardRow(dashboard.id))!.config)).toEqual(
			config,
		)
		expect(JSON.parse((await getDashboardRow(home.id))!.config)).toEqual(
			defaultHomeConfig(),
		)
	})
})

describe('listDashboardsForSwitcher', () => {
	it('lists the user’s own and shared custom dashboards in this organization only', async () => {
		const { owner, organization } = await setupOrg()
		const colleague = await insertTestUser({ name: 'Cora Colleague' })
		await addOrganizationMember(colleague.id, organization.id)
		const otherOrganization = await createTestOrganization(owner.id, 'admin')
		await addOrganizationMember(colleague.id, otherOrganization.id)

		await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.id,
			kind: 'home',
		})
		const beta = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.id,
			name: 'beta board',
		})
		const alpha = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.id,
			name: 'Alpha board',
		})
		await insertTestDashboard({
			organizationId: otherOrganization.id,
			ownerId: owner.id,
			name: 'Other org board',
		})
		const sharedEdit = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: colleague.id,
			name: 'Shared to edit',
		})
		const sharedView = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: colleague.id,
			name: 'Shared to view',
		})
		await insertTestDashboard({
			organizationId: organization.id,
			ownerId: colleague.id,
			name: 'Private to colleague',
		})
		const sharedElsewhere = await insertTestDashboard({
			organizationId: otherOrganization.id,
			ownerId: colleague.id,
			name: 'Shared in other org',
		})
		await insertTestShare({
			dashboardId: sharedEdit.id,
			userId: owner.id,
			sharedById: colleague.id,
			access: 'edit',
		})
		await insertTestShare({
			dashboardId: sharedView.id,
			userId: owner.id,
			sharedById: colleague.id,
			access: 'view',
		})
		await insertTestShare({
			dashboardId: sharedElsewhere.id,
			userId: owner.id,
			sharedById: colleague.id,
			access: 'view',
		})

		expect(await listDashboardsForSwitcher(owner.id, organization.id)).toEqual({
			mine: [
				{ id: alpha.id, name: 'Alpha board' },
				{ id: beta.id, name: 'beta board' },
			],
			sharedWithMe: [
				{
					id: sharedEdit.id,
					name: 'Shared to edit',
					ownerName: 'Cora Colleague',
					access: 'edit',
				},
				{
					id: sharedView.id,
					name: 'Shared to view',
					ownerName: 'Cora Colleague',
					access: 'view',
				},
			],
		})

		const elsewhere = await listDashboardsForSwitcher(
			owner.id,
			otherOrganization.id,
		)
		expect(elsewhere.mine.map((item) => item.name)).toEqual(['Other org board'])
		expect(elsewhere.sharedWithMe.map((item) => item.name)).toEqual([
			'Shared in other org',
		])
	})

	it('is empty for a member with no dashboards', async () => {
		const { owner, organization } = await setupOrg()
		expect(await listDashboardsForSwitcher(owner.id, organization.id)).toEqual({
			mine: [],
			sharedWithMe: [],
		})
	})
})

describe('sharing', () => {
	async function setupSharing() {
		const { owner, organization } = await setupOrg()
		const bea = await insertTestUser({ name: 'Bea Viewer' })
		const cal = await insertTestUser({ name: 'Cal Editor' })
		const ina = await insertTestUser({ name: 'Ina Inactive' })
		const xan = await insertTestUser({ name: 'Xan Outsider' })
		await addOrganizationMember(bea.id, organization.id)
		await addOrganizationMember(cal.id, organization.id, 'org_role_viewer')
		await addOrganizationMember(ina.id, organization.id)
		await db
			.update(UserOrganization)
			.set({ active: false })
			.where(
				and(
					eq(UserOrganization.userId, ina.id),
					eq(UserOrganization.organizationId, organization.id),
				),
			)
		await createTestOrganization(xan.id, 'admin')
		const dashboard = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.id,
		})
		return { owner, organization, bea, cal, ina, xan, dashboard }
	}

	it('adds, updates and removes shares', async () => {
		const { owner, bea, cal, dashboard } = await setupSharing()
		await upsertShare({
			dashboardId: dashboard.id,
			userId: bea.id,
			access: 'view',
			sharedById: owner.id,
		})
		await upsertShare({
			dashboardId: dashboard.id,
			userId: cal.id,
			access: 'edit',
			sharedById: owner.id,
		})
		expect(await listShares(dashboard.id)).toEqual([
			{
				userId: bea.id,
				name: 'Bea Viewer',
				username: bea.username,
				imageObjectKey: null,
				access: 'view',
				isActiveMember: true,
			},
			{
				userId: cal.id,
				name: 'Cal Editor',
				username: cal.username,
				imageObjectKey: null,
				access: 'edit',
				isActiveMember: true,
			},
		])

		await upsertShare({
			dashboardId: dashboard.id,
			userId: bea.id,
			access: 'edit',
			sharedById: owner.id,
		})
		const updated = await listShares(dashboard.id)
		expect(updated).toHaveLength(2)
		expect(updated.find((share) => share.userId === bea.id)?.access).toBe(
			'edit',
		)

		expect(
			await removeShare({ dashboardId: dashboard.id, userId: bea.id }),
		).toBe(true)
		expect(
			await removeShare({ dashboardId: dashboard.id, userId: bea.id }),
		).toBe(false)
		expect(
			(await listShares(dashboard.id)).map((share) => share.userId),
		).toEqual([cal.id])
	})

	it('flags shares whose recipient is no longer an active member', async () => {
		const { owner, ina, dashboard } = await setupSharing()
		await insertTestShare({
			dashboardId: dashboard.id,
			userId: ina.id,
			sharedById: owner.id,
		})
		expect(await listShares(dashboard.id)).toEqual([
			expect.objectContaining({ userId: ina.id, isActiveMember: false }),
		])
	})

	it('offers only active members of the organization other than the owner', async () => {
		const { owner, organization, bea, cal, ina, xan } = await setupSharing()
		const members = await listShareableMembers(organization.id, owner.id)
		expect(members).toEqual([
			{
				id: bea.id,
				name: 'Bea Viewer',
				username: bea.username,
				imageObjectKey: null,
			},
			{
				id: cal.id,
				name: 'Cal Editor',
				username: cal.username,
				imageObjectKey: null,
			},
		])

		const check = (userId: string) =>
			isShareableMember({
				organizationId: organization.id,
				ownerId: owner.id,
				userId,
			})
		expect(await check(bea.id)).toBe(true)
		expect(await check(cal.id)).toBe(true)
		expect(await check(owner.id)).toBe(false)
		expect(await check(ina.id)).toBe(false)
		expect(await check(xan.id)).toBe(false)
		expect(await check('does-not-exist')).toBe(false)
	})
})
