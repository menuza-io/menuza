import {
	ConfigFlag,
	db,
	eq,
	inArray,
	OrganizationLocation,
	OrganizationInvitation,
	UserOrganization,
} from '@repo/database'
import { STAFFING_FLAG_KEYS } from '@repo/staffing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as invitation from '#app/utils/organization/invitation.server.ts'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
})

vi.mock('@repo/common/onboarding', () => ({
	markStepCompleted: vi.fn().mockResolvedValue(undefined),
}))

const sendEmail = vi.hoisted(() => vi.fn())
vi.mock(
	'#app/utils/organization/invitation.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof invitation>()
		return { ...actual, sendOrganizationInvitationEmail: sendEmail }
	},
)

import { setMemberLocationScope } from '#app/utils/staffing/restaurant/location-scope.server.ts'
import {
	createAuthenticatedRequest,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action as inviteAction } from './invite.ts'

const flagIds: string[] = []

afterEach(async () => {
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
	sendEmail.mockReset()
})

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

async function invite(
	slug: string,
	cookie: string,
	fields: Record<string, string>,
) {
	try {
		return getResponseStatus(
			await inviteAction({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${slug}/staff/invite`,
					{
						method: 'POST',
						body: new URLSearchParams(fields),
						headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					},
					cookie,
				),
				params: { orgSlug: slug },
				context: {},
			} as any),
		)
	} catch (error) {
		if (error instanceof Response) return error.status
		if ((error as any)?.init?.status) return (error as any).init.status
		throw error
	}
}

async function invitationFor(email: string) {
	const [row] = await db
		.select()
		.from(OrganizationInvitation)
		.where(eq(OrganizationInvitation.email, email))
	return row
}

describe('invite from a staff profile', () => {
	it('carries the staff id on the invitation and creates no member or seat', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		sendEmail.mockResolvedValue({ status: 'success' })
		const email = `staff-${crypto.randomUUID().slice(0, 8)}@example.com`
		const before = await db
			.select()
			.from(UserOrganization)
			.where(eq(UserOrganization.organizationId, organization.id))

		expect(
			await invite(organization.slug, cookie, { email, staffId: 'staff_abc' }),
		).toBe(200)

		expect((await invitationFor(email))?.staffMemberId).toBe('staff_abc')
		const after = await db
			.select()
			.from(UserOrganization)
			.where(eq(UserOrganization.organizationId, organization.id))
		expect(after).toHaveLength(before.length)
	})

	it('a plain invite (no staff id) links nothing', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		sendEmail.mockResolvedValue({ status: 'success' })
		const email = `staff-${crypto.randomUUID().slice(0, 8)}@example.com`
		expect(await invite(organization.slug, cookie, { email })).toBe(200)
		expect((await invitationFor(email))?.staffMemberId).toBeNull()
	})

	it('rejects a staff id that is not an opaque id, creating nothing', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const email = `staff-${crypto.randomUUID().slice(0, 8)}@example.com`
		for (const staffId of ['rana@example.com', '../x', 'a b', 'x'.repeat(65)]) {
			expect(await invite(organization.slug, cookie, { email, staffId })).toBe(
				400,
			)
		}
		expect(await invitationFor(email)).toBeUndefined()
		expect(sendEmail).not.toHaveBeenCalled()
	})

	it('a location-scoped manager can send a plain invite but cannot attach a staff id', async () => {
		const { organization, user, cookie } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		sendEmail.mockResolvedValue({ status: 'success' })
		const slug = `loc-${crypto.randomUUID().slice(0, 8)}`
		const [location] = await db
			.insert(OrganizationLocation)
			.values({ organizationId: organization.id, name: slug, slug })
			.returning({ id: OrganizationLocation.id })
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: user.id,
			value: { scope: 'selected', locationIds: [location!.id] },
		})

		const linked = `staff-${crypto.randomUUID().slice(0, 8)}@example.com`
		expect(
			await invite(organization.slug, cookie, {
				email: linked,
				staffId: 'staff_abc',
			}),
		).toBe(403)
		expect(await invitationFor(linked)).toBeUndefined()
		expect(sendEmail).not.toHaveBeenCalled()

		const plain = `staff-${crypto.randomUUID().slice(0, 8)}@example.com`
		expect(await invite(organization.slug, cookie, { email: plain })).toBe(200)
		expect((await invitationFor(plain))?.staffMemberId).toBeNull()
	})

	it('cannot attach a staff id while staffing is off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const email = `staff-${crypto.randomUUID().slice(0, 8)}@example.com`
		expect(
			await invite(organization.slug, cookie, { email, staffId: 'staff_abc' }),
		).toBe(404)
		expect(await invitationFor(email)).toBeUndefined()
	})
})
