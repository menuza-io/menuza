import {
	ConfigFlag,
	db,
	eq,
	inArray,
	Organization,
	OrganizationInvitation,
	OrganizationRole,
	UserOrganization,
	_OrganizationPermissionToRole,
} from '@repo/database'
import { DEFAULT_SCOPE_ID, STAFFING_FLAG_KEYS } from '@repo/staffing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as invitation from '#app/utils/organization/invitation.server.ts'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
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

import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action as inviteAction } from './invite.ts'
import { loader as positionsLoader } from './positions.tsx'
import { loader as bulkLoader } from './team.bulk.tsx'
import { loader as importLoader } from './team.import.tsx'
import { loader as newLoader } from './team.new.tsx'
import { loader as teamLoader } from './team.tsx'
import { loader as rehireLoader } from './team_.$staffId.rehire.tsx'
import { loader as terminateLoader } from './team_.$staffId.terminate.tsx'
import { loader as profileLoader } from './team_.$staffId.tsx'

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
	sendEmail.mockReset()
})

async function memberWithPermissions(
	organizationId: string,
	permissionIds: string[],
) {
	const [role] = await db
		.insert(OrganizationRole)
		.values({
			name: `Custom ${crypto.randomUUID().slice(0, 8)}`,
			description: '',
			level: 0,
			organizationId,
		})
		.returning({ id: OrganizationRole.id })
	await db
		.insert(_OrganizationPermissionToRole)
		.values(permissionIds.map((id) => ({ A: role!.id, B: id })))
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, role!.id)
	const { cookie } = await createTestSession(user.id)
	return { user, cookie }
}

const LOADERS = {
	team: teamLoader,
	positions: positionsLoader,
	profile: profileLoader,
	new: newLoader,
	bulk: bulkLoader,
	import: importLoader,
	terminate: terminateLoader,
	rehire: rehireLoader,
} as const
type LoaderName = keyof typeof LOADERS
const WRITE: LoaderName[] = ['new', 'bulk', 'import', 'terminate', 'rehire']
const READ: LoaderName[] = ['team', 'positions', 'profile']

