import { and, db, eq, UserOrganization } from '@repo/database'
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
import { canEdit, isOwner, requireDashboardAccess } from './access.server.ts'
import { defaultHomeConfig, emptyDashboardConfig } from './config.ts'

async function expectNotFound(promise: Promise<unknown>, secret?: string) {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(error).toBeInstanceOf(Response)
	const response = error as Response
	expect(response.status).toBe(404)
	if (secret) expect(await response.text()).not.toContain(secret)
}

async function setMembershipActive(
	userId: string,
	organizationId: string,
	active: boolean,
) {
	await db
		.update(UserOrganization)
		.set({ active })
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organizationId),
			),
		)
}

async function setup() {
	const owner = await insertTestUser({ name: 'Olive Owner' })
	const viewer = await insertTestUser()
	const editor = await insertTestUser()
	const member = await insertTestUser()
	const organization = await createTestOrganization(owner.id, 'admin')
	await addOrganizationMember(viewer.id, organization.id)
	await addOrganizationMember(editor.id, organization.id)
	await addOrganizationMember(member.id, organization.id)
	const dashboard = await insertTestDashboard({
		organizationId: organization.id,
		ownerId: owner.id,
		name: 'Secret sales board',
	})
	await insertTestShare({
		dashboardId: dashboard.id,
		userId: viewer.id,
		sharedById: owner.id,
		access: 'view',
	})
	await insertTestShare({
		dashboardId: dashboard.id,
		userId: editor.id,
		sharedById: owner.id,
		access: 'edit',
	})
	return { owner, viewer, editor, member, organization, dashboard }
}

describe('requireDashboardAccess', () => {
	it('gives the owner owner access with the parsed config and owner name', async () => {
		const { owner, organization, dashboard } = await setup()
		const result = await requireDashboardAccess({
			userId: owner.id,
			organizationId: organization.id,
			dashboardId: dashboard.id,
		})
		expect(result.access).toBe('owner')
		expect(result.dashboard).toMatchObject({
			id: dashboard.id,
			organizationId: organization.id,
			ownerId: owner.id,
			ownerName: 'Olive Owner',
			kind: 'custom',
			name: 'Secret sales board',
			config: emptyDashboardConfig(),
		})
	})

	it('gives share recipients their edit or view access', async () => {
		const { viewer, editor, organization, dashboard } = await setup()
		const asEditor = await requireDashboardAccess({
			userId: editor.id,
			organizationId: organization.id,
			dashboardId: dashboard.id,
		})
		expect(asEditor.access).toBe('edit')
		const asViewer = await requireDashboardAccess({
			userId: viewer.id,
			organizationId: organization.id,
			dashboardId: dashboard.id,
		})
		expect(asViewer.access).toBe('view')
		expect(asViewer.dashboard.ownerName).toBe('Olive Owner')
	})

	it('falls back to the username when the owner has no name', async () => {
		const owner = await insertTestUser({ name: null })
		const organization = await createTestOrganization(owner.id, 'admin')
		const dashboard = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.id,
		})
		const result = await requireDashboardAccess({
			userId: owner.id,
			organizationId: organization.id,
			dashboardId: dashboard.id,
		})
		expect(result.dashboard.ownerName).toBe(owner.username)
	})

	it('returns 404 for a member the dashboard is not shared with', async () => {
		const { member, organization, dashboard } = await setup()
		await expectNotFound(
			requireDashboardAccess({
				userId: member.id,
				organizationId: organization.id,
				dashboardId: dashboard.id,
			}),
			'Secret sales board',
		)
	})

	it('returns 404 for a dashboard id that does not exist', async () => {
		const { owner, organization } = await setup()
		await expectNotFound(
			requireDashboardAccess({
				userId: owner.id,
				organizationId: organization.id,
				dashboardId: 'does-not-exist',
			}),
		)
	})

	it('returns 404 when the dashboard belongs to another organization', async () => {
		const { owner, organization, dashboard } = await setup()
		const otherOrganization = await createTestOrganization(owner.id, 'admin')
		const otherDashboard = await insertTestDashboard({
			organizationId: otherOrganization.id,
			ownerId: owner.id,
			name: 'Other org board',
		})
		await expectNotFound(
			requireDashboardAccess({
				userId: owner.id,
				organizationId: organization.id,
				dashboardId: otherDashboard.id,
			}),
			'Other org board',
		)
		await expectNotFound(
			requireDashboardAccess({
				userId: owner.id,
				organizationId: otherOrganization.id,
				dashboardId: dashboard.id,
			}),
			'Secret sales board',
		)
	})

	it('returns 404 for a recipient who is not a member of the organization', async () => {
		const { owner, organization, dashboard } = await setup()
		const outsider = await insertTestUser()
		await createTestOrganization(outsider.id, 'admin')
		await insertTestShare({
			dashboardId: dashboard.id,
			userId: outsider.id,
			sharedById: owner.id,
			access: 'edit',
		})
		await expectNotFound(
			requireDashboardAccess({
				userId: outsider.id,
				organizationId: organization.id,
				dashboardId: dashboard.id,
			}),
			'Secret sales board',
		)
	})

	it('returns 404 when the viewer membership is inactive', async () => {
		const { owner, editor, organization, dashboard } = await setup()
		await setMembershipActive(editor.id, organization.id, false)
		await expectNotFound(
			requireDashboardAccess({
				userId: editor.id,
				organizationId: organization.id,
				dashboardId: dashboard.id,
			}),
		)
		await setMembershipActive(owner.id, organization.id, false)
		await expectNotFound(
			requireDashboardAccess({
				userId: owner.id,
				organizationId: organization.id,
				dashboardId: dashboard.id,
			}),
		)
		await setMembershipActive(editor.id, organization.id, true)
		const restored = await requireDashboardAccess({
			userId: editor.id,
			organizationId: organization.id,
			dashboardId: dashboard.id,
		})
		expect(restored.access).toBe('edit')
	})

	it('only lets the owner reach a Home dashboard, even with a share row', async () => {
		const { owner, viewer, organization } = await setup()
		const home = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: owner.id,
			kind: 'home',
			config: '{not json',
		})
		await insertTestShare({
			dashboardId: home.id,
			userId: viewer.id,
			sharedById: owner.id,
			access: 'edit',
		})
		await expectNotFound(
			requireDashboardAccess({
				userId: viewer.id,
				organizationId: organization.id,
				dashboardId: home.id,
			}),
		)
		const asOwner = await requireDashboardAccess({
			userId: owner.id,
			organizationId: organization.id,
			dashboardId: home.id,
		})
		expect(asOwner.access).toBe('owner')
		expect(asOwner.dashboard.kind).toBe('home')
		expect(asOwner.dashboard.config).toEqual(defaultHomeConfig())
	})
})

describe('access helpers', () => {
	it('lets owners and editors edit', () => {
		expect(canEdit('owner')).toBe(true)
		expect(canEdit('edit')).toBe(true)
		expect(canEdit('view')).toBe(false)
	})

	it('identifies the owner', () => {
		expect(isOwner('owner')).toBe(true)
		expect(isOwner('edit')).toBe(false)
		expect(isOwner('view')).toBe(false)
	})
})
