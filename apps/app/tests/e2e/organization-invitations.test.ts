/**
 * Organization invitations & membership — critical path.
 *
 * These tests assume the same environment CI uses (see playwright.config.ts):
 *   LAUNCH_STATUS=LAUNCHED
 *   MOCKS=true
 *
 * Run like CI (recommended; starts `npm run start:mocks` on a free :3001):
 *   npm run test:e2e:run -- tests/e2e/organization-invitations.test.ts
 *
 * UI mode against `npm run dev`:
 *   npx playwright test tests/e2e/organization-invitations.test.ts --ui
 */
import { faker } from '@faker-js/faker'
import { type Page } from '@playwright/test'
import {
	and,
	db,
	eq,
	Organization,
	OrganizationInvitation,
	OrganizationInviteLink,
	Role,
	User,
	UserOrganization,
	WaitlistEntry,
	_RoleToUser,
} from '@repo/database'
import { readEmail } from '#tests/mocks/utils.ts'
import { expect, test, waitFor } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

const WEEK_MS = 1000 * 60 * 60 * 24 * 7

/**
 * Local `.env` is often `LAUNCH_STATUS=CLOSED_BETA`, which sends `/organizations`
 * to the waitlist. CI has no such file and runs `LAUNCHED`. Granting early
 * access makes these tests pass in both environments.
 */
async function openApp(
	login: () => Promise<{
		id: string
		email: string
		username: string
		name: string | null
	}>,
) {
	const user = await login()
	await db
		.insert(WaitlistEntry)
		.values({
			userId: user.id,
			referralCode: `e2e-${user.id}`,
			hasEarlyAccess: true,
			grantedAccessAt: new Date(),
			grantedAccessBy: user.id,
		})
		.onConflictDoUpdate({
			target: WaitlistEntry.userId,
			set: { hasEarlyAccess: true, grantedAccessAt: new Date() },
		})
	return user
}

async function createUserRecord() {
	const [user] = await db
		.insert(User)
		.values({
			email: faker.internet.email().toLowerCase(),
			username: faker.internet.username(),
			name: faker.person.fullName(),
		})
		.returning()
	if (!user) throw new Error('Failed to create user')
	const [role] = await db
		.select({ id: Role.id })
		.from(Role)
		.where(eq(Role.name, 'user'))
		.limit(1)
	if (role) await db.insert(_RoleToUser).values({ A: role.id, B: user.id })
	return user
}

async function createOrgWithAdmin(ownerId: string) {
	const [org] = await db
		.insert(Organization)
		.values({
			name: faker.company.name(),
			slug: `${faker.helpers.slugify(faker.company.name()).toLowerCase()}-${Date.now()}-${faker.string.alphanumeric(4)}`,
			description: faker.company.catchPhrase(),
		})
		.returning()
	if (!org) throw new Error('Failed to create organization')
	await db.insert(UserOrganization).values({
		userId: ownerId,
		organizationId: org.id,
		organizationRoleId: 'org_role_admin',
	})
	return org
}

async function addMember(
	orgId: string,
	userId: string,
	role: 'admin' | 'member' | 'viewer' | 'guest',
) {
	await db.insert(UserOrganization).values({
		userId,
		organizationId: orgId,
		organizationRoleId: `org_role_${role}`,
		active: true,
	})
}

async function insertEmailInvitation({
	organizationId,
	email,
	inviterId,
	role = 'member',
	expiresAt = new Date(Date.now() + WEEK_MS),
}: {
	organizationId: string
	email: string
	inviterId: string
	role?: 'admin' | 'member' | 'viewer' | 'guest'
	expiresAt?: Date
}) {
	const [invitation] = await db
		.insert(OrganizationInvitation)
		.values({
			organizationId,
			email: email.toLowerCase(),
			organizationRoleId: `org_role_${role}`,
			inviterId,
			token: `inv-${role}-${faker.string.uuid()}`,
			expiresAt,
		})
		.returning()
	if (!invitation) throw new Error('Failed to create invitation')
	return invitation
}

