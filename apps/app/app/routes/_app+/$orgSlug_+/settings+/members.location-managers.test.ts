import { AuditAction, auditService } from '@repo/audit'
import {
	_OrganizationPermissionToRole,
	ConfigFlag,
	db,
	eq,
	inArray,
	OrganizationInvitation,
	OrganizationInvitationLocation,
	OrganizationLocation,
	OrganizationRole,
	UserOrganization,
} from '@repo/database'
import { RESERVATIONS_FLAG_KEYS } from '@repo/reservations'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loader as reservationsTokenLoader } from '#app/routes/_app+/$orgSlug_+/reservations+/token.ts'
import { resolveLoyaltyLocationIds } from '#app/utils/loyalty/access.server.ts'
import {
	createOrganizationInvitation,
	validateAndAcceptInvitation,
} from '#app/utils/organization/invitation.server.ts'
import { createStaffingRolePreset } from '#app/utils/staffing/role-presets.server.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './members.tsx'

vi.mock('@repo/common/onboarding', () => ({
	markStepCompleted: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('#app/utils/payments.server.ts', async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	updateSeatQuantity: vi.fn().mockResolvedValue(undefined),
}))
vi.mock(
	'#app/utils/organization/invitation.server.ts',
	async (importOriginal) => {
		const actual = (await importOriginal()) as Record<string, unknown>
		return {
			...actual,
			sendOrganizationInvitationEmail: vi.fn().mockResolvedValue(undefined),
		}
	},
)

const flagIds: string[] = []

beforeEach(() => {
	process.env.BASE_URL ??= 'http://localhost:3000'
})

afterEach(async () => {
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
	vi.restoreAllMocks()
})

async function createLocation(organizationId: string) {
	const slug = `loc-${crypto.randomUUID().slice(0, 8)}`
	const [row] = await db
		.insert(OrganizationLocation)
		.values({ organizationId, name: `Location ${slug}`, slug })
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

async function post(
	slug: string,
	cookie: string,
	values: Record<string, string[]>,
) {
	const formData = new FormData()
	for (const [key, list] of Object.entries(values)) {
		for (const value of list) formData.append(key, value)
	}
	return (await action({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${slug}/settings/members`,
			{ method: 'POST', body: formData },
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never)) as Response
}

async function bodyOf(response: Response) {
	return (await response.json()) as {
		success?: boolean
		error?: string
		code?: string
	}
}

/** A "General manager" made from the preset, limited to the given locations. */
async function locationManager(organizationId: string, locationIds: string[]) {
	const preset = await createStaffingRolePreset(
		organizationId,
		'general_manager',
	)
	if (!preset.ok) throw new Error('preset exists')
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, preset.roleId)
	await db
		.update(UserOrganization)
		.set({ locationScope: 'selected' })
		.where(eq(UserOrganization.userId, user.id))
	const { setMemberLocationScope } =
		await import('#app/utils/staffing/restaurant/location-scope.server.ts')
	await setMemberLocationScope({
		organizationId,
		userId: user.id,
		value: { scope: 'selected', locationIds },
	})
	const { cookie } = await createTestSession(user.id)
	return { user, cookie, roleId: preset.roleId }
}

async function scopedMember(
	organizationId: string,
	locationIds: string[],
	roleId = 'org_role_member',
) {
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, roleId)
	const { setMemberLocationScope } =
		await import('#app/utils/staffing/restaurant/location-scope.server.ts')
	await setMemberLocationScope({
		organizationId,
		userId: user.id,
		value: { scope: 'selected', locationIds },
	})
	return user
}

describe('#126 invitations carry locations', () => {
	it('an invitation for one location gives the new member only that location', async () => {
		const { organization, user: admin } = await setupTestOrgWithUser('admin')
		const [a, b] = [
			await createLocation(organization.id),
			await createLocation(organization.id),
		]
		const invitee = await createTestUser()
		const { invitation } = await createOrganizationInvitation({
			organizationId: organization.id,
			email: invitee.email,
			roleId: 'org_role_member',
			inviterId: admin.id,
			locationScope: 'selected',
			locationIds: [a],
		})
		expect(invitation.locationScope).toBe('selected')

		await validateAndAcceptInvitation(invitation.token, invitee.id)

		expect(
			await resolveLoyaltyLocationIds(invitee.id, organization.id),
		).toEqual([a])
		expect(
			await resolveLoyaltyLocationIds(invitee.id, organization.id),
		).not.toContain(b)
	})

	it('an invitation without locations keeps every location, as before', async () => {
		const { organization, user: admin } = await setupTestOrgWithUser('admin')
		await createLocation(organization.id)
		const invitee = await createTestUser()
		const { invitation } = await createOrganizationInvitation({
			organizationId: organization.id,
			email: invitee.email,
			roleId: 'org_role_member',
			inviterId: admin.id,
		})
		await validateAndAcceptInvitation(invitation.token, invitee.id)
		expect(
			await resolveLoyaltyLocationIds(invitee.id, organization.id),
		).toBeNull()
	})

	it('the orders and reservations tokens of that member carry only their location', async () => {
		const { organization, user: admin } = await setupTestOrgWithUser('admin')
		const [a] = [
			await createLocation(organization.id),
			await createLocation(organization.id),
		]
		const [flag] = await db
			.insert(ConfigFlag)
			.values({
				key: RESERVATIONS_FLAG_KEYS.enabled,
				value: true,
				level: 'organization',
				organizationId: organization.id,
			})
			.returning({ id: ConfigFlag.id })
		flagIds.push(flag!.id)
		const [role] = await db
			.insert(OrganizationRole)
			.values({
				name: `Host ${crypto.randomUUID().slice(0, 6)}`,
				description: '',
				level: 0,
				organizationId: organization.id,
			})
			.returning({ id: OrganizationRole.id })
		await db
			.insert(_OrganizationPermissionToRole)
			.values({ A: role!.id, B: 'org_perm_read_reservation_any' })
		const invitee = await createTestUser()
		const { invitation } = await createOrganizationInvitation({
			organizationId: organization.id,
			email: invitee.email,
			roleId: role!.id,
			inviterId: admin.id,
			locationScope: 'selected',
			locationIds: [a],
		})
		await validateAndAcceptInvitation(invitation.token, invitee.id)

		// The orders token claim is this resolver's answer.
		expect(
			await resolveLoyaltyLocationIds(invitee.id, organization.id),
		).toEqual([a])
		const { cookie } = await createTestSession(invitee.id)
		const minted = (await reservationsTokenLoader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/reservations/token?scope=book`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)) as { data: { locationIds: string[] | null } }
		expect(minted.data.locationIds).toEqual([a])
	})

	it('deleting a location removes it from pending invitations, and one left with none is void', async () => {
		const { organization, user: admin } = await setupTestOrgWithUser('admin')
		const [a, b] = [
			await createLocation(organization.id),
			await createLocation(organization.id),
		]
		const invitee = await createTestUser()
		const { invitation } = await createOrganizationInvitation({
			organizationId: organization.id,
			email: invitee.email,
			roleId: 'org_role_member',
			inviterId: admin.id,
			locationScope: 'selected',
			locationIds: [a, b],
		})
		await db.delete(OrganizationLocation).where(eq(OrganizationLocation.id, a))
		expect(
			await db
				.select()
				.from(OrganizationInvitationLocation)
				.where(eq(OrganizationInvitationLocation.invitationId, invitation.id)),
		).toEqual([expect.objectContaining({ locationId: b })])

		await db.delete(OrganizationLocation).where(eq(OrganizationLocation.id, b))
		await expect(
			validateAndAcceptInvitation(invitation.token, invitee.id),
		).rejects.toMatchObject({
			status: 409,
			statusText: 'invitation_has_no_locations',
		})
		// The invitation stays, void, and no membership was created.
		expect(
			await db
				.select()
				.from(OrganizationInvitation)
				.where(eq(OrganizationInvitation.id, invitation.id)),
		).toHaveLength(1)
		expect(
			await db
				.select()
				.from(UserOrganization)
				.where(eq(UserOrganization.userId, invitee.id)),
		).toHaveLength(0)
	})

	it('audits the locations of an invitation with ids only', async () => {
		const spy = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		const { organization, user: admin } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id)
		await createOrganizationInvitation({
			organizationId: organization.id,
			email: `${crypto.randomUUID().slice(0, 8)}@example.com`,
			roleId: 'org_role_member',
			inviterId: admin.id,
			locationScope: 'selected',
			locationIds: [a],
		})
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.ORG_INVITATION_SENT,
				metadata: expect.objectContaining({
					locationScope: 'selected',
					locationIds: a,
				}),
			}),
		)
	})
})

