import {
	_OrganizationPermissionToRole,
	ConfigFlag,
	db,
	inArray,
	OrganizationRole,
} from '@repo/database'
import {
	STAFFING_FLAG_KEYS,
	STAFFING_PERMISSIONS as P,
	STAFFING_TOKEN_AUDIENCE,
	STAFFING_TOKEN_TYP,
	staffingTokenClaimsSchema,
	type StaffingFeature,
} from '@repo/staffing'
import { jwtVerify } from 'jose'
import { ENV } from 'varlock/env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const mocks = vi.hoisted(() => ({ impersonating: false }))
vi.mock('@repo/auth', async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	isImpersonating: vi.fn(async () => mocks.impersonating),
}))

import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader } from './token.ts'

const flagIds: string[] = []

async function setFlag(feature: StaffingFeature, organizationId: string) {
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

async function customRole(organizationId: string, permissions: string[]) {
	const [role] = await db
		.insert(OrganizationRole)
		.values({
			name: `Custom ${crypto.randomUUID().slice(0, 8)}`,
			description: '',
			level: 0,
			organizationId,
		})
		.returning({ id: OrganizationRole.id })
	if (permissions.length > 0) {
		await db.insert(_OrganizationPermissionToRole).values(
			permissions.map((permission) => ({
				A: role!.id,
				B: `org_perm_${permission.replaceAll(':', '_')}`,
			})),
		)
	}
	return role!.id
}

async function memberWith(organizationId: string, permissions: string[]) {
	const user = await createTestUser()
	await addOrganizationMember(
		user.id,
		organizationId,
		await customRole(organizationId, permissions),
	)
	const { cookie } = await createTestSession(user.id)
	return { user, cookie }
}

async function mint(slug: string, cookie: string, query = '') {
	return loader({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${slug}/staff/token${query}`,
			{},
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never)
}

async function status(promise: Promise<unknown>): Promise<number | 'ok'> {
	try {
		await promise
		return 'ok'
	} catch (error) {
		if (error instanceof Response) return error.status
		// `data()` throws a DataWithResponseInit.
		const init = (error as { init?: { status?: number } }).init
		if (init?.status) return init.status
		throw error
	}
}

async function verify(jwt: string) {
	const { payload, protectedHeader } = await jwtVerify(
		jwt,
		new TextEncoder().encode(ENV.TENANT_OPERATOR_TOKEN),
		{ audience: STAFFING_TOKEN_AUDIENCE, algorithms: ['HS256'] },
	)
	return { payload, protectedHeader }
}

beforeEach(() => {
	mocks.impersonating = false
})

afterEach(async () => {
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
})

describe('staff token mint', () => {
	it('mints nothing while the master flag is off (default), even for an admin', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		expect(await status(mint(organization.slug, cookie))).toBe(404)
		expect(
			await status(mint(organization.slug, cookie, '?scope=schedule')),
		).toBe(404)
	})

	it('mints a scoped, short-lived token for an admin once the flag is on', async () => {
		const { organization, user, cookie } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		const result = await mint(organization.slug, cookie)
		const body = result.data
		expect(body.scope).toBe('staff')
		expect(body.tenantApiUrl).toMatch(/^https?:\/\//)
		expect(Object.keys(body).sort()).toEqual([
			'expiresAt',
			'grants',
			'jwt',
			'scope',
			'scopeIds',
			'tenantApiUrl',
		])

		const { payload, protectedHeader } = await verify(body.jwt)
		expect(protectedHeader.typ).toBe(STAFFING_TOKEN_TYP)
		expect(payload).toMatchObject({
			orgId: organization.id,
			sub: user.id,
			role: 'operator',
			scope: 'staff',
			region: 'us',
			scopeIds: null,
			impersonated: false,
		})
		expect(payload.grants).toEqual(
			expect.arrayContaining([
				P.READ_STAFF,
				P.UPDATE_STAFF,
				P.READ_STAFF_PAY,
				P.UPDATE_STAFF_PAY,
				P.READ_STAFF_PRIVATE,
				P.UPDATE_STAFF_PRIVATE,
			]),
		)
		// Pay and private grants shorten the life to 5 minutes.
		expect(payload.exp! - payload.iat!).toBe(5 * 60)
		expect(body.expiresAt).toBe(payload.exp! * 1000)
		// The same shape tenant-api validates.
		expect(
			staffingTokenClaimsSchema.safeParse({ ...payload, aud: payload.aud })
				.success,
		).toBe(true)
	})

	it('gives a token without pay or private grants the full 15 minutes', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		const { cookie } = await memberWith(organization.id, [P.READ_STAFF])
		const result = await mint(organization.slug, cookie)
		const { payload } = await verify(result.data.jwt)
		expect(payload.grants).toEqual([P.READ_STAFF])
		expect(payload.exp! - payload.iat!).toBe(15 * 60)
	})

	it('carries only the grants the user holds, never more', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		const { cookie } = await memberWith(organization.id, [
			P.READ_STAFF,
			P.UPDATE_STAFF,
			P.READ_SCHEDULE,
			P.READ_HIRING,
			P.READ_STAFF_PAY,
		])
		const { payload } = await verify(
			(await mint(organization.slug, cookie)).data.jwt,
		)
		expect(payload.grants).toEqual([
			P.READ_STAFF,
			P.UPDATE_STAFF,
			P.READ_STAFF_PAY,
		])
		expect(payload.grants).not.toContain(P.UPDATE_STAFF_PAY)
		expect(payload.grants).not.toContain(P.READ_STAFF_PRIVATE)
	})

	it('refuses members without a staff read permission (403) and mints nothing', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		for (const permissions of [[], [P.READ_STAFF_PAY], [P.READ_SCHEDULE]]) {
			const { cookie } = await memberWith(organization.id, permissions)
			expect(await status(mint(organization.slug, cookie))).toBe(403)
		}
		const member = await setupTestOrgWithUser('member')
		await setFlag('enabled', member.organization.id)
		expect(await status(mint(member.organization.slug, member.cookie))).toBe(
			403,
		)
	})

	it('refuses a user from another organization (404)', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		await setFlag('enabled', b.organization.id)
		expect(await status(mint(b.organization.slug, a.cookie))).toBe(404)
	})

	it('refuses an unknown workplace', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		for (const query of ['?scope=admin', '?scope=', '?scope=staff,schedule']) {
			expect(await status(mint(organization.slug, cookie, query))).toBe(400)
		}
	})

	it('needs each child flag for its own workplace', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		for (const scope of ['timeclock', 'schedule', 'hiring']) {
			expect(
				await status(mint(organization.slug, cookie, `?scope=${scope}`)),
			).toBe(404)
		}
		await setFlag('scheduling', organization.id)
		const result = await mint(organization.slug, cookie, '?scope=schedule')
		expect(result.data.scope).toBe('schedule')
		const { payload } = await verify(result.data.jwt)
		expect(payload.scope).toBe('schedule')
		// Wages stay in the staff scope.
		expect(payload.grants).not.toContain(P.READ_STAFF_PAY)
		expect(payload.grants).not.toContain(P.UPDATE_STAFF_PAY)
		expect(
			await status(mint(organization.slug, cookie, '?scope=timeclock')),
		).toBe(404)
	})

	it('adds the labor grant only while staffing.labor is on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		await setFlag('scheduling', organization.id)
		const without = await verify(
			(await mint(organization.slug, cookie, '?scope=schedule')).data.jwt,
		)
		expect(without.payload.grants).not.toContain(P.READ_LABOR)
		await setFlag('labor', organization.id)
		const withLabor = await verify(
			(await mint(organization.slug, cookie, '?scope=schedule')).data.jwt,
		)
		expect(withLabor.payload.grants).toContain(P.READ_LABOR)
	})

	it('mints the labor workplace only while staffing.labor is on, and only for the labor grant', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		// Flag off: nothing, even for an admin.
		expect(await status(mint(organization.slug, cookie, '?scope=labor'))).toBe(
			404,
		)
		// A child flag of another feature does not open it.
		await setFlag('timeclock', organization.id)
		expect(await status(mint(organization.slug, cookie, '?scope=labor'))).toBe(
			404,
		)
		await setFlag('labor', organization.id)
		const result = await mint(organization.slug, cookie, '?scope=labor')
		expect(result.data.scope).toBe('labor')
		const { payload } = await verify(result.data.jwt)
		expect(payload.scope).toBe('labor')
		expect(payload.grants).toEqual(
			expect.arrayContaining([P.READ_LABOR, P.READ_STAFF_PAY, P.READ_STAFF]),
		)
		// Never private data, never pay edits, never schedule or hiring.
		for (const grant of [
			P.UPDATE_STAFF_PAY,
			P.READ_STAFF_PRIVATE,
			P.UPDATE_STAFF_PRIVATE,
			P.READ_SCHEDULE,
			P.READ_HIRING,
		]) {
			expect(payload.grants).not.toContain(grant)
		}
		// Wages shorten the life to five minutes.
		expect(payload.exp! - payload.iat!).toBe(5 * 60)

		// The labor grant itself is required: hours-only roles get a 403.
		const hoursOnly = await memberWith(organization.id, [
			P.READ_STAFF,
			P.READ_TIMESHEET,
			P.READ_STAFF_PAY,
		])
		expect(
			await status(mint(organization.slug, hoursOnly.cookie, '?scope=labor')),
		).toBe(403)
		const viewer = await memberWith(organization.id, [
			P.READ_STAFF,
			P.READ_LABOR,
		])
		const viewerToken = await verify(
			(await mint(organization.slug, viewer.cookie, '?scope=labor')).data.jwt,
		)
		expect(viewerToken.payload.grants).toEqual([P.READ_STAFF, P.READ_LABOR])
		expect(viewerToken.payload.exp! - viewerToken.payload.iat!).toBe(15 * 60)
	})

	it('gives an impersonated session a read-only token with no pay or private grants', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		mocks.impersonating = true
		const { payload } = await verify(
			(await mint(organization.slug, cookie)).data.jwt,
		)
		expect(payload.impersonated).toBe(true)
		expect(payload.grants).toEqual([P.READ_STAFF])
		expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(5 * 60)
	})

	it('answers with no-store headers', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		const result = await mint(organization.slug, cookie)
		expect(result.init?.headers).toMatchObject({
			'Cache-Control': 'private, no-store',
		})
	})

	it('refuses a request with no session', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		const outcome = await status(
			loader({
				request: new Request(
					`http://localhost:3000/${organization.slug}/staff/token`,
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as never),
		)
		expect(outcome).not.toBe('ok')
	})
})