async function insertInviteLink({
	organizationId,
	createdById,
	role = 'member',
	isActive = true,
}: {
	organizationId: string
	createdById: string
	role?: 'admin' | 'member' | 'viewer' | 'guest'
	isActive?: boolean
}) {
	const [link] = await db
		.insert(OrganizationInviteLink)
		.values({
			organizationId,
			createdById,
			organizationRoleId: `org_role_${role}`,
			token: `link-${role}-${faker.string.uuid()}`,
			isActive,
		})
		.returning()
	if (!link) throw new Error('Failed to create invite link')
	return link
}

async function getMembership(organizationId: string, userId: string) {
	const [membership] = await db
		.select({
			userId: UserOrganization.userId,
			organizationRoleId: UserOrganization.organizationRoleId,
			active: UserOrganization.active,
		})
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.userId, userId),
			),
		)
		.limit(1)
	return membership ?? null
}

async function getInvitationById(id: string) {
	const [invitation] = await db
		.select()
		.from(OrganizationInvitation)
		.where(eq(OrganizationInvitation.id, id))
		.limit(1)
	return invitation ?? null
}

function membersAction(
	page: Page,
	orgSlug: string,
	fields: Record<string, string>,
) {
	return page.request.post(`/${orgSlug}/settings/members`, {
		form: fields,
		headers: { Accept: 'application/json' },
	})
}

async function expectMemberActionError(
	response: Awaited<ReturnType<typeof membersAction>>,
	pattern: RegExp,
) {
	expect(response.status()).toBeGreaterThanOrEqual(400)
	const contentType = response.headers()['content-type'] ?? ''
	const text = await response.text()
	if (contentType.includes('application/json')) {
		const body = JSON.parse(text) as { error?: string }
		expect(body.error).toMatch(pattern)
		return
	}
	const embeddedError = /"error","([^"]+)"/.exec(text)?.[1]
	if (embeddedError) {
		expect(embeddedError).toMatch(pattern)
		return
	}
	expect(text).toMatch(pattern)
}