describe('#126 location managers', () => {
	it('can invite for their own location, and the member gets only it', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const [a] = [
			await createLocation(organization.id),
			await createLocation(organization.id),
		]
		const manager = await locationManager(organization.id, [a])
		const response = await post(organization.slug, manager.cookie, {
			intent: ['send-invitations'],
			'invites[0].email': [
				`new-${crypto.randomUUID().slice(0, 6)}@example.com`,
			],
			'invites[0].roleId': ['org_role_member'],
			locationScope: ['selected'],
			locationIds: [a],
		})
		expect(getResponseStatus(response)).toBe(200)
	})

	it('cannot grant a location outside their scope, nor all locations (server refuses)', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const [a, b] = [
			await createLocation(organization.id),
			await createLocation(organization.id),
		]
		const manager = await locationManager(organization.id, [a])
		const email = `new-${crypto.randomUUID().slice(0, 6)}@example.com`
		const outside = await post(organization.slug, manager.cookie, {
			intent: ['send-invitations'],
			'invites[0].email': [email],
			'invites[0].roleId': ['org_role_member'],
			locationScope: ['selected'],
			locationIds: [a, b],
		})
		expect(getResponseStatus(outside)).toBe(403)
		expect((await bodyOf(outside)).code).toBe('location_not_in_your_scope')

		const everywhere = await post(organization.slug, manager.cookie, {
			intent: ['send-invitations'],
			'invites[0].email': [email],
			'invites[0].roleId': ['org_role_member'],
			locationScope: ['all'],
		})
		expect(getResponseStatus(everywhere)).toBe(403)
		expect((await bodyOf(everywhere)).code).toBe('location_not_in_your_scope')
		expect(
			await db
				.select()
				.from(OrganizationInvitation)
				.where(eq(OrganizationInvitation.email, email)),
		).toHaveLength(0)
	})

	it('cannot grant a role above theirs, including Admin', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id)
		const manager = await locationManager(organization.id, [a])
		const response = await post(organization.slug, manager.cookie, {
			intent: ['send-invitations'],
			'invites[0].email': [`x-${crypto.randomUUID().slice(0, 6)}@example.com`],
			'invites[0].roleId': ['org_role_admin'],
			locationScope: ['selected'],
			locationIds: [a],
		})
		expect(getResponseStatus(response)).toBe(403)
		expect((await bodyOf(response)).code).toBe('role_above_yours')
	})

	it('can change the locations and role of a member inside their scope, but not outside it', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const [a, b, c] = [
			await createLocation(organization.id),
			await createLocation(organization.id),
			await createLocation(organization.id),
		]
		const manager = await locationManager(organization.id, [a, b])
		const inside = await scopedMember(organization.id, [a])
		const straddling = await scopedMember(organization.id, [a, c])

		const narrowed = await post(organization.slug, manager.cookie, {
			intent: ['update-member-locations'],
			userId: [inside.id],
			scope: ['selected'],
			locationIds: [b],
		})
		expect(getResponseStatus(narrowed)).toBe(200)
		expect(await resolveLoyaltyLocationIds(inside.id, organization.id)).toEqual(
			[b],
		)

		const grantOutside = await post(organization.slug, manager.cookie, {
			intent: ['update-member-locations'],
			userId: [inside.id],
			scope: ['selected'],
			locationIds: [c],
		})
		expect(getResponseStatus(grantOutside)).toBe(403)
		expect((await bodyOf(grantOutside)).code).toBe('location_not_in_your_scope')

		const reach = await post(organization.slug, manager.cookie, {
			intent: ['update-member-locations'],
			userId: [straddling.id],
			scope: ['selected'],
			locationIds: [a],
		})
		expect(getResponseStatus(reach)).toBe(403)
		expect((await bodyOf(reach)).code).toBe('member_outside_your_scope')
		expect(
			(await resolveLoyaltyLocationIds(straddling.id, organization.id))?.sort(),
		).toEqual([a, c].sort())

		const removed = await post(organization.slug, manager.cookie, {
			intent: ['remove-member'],
			userId: [straddling.id],
		})
		expect(getResponseStatus(removed)).toBe(403)
		expect((await bodyOf(removed)).code).toBe('member_outside_your_scope')
	})

	it('cannot change an admin, themselves, or hand out tags', async () => {
		const { organization, user: admin } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id)
		const manager = await locationManager(organization.id, [a])

		const onAdmin = await post(organization.slug, manager.cookie, {
			intent: ['update-member-locations'],
			userId: [admin.id],
			scope: ['selected'],
			locationIds: [a],
		})
		expect(getResponseStatus(onAdmin)).toBe(403)
		expect((await bodyOf(onAdmin)).code).toBe('cannot_manage_admin')

		const roleOnAdmin = await post(organization.slug, manager.cookie, {
			intent: ['update-member-role'],
			userId: [admin.id],
			roleId: ['org_role_member'],
		})
		expect(getResponseStatus(roleOnAdmin)).toBe(403)
		expect((await bodyOf(roleOnAdmin)).code).toBe('cannot_manage_admin')

		// With another admin around, removing this one is a plain refusal.
		const second = await createTestUser()
		await addOrganizationMember(second.id, organization.id, 'org_role_admin')
		const removeAdmin = await post(organization.slug, manager.cookie, {
			intent: ['remove-member'],
			userId: [admin.id],
		})
		expect(getResponseStatus(removeAdmin)).toBe(403)
		expect(
			await db
				.select({ active: UserOrganization.active })
				.from(UserOrganization)
				.where(eq(UserOrganization.userId, admin.id)),
		).toEqual([{ active: true }])

		const onSelf = await post(organization.slug, manager.cookie, {
			intent: ['update-member-locations'],
			userId: [manager.user.id],
			scope: ['selected'],
			locationIds: [a],
		})
		expect(getResponseStatus(onSelf)).toBe(400)
		const roleSelf = await post(organization.slug, manager.cookie, {
			intent: ['update-member-role'],
			userId: [manager.user.id],
			roleId: ['org_role_member'],
		})
		expect(getResponseStatus(roleSelf)).toBe(400)
	})

	it('a role change records before and after, and a manager cannot give a higher role', async () => {
		const spy = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		const { organization } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id)
		const manager = await locationManager(organization.id, [a])
		const member = await scopedMember(organization.id, [a], 'org_role_viewer')

		const up = await post(organization.slug, manager.cookie, {
			intent: ['update-member-role'],
			userId: [member.id],
			roleId: ['org_role_admin'],
		})
		expect(getResponseStatus(up)).toBe(403)
		expect((await bodyOf(up)).code).toBe('role_above_yours')

		const ok = await post(organization.slug, manager.cookie, {
			intent: ['update-member-role'],
			userId: [member.id],
			roleId: ['org_role_guest'],
		})
		expect(getResponseStatus(ok)).toBe(200)
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.ORG_MEMBER_ROLE_CHANGED,
				userId: manager.user.id,
				targetUserId: member.id,
				metadata: {
					oldRoleId: 'org_role_viewer',
					newRoleId: 'org_role_guest',
				},
			}),
		)
	})

	it('sees only the members who share one of their locations, with their locations listed', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const [a, b] = [
			await createLocation(organization.id),
			await createLocation(organization.id),
		]
		const manager = await locationManager(organization.id, [a])
		const shared = await scopedMember(organization.id, [a, b])
		const other = await scopedMember(organization.id, [b])

		const data = (await loader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/members`,
				{},
				manager.cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)) as unknown as {
			members: Array<{ userId: string }>
			memberScopes: Record<string, string[] | null>
			manageableUserIds: string[]
			canManageTeam: boolean
		}
		const ids = data.members.map((member) => member.userId)
		expect(ids).toContain(shared.id)
		expect(ids).not.toContain(other.id)
		expect(data.canManageTeam).toBe(true)
		expect(data.memberScopes[shared.id]).toEqual([a, b].sort())
		// Seen, but not changeable: their scope reaches outside the manager's.
		expect(data.manageableUserIds).not.toContain(shared.id)
	})

	it('without the permission, an ordinary member can neither invite nor change locations', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id)
		const member = await createTestUser()
		await addOrganizationMember(member.id, organization.id, 'org_role_member')
		const { cookie } = await createTestSession(member.id)
		const target = await createTestUser()
		await addOrganizationMember(target.id, organization.id)
		const response = await post(organization.slug, cookie, {
			intent: ['update-member-locations'],
			userId: [target.id],
			scope: ['selected'],
			locationIds: [a],
		})
		expect(getResponseStatus(response)).toBe(403)
	})
})
