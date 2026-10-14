import { faker } from '@faker-js/faker'
import {
	and,
	count,
	db,
	eq,
	Organization,
	OrganizationInvitation,
	OrganizationInviteLink,
	StaffingOutbox,
	UserOrganization,
} from '@repo/database'
import type * as payments from '@repo/payments'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import {
	acceptInvitationByEmail,
	acceptInvitationById,
	createInvitationFromLink,
	createOrganizationInvitation,
	validateAndAcceptInvitation,
} from './invitation.server.ts'

vi.hoisted(() => {
	process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_x'
})

vi.mock('@repo/common/onboarding', () => ({
	markStepCompleted: vi.fn().mockResolvedValue(undefined),
}))

// The real seat counter runs against the real database; only Stripe is fake.
const stripe = vi.hoisted(() => ({
	quantities: [] as number[],
}))
vi.mock('@repo/payments', async (importOriginal) => {
	const actual = await importOriginal<typeof payments>()
	return {
		...actual,
		createStripeProvider: () => ({
			getClient: () => ({}),
			retrieveSubscription: async () => ({
				items: [{ priceId: 'price_1' }],
			}),
			updateSubscription: async ({ quantity }: { quantity: number }) => {
				stripe.quantities.push(quantity)
				return { id: 'sub_1' }
			},
		}),
	}
})

const regional = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('#app/utils/staffing/regional-internal.server.ts', () => ({
	postRegionalStaffInternal: regional.post,
}))

type Sent = { dataRegion: string; path: string; body: Record<string, unknown> }
let sent: Sent[]

beforeEach(() => {
	sent = []
	stripe.quantities.length = 0
	regional.post.mockReset().mockImplementation(async (args: Sent) => {
		sent.push(args)
		return new Response('{}', { status: 200 })
	})
})

afterEach(() => {
	vi.restoreAllMocks()
})

async function setup(
	options: { provisioned?: boolean; subscription?: boolean } = {},
) {
	const owner = await createTestUser()
	const organization = await createTestOrganization(owner.id, 'admin')
	await db
		.update(Organization)
		.set({
			hasProvisionedDb: options.provisioned ?? true,
			stripeSubscriptionId: options.subscription ? 'sub_1' : null,
		})
		.where(eq(Organization.id, organization.id))
	return { owner, organization }
}

async function outboxRows(organizationId: string) {
	return db
		.select()
		.from(StaffingOutbox)
		.where(eq(StaffingOutbox.organizationId, organizationId))
}

async function seats(organizationId: string) {
	const [row] = await db
		.select({ value: count() })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
			),
		)
	return row?.value ?? 0
}