test.describe('Email invitations', () => {
	test('Admin can invite someone by email', async ({
		page,
		login,
		navigate,
	}) => {
		const admin = await openApp(login)
		const org = await createTestOrganization(admin.id, 'admin')
		const inviteEmail = faker.internet.email().toLowerCase()

		await navigate('/:slug/settings/members', { slug: org.slug })
		await expect(
			page.getByRole('button', { name: /send invitations/i }),
		).toBeVisible()

		const send = await membersAction(page, org.slug, {
			intent: 'send-invitations',
			'invites[0].email': inviteEmail,
			'invites[0].roleId': 'org_role_member',
		})
		expect(send.ok()).toBe(true)

		await page.reload()
		await expect(
			page
				.getByRole('region', { name: /pending invitations/i })
				.getByText(inviteEmail),
		).toBeVisible()

		const [invitation] = await db
			.select()
			.from(OrganizationInvitation)
			.where(
				and(
					eq(OrganizationInvitation.organizationId, org.id),
					eq(OrganizationInvitation.email, inviteEmail),
				),
			)
			.limit(1)
		expect(invitation?.organizationRoleId).toBe('org_role_member')

		const email = await waitFor(
			async () => {
				const sent = await readEmail(inviteEmail)
				expect(sent).toBeTruthy()
				expect(sent?.subject).toContain('invited')
				return sent
			},
			{ timeout: 10_000 },
		)
		expect(email?.text).toContain(`/join/${invitation?.token}`)
	})

	test('Invitee can accept from the organizations dashboard', async ({
		page,
		login,
		navigate,
	}) => {
		const invitee = await openApp(login)
		const owner = await createUserRecord()
		const org = await createOrgWithAdmin(owner.id)
		const invitation = await insertEmailInvitation({
			organizationId: org.id,
			email: invitee.email,
			inviterId: owner.id,
		})

		await navigate('/organizations')
		await expect(
			page.getByRole('heading', { name: /pending invitations/i }),
		).toBeVisible()
		await expect(page.getByText(org.name)).toBeVisible()

		await page.getByRole('button', { name: /accept/i }).click()
		await expect(
			page.getByRole('link', { name: new RegExp(org.name) }),
		).toBeVisible()

		const membership = await getMembership(org.id, invitee.id)
		expect(membership?.organizationRoleId).toBe('org_role_member')
		expect(membership?.active).toBe(true)
		expect(await getInvitationById(invitation.id)).toBeNull()
	})

	test('Invitee can decline a pending invitation', async ({
		page,
		login,
		navigate,
	}) => {
		const invitee = await openApp(login)
		const owner = await createUserRecord()
		const org = await createOrgWithAdmin(owner.id)
		const invitation = await insertEmailInvitation({
			organizationId: org.id,
			email: invitee.email,
			inviterId: owner.id,
		})

		await navigate('/organizations')
		await expect(page.getByText(org.name)).toBeVisible()
		await page.getByRole('button', { name: /decline/i }).click()
		await expect(page.getByText(org.name)).not.toBeVisible()

		expect(await getMembership(org.id, invitee.id)).toBeNull()
		expect(await getInvitationById(invitation.id)).toBeNull()
	})

	test('Admin can revoke a pending invitation', async ({
		page,
		login,
		navigate,
	}) => {
		const admin = await openApp(login)
		const org = await createTestOrganization(admin.id, 'admin')
		const inviteEmail = faker.internet.email().toLowerCase()
		const invitation = await insertEmailInvitation({
			organizationId: org.id,
			email: inviteEmail,
			inviterId: admin.id,
		})

		await navigate('/:slug/settings/members', { slug: org.slug })
		const pendingSection = page.getByRole('region', {
			name: /pending invitations/i,
		})
		await expect(pendingSection.getByText(inviteEmail)).toBeVisible()
		await pendingSection
			.getByRole('button', { name: /delete invitation/i })
			.click()
		await expect(pendingSection.getByText(inviteEmail)).not.toBeVisible()
		expect(await getInvitationById(invitation.id)).toBeNull()
	})

	test('Invitee sees every pending invitation for their email', async ({
		page,
		login,
		navigate,
	}) => {
		const invitee = await openApp(login)
		const owner = await createUserRecord()
		const org1 = await createOrgWithAdmin(owner.id)
		const org2 = await createOrgWithAdmin(owner.id)
		await insertEmailInvitation({
			organizationId: org1.id,
			email: invitee.email,
			inviterId: owner.id,
			role: 'member',
		})
		await insertEmailInvitation({
			organizationId: org2.id,
			email: invitee.email,
			inviterId: owner.id,
			role: 'admin',
		})

		await navigate('/organizations')
		await expect(
			page.getByRole('heading', { name: /pending invitations/i }),
		).toBeVisible()
		await expect(page.getByText(org1.name)).toBeVisible()
		await expect(page.getByText(org2.name)).toBeVisible()
	})

	test('Expired invitations are not shown and cannot be accepted', async ({
		page,
		login,
		navigate,
	}) => {
		const invitee = await openApp(login)
		const owner = await createUserRecord()
		const org = await createOrgWithAdmin(owner.id)
		const expired = new Date(Date.now() - WEEK_MS)
		const invitation = await insertEmailInvitation({
			organizationId: org.id,
			email: invitee.email,
			inviterId: owner.id,
			expiresAt: expired,
		})

		await navigate('/organizations')
		const pendingHeading = page.getByRole('heading', {
			name: /pending invitations/i,
		})
		if (await pendingHeading.isVisible()) {
			await expect(page.getByText(org.name)).not.toBeVisible()
		} else {
			await expect(pendingHeading).not.toBeVisible()
		}

		const accept = await page.request.post('/organizations', {
			form: {
				intent: 'accept-invitation',
				invitationId: invitation.id,
			},
		})
		expect(accept.status()).toBe(500)
		expect(await getMembership(org.id, invitee.id)).toBeNull()
	})

	test('Authenticated invitee clicking the email join link lands on pending invitations', async ({
		page,
		login,
		navigate,
	}) => {
		const invitee = await openApp(login)
		const owner = await createUserRecord()
		const org = await createOrgWithAdmin(owner.id)
		const invitation = await insertEmailInvitation({
			organizationId: org.id,
			email: invitee.email,
			inviterId: owner.id,
		})

		await navigate('/join/:token', { token: invitation.token })
		await expect(page).toHaveURL(/\/organizations/)
		await expect(
			page.getByRole('heading', { name: /pending invitations/i }),
		).toBeVisible()
		await expect(page.getByText(org.name)).toBeVisible()
		expect(await getMembership(org.id, invitee.id)).toBeNull()
	})

	test('A user cannot accept an invitation sent to a different email', async ({
		page,
		login,
	}) => {
		const user = await openApp(login)
		const owner = await createUserRecord()
		const org = await createOrgWithAdmin(owner.id)
		const invitation = await insertEmailInvitation({
			organizationId: org.id,
			email: faker.internet.email().toLowerCase(),
			inviterId: owner.id,
		})

		const response = await page.request.post('/organizations', {
			form: {
				intent: 'accept-invitation',
				invitationId: invitation.id,
			},
		})
		expect(response.ok()).toBe(false)
		expect(await getMembership(org.id, user.id)).toBeNull()
		expect(await getInvitationById(invitation.id)).toBeTruthy()
	})

	test('Join link for someone else’s email is rejected', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await openApp(login)
		const owner = await createUserRecord()
		const org = await createOrgWithAdmin(owner.id)
		const invitation = await insertEmailInvitation({
			organizationId: org.id,
			email: faker.internet.email().toLowerCase(),
			inviterId: owner.id,
		})

		await navigate('/join/:token', { token: invitation.token })
		await expect(
			page.getByText(/this invitation was not sent to your email address/i),
		).toBeVisible()
		expect(await getMembership(org.id, user.id)).toBeNull()
	})
})

