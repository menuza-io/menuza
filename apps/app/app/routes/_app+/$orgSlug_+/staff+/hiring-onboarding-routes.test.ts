import {
	ConfigFlag,
	db,
	inArray,
	OrganizationRole,
	_OrganizationPermissionToRole,
} from '@repo/database'
import { STAFFING_FLAG_KEYS, type StaffingFeature } from '@repo/staffing'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader as onboardingLoader } from './hiring.onboarding.tsx'
import { loader as teamLoader } from './team.tsx'
import { loader as profileLoader } from './team_.$staffId.tsx'

const flagIds: string[] = []

async function enable(organizationId: string, features: StaffingFeature[]) {
	for (const feature of features) {
		const [row] = await db
			.insert(ConfigFlag)
			.values({
				key: STAFFING_FLAG_KEYS[feature],
				value: true,
				level: 'organization',
				organizationId,
			})
			.returning({ id: ConfigFlag.id })
		flagIds.push(row!.id)
	}
}

afterEach(async () => {
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
})

const url = (slug: string, path: string) =>
	`http://localhost:3000/${slug}/staff/${path}`

async function outcome(work: () => Promise<unknown>) {
	try {
		return { status: 200, data: (await work()) as any }
	} catch (error) {
		if (error instanceof Response) {
			return { status: error.status, data: null as any }
		}
		throw error
	}
}

async function memberWith(organizationId: string, permissionIds: string[]) {
	const [role] = await db
		.insert(OrganizationRole)
		.values({
			name: `Role ${crypto.randomUUID().slice(0, 8)}`,
			description: '',
			level: 0,
			organizationId,
		})
		.returning({ id: OrganizationRole.id })
	for (const id of permissionIds) {
		await db
			.insert(_OrganizationPermissionToRole)
			.values({ A: role!.id, B: id })
	}
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, role!.id)
	const { cookie } = await createTestSession(user.id)
	return { user, cookie }
}

describe('onboarding templates route', () => {
	it('answers 404 while staffing.hiring is off, even to an admin', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enable(organization.id, ['enabled'])
		const result = await outcome(() =>
			onboardingLoader({
				request: createAuthenticatedRequest(
					url(organization.slug, 'hiring/onboarding'),
					{},
					cookie,
				),
				params: { orgSlug: organization.slug },
			} as any),
		)
		expect(result.status).toBe(404)
	})

	it('lets an admin change templates, and a reader only look', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enable(organization.id, ['enabled', 'hiring'])
		const admin = await outcome(() =>
			onboardingLoader({
				request: createAuthenticatedRequest(
					url(organization.slug, 'hiring/onboarding'),
					{},
					cookie,
				),
				params: { orgSlug: organization.slug },
			} as any),
		)
		expect(admin.status).toBe(200)
		expect(admin.data).toEqual({ canWrite: true })

		const reader = await memberWith(organization.id, [
			'org_perm_read_hiring_any',
		])
		const read = await outcome(() =>
			onboardingLoader({
				request: createAuthenticatedRequest(
					url(organization.slug, 'hiring/onboarding'),
					{},
					reader.cookie,
				),
				params: { orgSlug: organization.slug },
			} as any),
		)
		expect(read.status).toBe(200)
		expect(read.data).toEqual({ canWrite: false })
	})

	it('refuses a member with no hiring permission and a stranger', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enable(organization.id, ['enabled', 'hiring'])
		const none = await memberWith(organization.id, [])
		const stranger = await createTestUser()
		const { cookie: strangerCookie } = await createTestSession(stranger.id)
		for (const cookie of [none.cookie, strangerCookie]) {
			const result = await outcome(() =>
				onboardingLoader({
					request: createAuthenticatedRequest(
						url(organization.slug, 'hiring/onboarding'),
						{},
						cookie,
					),
					params: { orgSlug: organization.slug },
				} as any),
			)
			expect([403, 404]).toContain(result.status)
		}
	})
})

describe('roster and profile gating', () => {
	const teamParams = (slug: string) => ({ orgSlug: slug })

	it('hides onboarding on the roster and the profile while hiring is off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enable(organization.id, ['enabled'])
		const team = await outcome(() =>
			teamLoader({
				request: createAuthenticatedRequest(
					url(organization.slug, 'team'),
					{},
					cookie,
				),
				params: teamParams(organization.slug),
			} as any),
		)
		expect(team.status).toBe(200)
		expect(team.data.onboarding).toBe(false)
		const profile = await outcome(() =>
			profileLoader({
				request: createAuthenticatedRequest(
					url(organization.slug, 'team/s1'),
					{},
					cookie,
				),
				params: { orgSlug: organization.slug, staffId: 's1' },
			} as any),
		)
		expect(profile.status).toBe(200)
		expect(profile.data.hiring).toBe(false)
	})

	it('shows it to someone who can read hiring once the flag is on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enable(organization.id, ['enabled', 'hiring'])
		const team = await outcome(() =>
			teamLoader({
				request: createAuthenticatedRequest(
					url(organization.slug, 'team'),
					{},
					cookie,
				),
				params: teamParams(organization.slug),
			} as any),
		)
		expect(team.data.onboarding).toBe(true)
		const profile = await outcome(() =>
			profileLoader({
				request: createAuthenticatedRequest(
					url(organization.slug, 'team/s1'),
					{},
					cookie,
				),
				params: { orgSlug: organization.slug, staffId: 's1' },
			} as any),
		)
		expect(profile.data.hiring).toBe(true)
	})

	it('keeps it from a team member who may read staff but not hiring', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enable(organization.id, ['enabled', 'hiring'])
		const manager = await memberWith(organization.id, [
			'org_perm_read_staff_any',
		])
		const team = await outcome(() =>
			teamLoader({
				request: createAuthenticatedRequest(
					url(organization.slug, 'team'),
					{},
					manager.cookie,
				),
				params: teamParams(organization.slug),
			} as any),
		)
		expect(team.status).toBe(200)
		expect(team.data.onboarding).toBe(false)
		const profile = await outcome(() =>
			profileLoader({
				request: createAuthenticatedRequest(
					url(organization.slug, 'team/s1'),
					{},
					manager.cookie,
				),
				params: { orgSlug: organization.slug, staffId: 's1' },
			} as any),
		)
		expect(profile.data.hiring).toBe(false)
	})
})