describe('staff-linked invitations', () => {
	it('carries the staff id and, on accept, queues a link with ids only and delivers it', async () => {
		const { owner, organization } = await setup()
		const invitee = await createTestUser()
		const { invitation } = await createOrganizationInvitation({
			organizationId: organization.id,
			email: invitee.email,
			inviterId: owner.id,
			staffMemberId: 'staff_abc',
		})
		expect(invitation.staffMemberId).toBe('staff_abc')

		await acceptInvitationById(invitation.id, invitee.id)

		const rows = await outboxRows(organization.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			kind: 'link_user',
			status: 'done',
			payload: { staffMemberId: 'staff_abc', userId: invitee.id },
		})
		// Nothing about the person crosses: ids and the organization only.
		expect(sent).toEqual([
			expect.objectContaining({
				dataRegion: 'us',
				path: 'link-user',
				body: {
					orgId: organization.id,
					staffMemberId: 'staff_abc',
					userId: invitee.id,
				},
			}),
		])
		expect(JSON.stringify(sent)).not.toContain(invitee.email)
		// The invitation is consumed.
		expect(
			await db
				.select()
				.from(OrganizationInvitation)
				.where(eq(OrganizationInvitation.id, invitation.id)),
		).toHaveLength(0)
	})

	it('also links when the invitation is accepted by token or at sign-up', async () => {
		const { owner, organization } = await setup()
		const byToken = await createTestUser()
		const { invitation } = await createOrganizationInvitation({
			organizationId: organization.id,
			email: byToken.email,
			inviterId: owner.id,
			staffMemberId: 'staff_token',
		})
		await validateAndAcceptInvitation(invitation.token, byToken.id)

		const atSignup = await createTestUser()
		await createOrganizationInvitation({
			organizationId: organization.id,
			email: atSignup.email,
			inviterId: owner.id,
			staffMemberId: 'staff_signup',
		})
		await acceptInvitationByEmail(atSignup.email, atSignup.id)

		expect(sent.map((call) => call.body.staffMemberId).sort()).toEqual([
			'staff_signup',
			'staff_token',
		])
	})

	it('queues nothing for an ordinary invitation', async () => {
		const { owner, organization } = await setup()
		const invitee = await createTestUser()
		const { invitation } = await createOrganizationInvitation({
			organizationId: organization.id,
			email: invitee.email,
			inviterId: owner.id,
		})
		expect(invitation.staffMemberId).toBeNull()
		await acceptInvitationById(invitation.id, invitee.id)
		expect(await outboxRows(organization.id)).toHaveLength(0)
		expect(regional.post).not.toHaveBeenCalled()
	})

	it('keeps the accept successful when the regional node is down, and the row stays queued', async () => {
		const { owner, organization } = await setup()
		const invitee = await createTestUser()
		const { invitation } = await createOrganizationInvitation({
			organizationId: organization.id,
			email: invitee.email,
			inviterId: owner.id,
			staffMemberId: 'staff_abc',
		})
		regional.post.mockRejectedValue(new Error('ECONNREFUSED'))
		const result = await acceptInvitationById(invitation.id, invitee.id)
		expect(result.alreadyMember).toBe(false)
		const [row] = await outboxRows(organization.id)
		expect(row).toMatchObject({ status: 'pending', attempts: 1 })
		expect(await seats(organization.id)).toBe(2)
	})

	it('does not queue for an organization without a regional database', async () => {
		const { owner, organization } = await setup({ provisioned: false })
		const invitee = await createTestUser()
		const { invitation } = await createOrganizationInvitation({
			organizationId: organization.id,
			email: invitee.email,
			inviterId: owner.id,
			staffMemberId: 'staff_abc',
		})
		await acceptInvitationById(invitation.id, invitee.id)
		expect(await outboxRows(organization.id)).toHaveLength(0)
	})

	it('does not link a member who was removed and is still inactive', async () => {
		const { owner, organization } = await setup()
		const invitee = await createTestUser()
		await db.insert(UserOrganization).values({
			userId: invitee.id,
			organizationId: organization.id,
			organizationRoleId: 'org_role_member',
			active: false,
		})
		const { invitation } = await createOrganizationInvitation({
			organizationId: organization.id,
			email: invitee.email,
			inviterId: owner.id,
			staffMemberId: 'staff_abc',
		})
		await acceptInvitationById(invitation.id, invitee.id)
		expect(await outboxRows(organization.id)).toHaveLength(0)
	})

	it('links an existing active member who accepts a staff invitation', async () => {
		const { owner, organization } = await setup()
		const member = await createTestUser()
		await db.insert(UserOrganization).values({
			userId: member.id,
			organizationId: organization.id,
			organizationRoleId: 'org_role_member',
			active: true,
		})
		const { invitation } = await createOrganizationInvitation({
			organizationId: organization.id,
			email: member.email,
			inviterId: owner.id,
			staffMemberId: 'staff_abc',
		})
		const result = await acceptInvitationById(invitation.id, member.id)
		expect(result.alreadyMember).toBe(true)
		expect(sent).toHaveLength(1)
	})

	it('rejects a staff id that is not an opaque id', async () => {
		const { owner, organization } = await setup()
		for (const staffMemberId of [
			'',
			'rana@example.com',
			'a b',
			'../x',
			'x'.repeat(65),
		]) {
			await expect(
				createOrganizationInvitation({
					organizationId: organization.id,
					email: faker.internet.email(),
					inviterId: owner.id,
					staffMemberId,
				}),
			).rejects.toMatchObject({ status: 400 })
		}
	})

	it('keeps the link on a plain re-invite and replaces it on a staff re-invite', async () => {
		const { owner, organization } = await setup()
		const email = faker.internet.email().toLowerCase()
		await createOrganizationInvitation({
			organizationId: organization.id,
			email,
			inviterId: owner.id,
			staffMemberId: 'staff_one',
		})
		const plain = await createOrganizationInvitation({
			organizationId: organization.id,
			email,
			inviterId: owner.id,
		})
		expect(plain.invitation.staffMemberId).toBe('staff_one')
		const replaced = await createOrganizationInvitation({
			organizationId: organization.id,
			email,
			inviterId: owner.id,
			staffMemberId: 'staff_two',
		})
		expect(replaced.invitation.staffMemberId).toBe('staff_two')
	})

	it('a shareable link never inherits a staff link from the expired invitation it replaces', async () => {
		const { owner, organization } = await setup()
		const stranger = await createTestUser()
		await db.insert(OrganizationInvitation).values({
			organizationId: organization.id,
			email: stranger.email,
			organizationRoleId: 'org_role_member',
			token: `token-${faker.string.uuid()}`,
			inviterId: owner.id,
			staffMemberId: 'staff_victim',
			expiresAt: new Date(Date.now() - 60_000),
		})
		const [link] = await db
			.insert(OrganizationInviteLink)
			.values({
				organizationId: organization.id,
				token: `link-${faker.string.uuid()}`,
				organizationRoleId: 'org_role_member',
				createdById: owner.id,
			})
			.returning()

		const created = await createInvitationFromLink(link!.token, stranger.email)
		expect(created?.staffMemberId).toBeNull()
		await acceptInvitationByEmail(stranger.email, stranger.id)
		expect(await outboxRows(organization.id)).toHaveLength(0)
		expect(regional.post).not.toHaveBeenCalled()
	})

	it('a still-valid staff invitation is not overwritten by a shareable link', async () => {
		const { owner, organization } = await setup()
		const invitee = await createTestUser()
		await createOrganizationInvitation({
			organizationId: organization.id,
			email: invitee.email,
			inviterId: owner.id,
			staffMemberId: 'staff_abc',
		})
		const [link] = await db
			.insert(OrganizationInviteLink)
			.values({
				organizationId: organization.id,
				token: `link-${faker.string.uuid()}`,
				organizationRoleId: 'org_role_member',
				createdById: owner.id,
			})
			.returning()
		const result = await createInvitationFromLink(link!.token, invitee.email)
		expect(result?.staffMemberId).toBe('staff_abc')
	})
})