test.describe('Shareable invite links', () => {
	test('Unauthenticated users keep the invite link through signup', async ({
		page,
		navigate,
	}) => {
		const owner = await createUserRecord()
		const org = await createOrgWithAdmin(owner.id)
		const link = await insertInviteLink({
			organizationId: org.id,
			createdById: owner.id,
		})

		await navigate('/join/:token', { token: link.token })

		const redirectTo = `/join/${link.token}`
		await expect(page).toHaveURL(
			new RegExp(`/signup\\?redirectTo=${encodeURIComponent(redirectTo)}`),
		)
		await expect(
			page.getByText('Join organization', { exact: true }),
		).toBeVisible()
		await expect(page.getByRole('link', { name: /sign in/i })).toHaveAttribute(
			'href',
			`/login?redirectTo=${encodeURIComponent(redirectTo)}`,
		)
	})

	test('New social signups keep the invitation through onboarding', async ({
		page,
		navigate,
		prepareGitHubUser,
	}) => {
		const githubUser = await prepareGitHubUser()
		const owner = await createUserRecord()
		const org = await createOrgWithAdmin(owner.id)
		const link = await insertInviteLink({
			organizationId: org.id,
			createdById: owner.id,
		})

		await navigate('/join/:token', { token: link.token })
		await page.getByRole('button', { name: /signup with github/i }).click()
		await expect(page).toHaveURL(/\/onboarding\/github/)

		await page
			.getByRole('textbox', { name: /^username/i })
			.fill(faker.internet.username())
		await page.getByRole('textbox', { name: /full name/i }).fill('Invitee')
		await page
			.getByRole('checkbox', {
				name: /i agree to the terms of service and privacy policy/i,
			})
			.check()
		await page.getByRole('button', { name: /create account/i }).click()

		await expect(page).toHaveURL(/\/organizations/)
		await expect(page.getByText(org.name, { exact: true })).toBeVisible()

		const [pending] = await db
			.select()
			.from(OrganizationInvitation)
			.where(
				and(
					eq(OrganizationInvitation.organizationId, org.id),
					eq(
						OrganizationInvitation.email,
						githubUser.primaryEmail.toLowerCase(),
					),
				),
			)
			.limit(1)
		expect(pending?.organizationRoleId).toBe('org_role_member')
	})

	test('Admin can create a reusable invite link', async ({
		page,
		login,
		navigate,
	}) => {
		const admin = await openApp(login)
		const org = await createTestOrganization(admin.id, 'admin')

		await navigate('/:slug/settings/members', { slug: org.slug })
		await page.getByRole('button', { name: /create link/i }).click()
		await expect(page.getByRole('button', { name: /copy/i })).toBeVisible()

		const [link] = await db
			.select()
			.from(OrganizationInviteLink)
			.where(
				and(
					eq(OrganizationInviteLink.organizationId, org.id),
					eq(OrganizationInviteLink.createdById, admin.id),
					eq(OrganizationInviteLink.isActive, true),
				),
			)
			.limit(1)
		expect(link).toBeTruthy()
		expect(link?.organizationRoleId).toBe('org_role_member')
	})

	test('Authenticated user clicking a shareable link gets a pending invitation', async ({
		page,
		login,
		navigate,
	}) => {
		const joiner = await openApp(login)
		const owner = await createUserRecord()
		const org = await createOrgWithAdmin(owner.id)
		const link = await insertInviteLink({
			organizationId: org.id,
			createdById: owner.id,
			role: 'member',
		})

		await navigate('/join/:token', { token: link.token })
		await expect(page).toHaveURL(/\/organizations/)
		await expect(
			page.getByRole('heading', { name: /pending invitations/i }),
		).toBeVisible()
		await expect(page.getByText(org.name)).toBeVisible()

		const [pending] = await db
			.select()
			.from(OrganizationInvitation)
			.where(
				and(
					eq(OrganizationInvitation.organizationId, org.id),
					eq(OrganizationInvitation.email, joiner.email.toLowerCase()),
				),
			)
			.limit(1)
		expect(pending?.organizationRoleId).toBe('org_role_member')
		expect(await getMembership(org.id, joiner.id)).toBeNull()
	})

	test('Existing members are sent into the organization instead of being re-invited', async ({
		page,
		login,
		navigate,
	}) => {
		const member = await openApp(login)
		const owner = await createUserRecord()
		const org = await createOrgWithAdmin(owner.id)
		await addMember(org.id, member.id, 'member')
		const link = await insertInviteLink({
			organizationId: org.id,
			createdById: owner.id,
		})

		await navigate('/join/:token', { token: link.token })
		await expect(page).toHaveURL(new RegExp(`/${org.slug}`))
		expect((await getMembership(org.id, member.id))?.active).toBe(true)
	})

	test('Invalid invite tokens show an error', async ({
		page,
		login,
		navigate,
	}) => {
		await openApp(login)
		await navigate('/join/invalid-token-123')
		await expect(
			page.getByText(/invalid or expired invite link/i),
		).toBeVisible()
	})

	test('Deactivated invite links are rejected', async ({
		page,
		login,
		navigate,
	}) => {
		const joiner = await openApp(login)
		const owner = await createUserRecord()
		const org = await createOrgWithAdmin(owner.id)
		const link = await insertInviteLink({
			organizationId: org.id,
			createdById: owner.id,
			isActive: false,
		})

		await navigate('/join/:token', { token: link.token })
		await expect(
			page.getByText(/invalid or expired invite link/i),
		).toBeVisible()
		expect(await getMembership(org.id, joiner.id)).toBeNull()
	})

	test('Shareable member link does not upgrade a pending guest email invite', async ({
		page,
		login,
		navigate,
	}) => {
		const invitee = await openApp(login)
		const owner = await createUserRecord()
		const org = await createOrgWithAdmin(owner.id)
		const guestInvite = await insertEmailInvitation({
			organizationId: org.id,
			email: invitee.email,
			inviterId: owner.id,
			role: 'guest',
		})
		const memberLink = await insertInviteLink({
			organizationId: org.id,
			createdById: owner.id,
			role: 'member',
		})

		await navigate('/join/:token', { token: memberLink.token })
		await expect(page).toHaveURL(/\/organizations/)

		const pending = await getInvitationById(guestInvite.id)
		expect(pending).toBeTruthy()
		expect(pending?.organizationRoleId).toBe('org_role_guest')
		expect(pending?.token).toBe(guestInvite.token)
	})
})

