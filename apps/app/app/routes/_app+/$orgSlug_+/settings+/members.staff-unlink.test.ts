import {
	db,
	eq,
	Organization,
	StaffingOutbox,
	UserOrganization,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestUser,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action } from './members.tsx'

vi.mock('@repo/common/onboarding', () => ({
	markStepCompleted: vi.fn().mockResolvedValue(undefined),
}))

const regional = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('#app/utils/staffing/regional-internal.server.ts', () => ({
	postRegionalStaffInternal: regional.post,
}))

type Sent = { dataRegion: string; path: string; body: Record<string, unknown> }
let sent: Sent[]

beforeEach(() => {
	sent = []
	regional.post.mockReset().mockImplementation(async (args: Sent) => {
		sent.push(args)
		return new Response('{}', { status: 200 })
	})
})

async function setup(provisioned = true) {
	const {
		user: admin,
		organization,
		cookie,
	} = await setupTestOrgWithUser('admin')
	await db
		.update(Organization)
		.set({ hasProvisionedDb: provisioned })
		.where(eq(Organization.id, organization.id))
	const member = await createTestUser()
	await db.insert(UserOrganization).values({
		userId: member.id,
		organizationId: organization.id,
		organizationRoleId: 'org_role_member',
		active: true,
	})
	const remove = async (userId: string) => {
		const formData = new FormData()
		formData.append('intent', 'remove-member')
		formData.append('userId', userId)
		return (await action({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/members`,
				{ method: 'POST', body: formData },
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as any)) as Response
	}
	return { admin, organization, member, remove }
}

const outbox = (organizationId: string) =>
	db
		.select()
		.from(StaffingOutbox)
		.where(eq(StaffingOutbox.organizationId, organizationId))

describe('removing a member and the staff record', () => {
	it('detaches the login from its staff record, and only that', async () => {
		const { organization, member, remove } = await setup()
		const response = await remove(member.id)
		expect(getResponseStatus(response)).toBe(200)

		const rows = await outbox(organization.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			kind: 'unlink_user',
			status: 'done',
			payload: { userId: member.id },
		})
		// One call, to unlink. Removing app access is not termination: nothing is
		// sent that could end employment, clear a PIN or touch pay.
		expect(sent).toHaveLength(1)
		expect(sent[0]).toMatchObject({
			dataRegion: 'us',
			path: 'unlink-user',
			body: { orgId: organization.id, userId: member.id },
		})
		expect(Object.keys(sent[0]!.body).sort()).toEqual(['orgId', 'userId'])
		const [membership] = await db
			.select()
			.from(UserOrganization)
			.where(eq(UserOrganization.userId, member.id))
		expect(membership?.active).toBe(false)
	})

	it('removal succeeds and the event stays queued while the region is down', async () => {
		const { organization, member, remove } = await setup()
		regional.post.mockRejectedValue(new Error('ECONNREFUSED'))
		const response = await remove(member.id)
		expect(getResponseStatus(response)).toBe(200)
		const [row] = await outbox(organization.id)
		expect(row).toMatchObject({ kind: 'unlink_user', status: 'pending' })
	})

	it('removing an already inactive member queues nothing new', async () => {
		const { organization, member, remove } = await setup()
		await remove(member.id)
		await remove(member.id)
		expect(await outbox(organization.id)).toHaveLength(1)
		expect(sent).toHaveLength(1)
	})

	it('does nothing regional for an organization without a regional database', async () => {
		const { organization, member, remove } = await setup(false)
		const response = await remove(member.id)
		expect(getResponseStatus(response)).toBe(200)
		expect(await outbox(organization.id)).toHaveLength(0)
		expect(regional.post).not.toHaveBeenCalled()
	})

	it('a refused removal (last admin, self) queues nothing', async () => {
		const { organization, admin, remove } = await setup()
		expect(getResponseStatus(await remove(admin.id))).toBe(400)
		expect(await outbox(organization.id)).toHaveLength(0)
	})
})
