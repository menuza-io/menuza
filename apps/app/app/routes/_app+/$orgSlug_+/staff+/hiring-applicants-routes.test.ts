import {
	ConfigFlag,
	db,
	inArray,
	Organization,
	OrganizationLocation,
	eq,
	OrganizationRole,
	_OrganizationPermissionToRole,
} from '@repo/database'
import {
	DEFAULT_SCOPE_ID,
	STAFFING_FLAG_KEYS,
	type StaffingFeature,
} from '@repo/staffing'
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
import { loader as applicantLoader } from './hiring.applicants.$applicationId.tsx'
import { loader as pageLoader } from './hiring.applicants.tsx'
import { loader as layoutLoader } from './hiring.tsx'

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

const url = (slug: string, path = '') =>
	`http://localhost:3000/${slug}/staff/hiring/applicants${path}`

async function outcome(work: () => Promise<unknown>) {
	try {
		const data = (await work()) as any
		return { status: 200, data }
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

describe('applicant routes while staffing.hiring is off', () => {
	it('answer 404 to an admin on every loader', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const slug = organization.slug
		const params = { orgSlug: slug, applicationId: 'a1' }
		const get = (path = '') =>
			createAuthenticatedRequest(url(slug, path), {}, cookie)
		for (const work of [
			() => layoutLoader({ request: get(), params } as any),
			() => pageLoader({ request: get(), params } as any),
			() => applicantLoader({ request: get('/a1'), params } as any),
		]) {
			expect((await outcome(work)).status).toBe(404)
		}
	})

	it('answer 404 when only the master flag is on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enable(organization.id, ['enabled'])
		const result = await outcome(() =>
			pageLoader({
				request: createAuthenticatedRequest(url(organization.slug), {}, cookie),
				params: { orgSlug: organization.slug },
			} as any),
		)
		expect(result.status).toBe(404)
	})
})

describe('applicants page loader', () => {
	it('names the one workplace, with time zone and currency, and nothing about people', async () => {
		const { organization, cookie, user } = await setupTestOrgWithUser('admin')
		await enable(organization.id, ['enabled', 'hiring'])
		await db
			.update(Organization)
			.set({ staffingTimeZone: 'America/Chicago' })
			.where(eq(Organization.id, organization.id))
		const result = await outcome(() =>
			pageLoader({
				request: createAuthenticatedRequest(url(organization.slug), {}, cookie),
				params: { orgSlug: organization.slug },
			} as any),
		)
		expect(result.status).toBe(200)
		expect(result.data.orgSlug).toBe(organization.slug)
		expect(result.data.userId).toBe(user.id)
		expect(result.data.canWrite).toBe(true)
		expect(result.data.scopes).toEqual([
			expect.objectContaining({
				id: DEFAULT_SCOPE_ID,
				name: organization.name,
				timeZone: 'America/Chicago',
				currency: expect.any(String),
			}),
		])
		expect(JSON.stringify(result.data)).not.toMatch(/email|phone|applicant/i)
	})

	it('names the active locations when the organization has them, with time zone and currency', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enable(organization.id, ['enabled', 'hiring'])
		const [downtown] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: organization.id,
				name: 'Downtown',
				slug: `downtown-${crypto.randomUUID().slice(0, 6)}`,
				timezone: 'America/Chicago',
				address: '1 Main Street, Chicago, IL 60601, United States',
				isActive: true,
			})
			.returning({ id: OrganizationLocation.id })
		await db.insert(OrganizationLocation).values({
			organizationId: organization.id,
			name: 'Closed',
			slug: `closed-${crypto.randomUUID().slice(0, 6)}`,
			isActive: false,
		})
		const result = await outcome(() =>
			pageLoader({
				request: createAuthenticatedRequest(url(organization.slug), {}, cookie),
				params: { orgSlug: organization.slug },
			} as any),
		)
		expect(result.data.scopes).toEqual([
			{
				id: downtown!.id,
				name: 'Downtown',
				timeZone: 'America/Chicago',
				currency: 'USD',
			},
		])
	})

	it('is read-only for a member who can only read hiring, and cannot invite', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enable(organization.id, ['enabled', 'hiring'])
		const { cookie } = await memberWith(organization.id, [
			'org_perm_read_hiring_any',
		])
		const result = await outcome(() =>
			pageLoader({
				request: createAuthenticatedRequest(url(organization.slug), {}, cookie),
				params: { orgSlug: organization.slug },
			} as any),
		)
		expect(result.status).toBe(200)
		expect(result.data.canWrite).toBe(false)
		expect(result.data.canInvite).toBe(false)
	})

	it('offers the app invitation only to a member who may also update staff and invite members', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enable(organization.id, ['enabled', 'hiring'])
		// A hiring manager with no staff or member permissions cannot invite.
		const recruiter = await memberWith(organization.id, [
			'org_perm_read_hiring_any',
			'org_perm_update_hiring_any',
		])
		const result = await outcome(() =>
			pageLoader({
				request: createAuthenticatedRequest(
					url(organization.slug),
					{},
					recruiter.cookie,
				),
				params: { orgSlug: organization.slug },
			} as any),
		)
		expect(result.data.canWrite).toBe(true)
		expect(result.data.canInvite).toBe(false)
	})

	it('offers it to an admin', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enable(organization.id, ['enabled', 'hiring'])
		const result = await outcome(() =>
			pageLoader({
				request: createAuthenticatedRequest(url(organization.slug), {}, cookie),
				params: { orgSlug: organization.slug },
			} as any),
		)
		expect(result.data.canInvite).toBe(true)
	})

	it('refuses a member with no hiring permission', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enable(organization.id, ['enabled', 'hiring'])
		const { cookie } = await memberWith(organization.id, [])
		const result = await outcome(() =>
			pageLoader({
				request: createAuthenticatedRequest(url(organization.slug), {}, cookie),
				params: { orgSlug: organization.slug },
			} as any),
		)
		expect([403, 404]).toContain(result.status)
	})

	it('does not offer an app invitation in the Saudi region', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enable(organization.id, ['enabled', 'hiring'])
		await db
			.update(Organization)
			.set({ dataRegion: 'ksa' })
			.where(eq(Organization.id, organization.id))
		const result = await outcome(() =>
			pageLoader({
				request: createAuthenticatedRequest(url(organization.slug), {}, cookie),
				params: { orgSlug: organization.slug },
			} as any),
		)
		expect(result.status).toBe(200)
		expect(result.data.canInvite).toBe(false)
	})

	it('is closed to someone outside the organization', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enable(organization.id, ['enabled', 'hiring'])
		const stranger = await createTestUser()
		const { cookie } = await createTestSession(stranger.id)
		const result = await outcome(() =>
			pageLoader({
				request: createAuthenticatedRequest(url(organization.slug), {}, cookie),
				params: { orgSlug: organization.slug },
			} as any),
		)
		expect([403, 404]).toContain(result.status)
	})
})

describe('applicant sheet loader', () => {
	it('checks access itself and hands the id to the page', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enable(organization.id, ['enabled', 'hiring'])
		const result = await outcome(() =>
			applicantLoader({
				request: createAuthenticatedRequest(
					url(organization.slug, '/a1'),
					{},
					cookie,
				),
				params: { orgSlug: organization.slug, applicationId: 'a1' },
			} as any),
		)
		expect(result).toEqual({ status: 200, data: { applicationId: 'a1' } })
	})
})