test.describe('Roles and last-admin protection', () => {
	test('Member can view the member list but cannot invite', async ({
		page,
		login,
		navigate,
	}) => {
		const member = await openApp(login)
		const owner = await createUserRecord()
		const org = await createOrgWithAdmin(owner.id)
		await addMember(org.id, member.id, 'member')

		await navigate('/:slug/settings/members', { slug: org.slug })
		await expect(
			page.getByText(member.name || member.username).first(),
		).toBeVisible()

		const response = await membersAction(page, org.slug, {
			intent: 'send-invitations',
			'invites[0].email': faker.internet.email(),
			'invites[0].roleId': 'org_role_member',
		})
		expect(response.status()).toBe(403)
	})

	test('Viewer can open the members page', async ({
		page,
		login,
		navigate,
	}) => {
		const viewer = await openApp(login)
		const owner = await createUserRecord()
		const org = await createOrgWithAdmin(owner.id)
		await addMember(org.id, viewer.id, 'viewer')

		await navigate('/:slug/settings/members', { slug: org.slug })
		await expect(
			page.getByText(viewer.name || viewer.username).first(),
		).toBeVisible()
	})

	test('Guest cannot open the members page', async ({
		page,
		login,
		navigate,
	}) => {
		const guest = await openApp(login)
		const owner = await createUserRecord()
		const org = await createOrgWithAdmin(owner.id)
		await addMember(org.id, guest.id, 'guest')

		await navigate('/:slug/settings/members', { slug: org.slug })
		await expect(page.getByText(/403/)).toBeVisible()
		await expect(page.getByText(/read:member:any/i)).toBeVisible()
	})

	test('Admin can promote a member and demote another admin when one remains', async ({
		page,
		login,
	}) => {
		const admin = await openApp(login)
		const otherAdmin = await createUserRecord()
		const member = await createUserRecord()
		const org = await createOrgWithAdmin(admin.id)
		await addMember(org.id, otherAdmin.id, 'admin')
		await addMember(org.id, member.id, 'member')

		const promote = await membersAction(page, org.slug, {
			intent: 'update-member-role',
			userId: member.id,
			roleId: 'org_role_admin',
		})
		expect(promote.ok()).toBe(true)
		expect((await getMembership(org.id, member.id))?.organizationRoleId).toBe(
			'org_role_admin',
		)

		const demote = await membersAction(page, org.slug, {
			intent: 'update-member-role',
			userId: otherAdmin.id,
			roleId: 'org_role_member',
		})
		expect(demote.ok()).toBe(true)
		expect(
			(await getMembership(org.id, otherAdmin.id))?.organizationRoleId,
		).toBe('org_role_member')
	})

	test('The last remaining admin cannot be demoted', async ({
		page,
		login,
	}) => {
		const admin = await openApp(login)
		const org = await createTestOrganization(admin.id, 'admin')

		const response = await membersAction(page, org.slug, {
			intent: 'update-member-role',
			userId: admin.id,
			roleId: 'org_role_member',
		})
		await expectMemberActionError(response, /cannot change your own role/i)
		expect((await getMembership(org.id, admin.id))?.organizationRoleId).toBe(
			'org_role_admin',
		)
	})

	test('An admin cannot remove themselves', async ({ page, login }) => {
		const admin = await openApp(login)
		const otherAdmin = await createUserRecord()
		const org = await createOrgWithAdmin(admin.id)
		await addMember(org.id, otherAdmin.id, 'admin')

		const response = await membersAction(page, org.slug, {
			intent: 'remove-member',
			userId: admin.id,
		})
		await expectMemberActionError(response, /cannot remove yourself/i)
		expect((await getMembership(org.id, admin.id))?.active).toBe(true)
	})

	test('Member cannot change roles or remove users', async ({
		page,
		login,
	}) => {
		const member = await openApp(login)
		const owner = await createUserRecord()
		const target = await createUserRecord()
		const org = await createOrgWithAdmin(owner.id)
		await addMember(org.id, member.id, 'member')
		await addMember(org.id, target.id, 'member')

		const update = await membersAction(page, org.slug, {
			intent: 'update-member-role',
			userId: target.id,
			roleId: 'org_role_admin',
		})
		expect(update.status()).toBe(403)

		const remove = await membersAction(page, org.slug, {
			intent: 'remove-member',
			userId: target.id,
		})
		expect(remove.status()).toBe(403)
		expect((await getMembership(org.id, target.id))?.active).toBe(true)
	})
})