describe('seat count regression: staff rows never touch members or seats', () => {
	it('inviting from a staff profile adds no member and no seat until the invitee accepts', async () => {
		const { owner, organization } = await setup({ subscription: true })
		const invitee = await createTestUser()
		await createOrganizationInvitation({
			organizationId: organization.id,
			email: invitee.email,
			inviterId: owner.id,
			staffMemberId: 'staff_abc',
		})
		expect(await seats(organization.id)).toBe(1)
		expect(stripe.quantities).toEqual([])
	})

	it('accepting a staff-linked invitation costs exactly one seat, and linking costs none', async () => {
		const { owner, organization } = await setup({ subscription: true })
		const invitee = await createTestUser()
		const { invitation } = await createOrganizationInvitation({
			organizationId: organization.id,
			email: invitee.email,
			inviterId: owner.id,
			staffMemberId: 'staff_abc',
		})
		await acceptInvitationById(invitation.id, invitee.id)
		expect(await seats(organization.id)).toBe(2)
		// One seat sync from the accept itself; the outbox link added no sync.
		expect(stripe.quantities).toEqual([2])
		expect(sent).toHaveLength(1)
	})

	it('a failed or repeated link delivery never changes membership or the seat quantity', async () => {
		const { owner, organization } = await setup({ subscription: true })
		const invitee = await createTestUser()
		const { invitation } = await createOrganizationInvitation({
			organizationId: organization.id,
			email: invitee.email,
			inviterId: owner.id,
			staffMemberId: 'staff_abc',
		})
		regional.post.mockRejectedValue(new Error('down'))
		await acceptInvitationById(invitation.id, invitee.id)
		const { drainStaffingOutbox } =
			await import('#app/utils/staffing/outbox.server.ts')
		for (let i = 0; i < 3; i++) {
			await drainStaffingOutbox({
				organizationId: organization.id,
				now: new Date(Date.now() + (i + 1) * 3 * 24 * 60 * 60 * 1000),
			})
		}
		expect(await seats(organization.id)).toBe(2)
		expect(stripe.quantities).toEqual([2])
	})

	it('staff-only workers are not members: an erase event leaves membership alone', async () => {
		const { owner, organization } = await setup({ subscription: true })
		const { enqueueStaffingOutbox, drainStaffingOutbox } =
			await import('#app/utils/staffing/outbox.server.ts')
		await enqueueStaffingOutbox({
			organizationId: organization.id,
			kind: 'erase_user',
			payload: { userId: owner.id },
		})
		await drainStaffingOutbox({
			organizationId: organization.id,
			now: new Date(Date.now() + 1000),
		})
		expect(await seats(organization.id)).toBe(1)
		expect(stripe.quantities).toEqual([])
		const memberships = await db
			.select()
			.from(UserOrganization)
			.where(eq(UserOrganization.organizationId, organization.id))
		expect(memberships).toHaveLength(1)
		expect(memberships[0]).toMatchObject({ userId: owner.id, active: true })
	})
})