async function run(name: LoaderName, slug: string, cookie: string) {
	try {
		const result = await LOADERS[name]({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${slug}/staff/team`,
				{},
				cookie,
			),
			params: { orgSlug: slug, staffId: 'staff_1' },
			context: {},
		} as any)
		return { status: 'ok' as const, result }
	} catch (error) {
		if (error instanceof Response) return { status: error.status }
		throw error
	}
}

async function statuses(names: LoaderName[], slug: string, cookie: string) {
	return Object.fromEntries(
		await Promise.all(
			names.map(async (name) => [name, (await run(name, slug, cookie)).status]),
		),
	)
}

describe('team child loaders', () => {
	it('all return 404 to an admin while staffing is off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const all = await statuses(
			Object.keys(LOADERS) as LoaderName[],
			organization.slug,
			cookie,
		)
		expect(Object.values(all).every((status) => status === 404)).toBe(true)
	})

	it('all open for an admin once the master flag is on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const all = await statuses(
			Object.keys(LOADERS) as LoaderName[],
			organization.slug,
			cookie,
		)
		expect(Object.values(all).every((status) => status === 'ok')).toBe(true)
	})

	it('all return 403 to a built-in member even with the flag on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('member')
		await enableStaffing(organization.id)
		const all = await statuses(
			Object.keys(LOADERS) as LoaderName[],
			organization.slug,
			cookie,
		)
		expect(Object.values(all).every((status) => status === 403)).toBe(true)
	})

	it('keeps write screens closed to a read-only manager but lets them read', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const { cookie } = await memberWithPermissions(organization.id, [
			'org_perm_read_staff_any',
		])
		expect(await statuses(READ, organization.slug, cookie)).toEqual({
			team: 'ok',
			positions: 'ok',
			profile: 'ok',
		})
		const write = await statuses(WRITE, organization.slug, cookie)
		expect(Object.values(write).every((status) => status === 403)).toBe(true)
	})

	it('keeps the member picker closed to a manager who cannot read members', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const staffOnly = await memberWithPermissions(organization.id, [
			'org_perm_read_staff_any',
			'org_perm_update_staff_any',
		])
		expect(
			(await run('import', organization.slug, staffOnly.cookie)).status,
		).toBe(403)
		// The same manager can still add people by hand.
		expect((await run('new', organization.slug, staffOnly.cookie)).status).toBe(
			'ok',
		)
		const withMembers = await memberWithPermissions(organization.id, [
			'org_perm_read_staff_any',
			'org_perm_update_staff_any',
			'org_perm_read_member_any',
		])
		expect(
			(await run('import', organization.slug, withMembers.cookie)).status,
		).toBe('ok')
	})

	it('does not open another organization to an admin of a different one', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		await enableStaffing(b.organization.id)
		const all = await statuses(
			Object.keys(LOADERS) as LoaderName[],
			b.organization.slug,
			a.cookie,
		)
		expect(Object.values(all).every((status) => status === 404)).toBe(true)
	})
})

describe('team loader data', () => {
	it('returns the one implicit workplace with a currency and nothing about people', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const { result } = await run('team', organization.slug, cookie)
		expect(result).toMatchObject({
			orgSlug: organization.slug,
			dataRegion: 'us',
			scopes: [
				{ id: DEFAULT_SCOPE_ID, name: organization.name, currency: 'USD' },
			],
		})
	})

	it('lists only active members for import, with a readable name', async () => {
		const { organization, cookie, user } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const gone = await createTestUser()
		await addOrganizationMember(gone.id, organization.id, 'org_role_member')
		await db
			.update(UserOrganization)
			.set({ active: false })
			.where(eq(UserOrganization.userId, gone.id))
		const { result } = await run('import', organization.slug, cookie)
		const members = (result as { members: Array<{ userId: string }> }).members
		expect(members.map((m) => m.userId)).toContain(user.id)
		expect(members.map((m) => m.userId)).not.toContain(gone.id)
	})
})

describe('invite action', () => {
	function post(slug: string, cookie: string, email: string) {
		const body = new URLSearchParams({ email })
		return inviteAction({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${slug}/staff/invite`,
				{
					method: 'POST',
					body,
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				},
				cookie,
			),
			params: { orgSlug: slug },
			context: {},
		} as any)
	}

	async function statusOf(promise: Promise<unknown>) {
		try {
			return getResponseStatus(await promise)
		} catch (error) {
			if (error instanceof Response) return error.status
			if ((error as any)?.init?.status) return (error as any).init.status
			throw error
		}
	}

	it('is 404 while staffing is off, so it cannot be used to invite around the flag', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		expect(
			await statusOf(post(organization.slug, cookie, 'a@example.com')),
		).toBe(404)
		expect(sendEmail).not.toHaveBeenCalled()
	})

	it('invites a plain member and sends the email after the flag is on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		sendEmail.mockResolvedValue({ status: 'success' })
		const email = `staff-${crypto.randomUUID().slice(0, 8)}@example.com`
		expect(
			await statusOf(post(organization.slug, cookie, email.toUpperCase())),
		).toBe(200)
		const [row] = await db
			.select()
			.from(OrganizationInvitation)
			.where(eq(OrganizationInvitation.email, email))
		expect(row?.organizationRoleId).toBe('org_role_member')
		expect(sendEmail).toHaveBeenCalledTimes(1)
	})

	it('rejects a bad email without creating anything', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		expect(
			await statusOf(post(organization.slug, cookie, 'not-an-email')),
		).toBe(400)
		expect(sendEmail).not.toHaveBeenCalled()
	})

	it('needs the member-invite permission as well as staff update', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const { cookie } = await memberWithPermissions(organization.id, [
			'org_perm_update_staff_any',
		])
		expect(
			await statusOf(post(organization.slug, cookie, 'a@example.com')),
		).toBe(403)
		expect(sendEmail).not.toHaveBeenCalled()
	})

	it('refuses a Saudi-region organization', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		await db
			.update(Organization)
			.set({ dataRegion: 'ksa' })
			.where(eq(Organization.id, organization.id))
		expect(
			await statusOf(post(organization.slug, cookie, 'a@example.com')),
		).toBe(409)
		expect(sendEmail).not.toHaveBeenCalled()
	})
})
