import { AuditAction, auditService } from '@repo/audit'
import {
	ConfigFlag,
	db,
	eq,
	inArray,
	OrganizationLocation,
	UserOrganization,
} from '@repo/database'
import { STAFFING_FLAG_KEYS } from '@repo/staffing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveStaffingScopeIds } from '#app/utils/staffing/scope-claim.server.ts'
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

const flagIds: string[] = []

async function enableStaffing(organizationId: string) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: STAFFING_FLAG_KEYS.enabled,
			value: true,
			level: 'organization',
			organizationId,
		})
		.returning({ id: ConfigFlag.id })
	flagIds.push(row!.id)
}

afterEach(async () => {
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
})

async function createLocation(organizationId: string) {
	const slug = `loc-${crypto.randomUUID().slice(0, 8)}`
	const [row] = await db
		.insert(OrganizationLocation)
		.values({ organizationId, name: `Location ${slug}`, slug })
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

function post(slug: string, cookie: string, values: Record<string, string[]>) {
	const formData = new FormData()
	for (const [key, list] of Object.entries(values)) {
		for (const value of list) formData.append(key, value)
	}
	return action({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${slug}/settings/members`,
			{ method: 'POST', body: formData },
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never) as Promise<Response>
}

function locationsForm(
	userId: string,
	scope: string,
	locationIds: string[] = [],
) {
	return {
		intent: ['update-member-locations'],
		userId: [userId],
		scope: [scope],
		locationIds,
	}
}

async function bodyOf(response: Response) {
	return (await response.json()) as { success?: boolean; error?: string }
}

describe('members: staff location access', () => {
	it('lets an admin limit a member to chosen locations, and the member’s token claim follows', async () => {
		const {
			organization,
			cookie,
			user: admin,
		} = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const [a, b] = [
			await createLocation(organization.id),
			await createLocation(organization.id),
		]
		const target = await createTestUser()
		await addOrganizationMember(target.id, organization.id)

		const response = await post(
			organization.slug,
			cookie,
			locationsForm(target.id, 'selected', [a]),
		)
		expect(getResponseStatus(response)).toBe(200)
		expect(await bodyOf(response)).toEqual({ success: true })
		expect(await resolveStaffingScopeIds(target.id, organization.id)).toEqual([
			a,
		])

		// An admin is not limited by limiting someone else.
		expect(await resolveStaffingScopeIds(admin.id, organization.id)).toBeNull()

		const widened = await post(
			organization.slug,
			cookie,
			locationsForm(target.id, 'selected', [a, b]),
		)
		expect(getResponseStatus(widened)).toBe(200)
		expect(
			(await resolveStaffingScopeIds(target.id, organization.id))?.sort(),
		).toEqual([a, b].sort())

		const reset = await post(
			organization.slug,
			cookie,
			locationsForm(target.id, 'all', [a]),
		)
		expect(getResponseStatus(reset)).toBe(200)
		expect(await resolveStaffingScopeIds(target.id, organization.id)).toBeNull()
	})

	it('writes an audit entry with ids only', async () => {
		const spy = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		const {
			organization,
			cookie,
			user: admin,
		} = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const a = await createLocation(organization.id)
		const target = await createTestUser()
		await addOrganizationMember(target.id, organization.id)
		await post(
			organization.slug,
			cookie,
			locationsForm(target.id, 'selected', [a]),
		)
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.ORG_MEMBER_LOCATIONS_CHANGED,
				userId: admin.id,
				targetUserId: target.id,
				organizationId: organization.id,
				metadata: expect.objectContaining({
					oldScope: 'all',
					newScope: 'selected',
					newLocationIds: a,
				}),
			}),
		)
		spy.mockRestore()
	})

	it('is a 404 while the Staff module is off (the default)', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id)
		const target = await createTestUser()
		await addOrganizationMember(target.id, organization.id)
		const response = await post(
			organization.slug,
			cookie,
			locationsForm(target.id, 'selected', [a]),
		)
		expect(getResponseStatus(response)).toBe(404)
		expect(await resolveStaffingScopeIds(target.id, organization.id)).toBeNull()
	})

	it('refuses anyone who is not a built-in admin', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const a = await createLocation(organization.id)
		const manager = await createTestUser()
		await addOrganizationMember(manager.id, organization.id, 'org_role_member')
		const { cookie } = await createTestSession(manager.id)
		const target = await createTestUser()
		await addOrganizationMember(target.id, organization.id)
		const response = await post(
			organization.slug,
			cookie,
			locationsForm(target.id, 'selected', [a]),
		)
		expect(getResponseStatus(response)).toBe(403)
		expect(await resolveStaffingScopeIds(target.id, organization.id)).toBeNull()
	})

	it('cannot change your own staff locations', async () => {
		const { organization, cookie, user } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const response = await post(
			organization.slug,
			cookie,
			locationsForm(user.id, 'selected', []),
		)
		expect(getResponseStatus(response)).toBe(400)
		expect(await resolveStaffingScopeIds(user.id, organization.id)).toBeNull()
	})

	it('cannot reach into another organization, nor store another organization’s location', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		await enableStaffing(a.organization.id)
		await enableStaffing(b.organization.id)
		const foreignLocation = await createLocation(b.organization.id)
		const ownTarget = await createTestUser()
		await addOrganizationMember(ownTarget.id, a.organization.id)

		// An admin of org A naming org B's member: not a member of A.
		const outsider = await post(
			a.organization.slug,
			a.cookie,
			locationsForm(b.user.id, 'selected', []),
		)
		expect(getResponseStatus(outsider)).toBe(404)
		expect(
			await resolveStaffingScopeIds(b.user.id, b.organization.id),
		).toBeNull()

		const foreign = await post(
			a.organization.slug,
			a.cookie,
			locationsForm(ownTarget.id, 'selected', [foreignLocation]),
		)
		expect(getResponseStatus(foreign)).toBe(400)
		expect(
			await resolveStaffingScopeIds(ownTarget.id, a.organization.id),
		).toBeNull()
	})

	it('rejects a bad scope and mass-assignment style extras safely', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const target = await createTestUser()
		await addOrganizationMember(target.id, organization.id)
		const bad = await post(
			organization.slug,
			cookie,
			locationsForm(target.id, 'everyone'),
		)
		expect(getResponseStatus(bad)).toBe(400)
		const missing = await post(organization.slug, cookie, {
			intent: ['update-member-locations'],
			scope: ['selected'],
		})
		expect(getResponseStatus(missing)).toBe(400)
		// The role is untouched by a locations change.
		await post(
			organization.slug,
			cookie,
			locationsForm(target.id, 'selected', []),
		)
		const [membership] = await db
			.select({ roleId: UserOrganization.organizationRoleId })
			.from(UserOrganization)
			.where(eq(UserOrganization.userId, target.id))
		expect(membership?.roleId).toBe('org_role_member')
	})
})

describe('members loader: staff location control', () => {
	async function load(slug: string, cookie: string) {
		return (await loader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${slug}/settings/members`,
				{},
				cookie,
			),
			params: { orgSlug: slug },
			context: {},
		} as never)) as unknown as {
			staffingLocations: null | {
				locations: Array<{ id: string }>
				access: Record<string, { scope: string; locationIds: string[] }>
			}
		}
	}

	it('exposes nothing while the Staff module is off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await createLocation(organization.id)
		expect((await load(organization.slug, cookie)).staffingLocations).toBeNull()
	})

	it('gives an admin the locations and each member’s current access once it is on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const a = await createLocation(organization.id)
		const target = await createTestUser()
		await addOrganizationMember(target.id, organization.id)
		await post(
			organization.slug,
			cookie,
			locationsForm(target.id, 'selected', [a]),
		)
		const result = await load(organization.slug, cookie)
		expect(result.staffingLocations?.locations.map((l) => l.id)).toEqual([a])
		expect(result.staffingLocations?.access[target.id]).toEqual({
			scope: 'selected',
			locationIds: [a],
		})
	})

	it('never exposes it to a member who is not an admin', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const viewer = await createTestUser()
		// Members need read:member:any to see the page at all.
		await addOrganizationMember(viewer.id, organization.id, 'org_role_member')
		const { cookie } = await createTestSession(viewer.id)
		try {
			const result = await load(organization.slug, cookie)
			expect(result.staffingLocations).toBeNull()
		} catch (error) {
			expect(error).toBeInstanceOf(Response)
		}
	})
})
