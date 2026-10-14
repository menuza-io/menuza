import {
	_OrganizationPermissionToRole,
	ConfigFlag,
	db,
	inArray,
	OrganizationLocation,
	OrganizationRole,
} from '@repo/database'
import {
	STAFFING_FLAG_KEYS,
	STAFFING_PERMISSIONS as P,
	STAFFING_TOKEN_AUDIENCE,
	staffingTokenClaimsSchema,
} from '@repo/staffing'
import { jwtVerify } from 'jose'
import { ENV } from 'varlock/env'
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

vi.mock('@repo/auth', async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	isImpersonating: vi.fn(async () => false),
}))

import { getStaffingNavAccess } from '#app/utils/staffing/access.server.ts'
import { setMemberLocationScope } from '#app/utils/staffing/restaurant/location-scope.server.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader as teamImportLoader } from './team.import.tsx'
import { loader as teamLoader } from './team.tsx'
import { loader } from './token.ts'

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

async function manager(organizationId: string, permissions: string[]) {
	const [role] = await db
		.insert(OrganizationRole)
		.values({
			name: `Custom ${crypto.randomUUID().slice(0, 8)}`,
			description: '',
			level: 0,
			organizationId,
		})
		.returning({ id: OrganizationRole.id })
	await db.insert(_OrganizationPermissionToRole).values(
		permissions.map((permission) => ({
			A: role!.id,
			B: `org_perm_${permission.replaceAll(':', '_')}`,
		})),
	)
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, role!.id)
	const { cookie } = await createTestSession(user.id)
	return { user, cookie }
}

function request(slug: string, path: string, cookie: string) {
	return createAuthenticatedRequest(
		`http://localhost:3000/${slug}/${path}`,
		{},
		cookie,
	)
}

async function mint(slug: string, cookie: string, query = '') {
	return loader({
		request: request(slug, `staff/token${query}`, cookie),
		params: { orgSlug: slug },
		context: {},
	} as never)
}

async function failure(promise: Promise<unknown>) {
	try {
		await promise
		return 'ok' as const
	} catch (error) {
		if (error instanceof Response) return error.status
		const init = (error as { init?: { status?: number } }).init
		if (init?.status) return init.status
		throw error
	}
}

async function claims(jwt: string) {
	const { payload } = await jwtVerify(
		jwt,
		new TextEncoder().encode(ENV.TENANT_OPERATOR_TOKEN),
		{ audience: STAFFING_TOKEN_AUDIENCE, algorithms: ['HS256'] },
	)
	return payload
}

describe('staff token carries the member’s location scope', () => {
	it('mints scopeIds: null for a member nobody restricted', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const { cookie } = await manager(organization.id, [P.READ_STAFF])
		const result = await mint(organization.slug, cookie)
		expect(result.data.scopeIds).toBeNull()
		expect((await claims(result.data.jwt)).scopeIds).toBeNull()
	})

	it('mints exactly the selected location ids, in a claim tenant-api accepts', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const [a, b] = [
			await createLocation(organization.id),
			await createLocation(organization.id),
		]
		const { user, cookie } = await manager(organization.id, [
			P.READ_STAFF,
			P.UPDATE_STAFF,
		])
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: user.id,
			value: { scope: 'selected', locationIds: [b, a] },
		})
		const result = await mint(organization.slug, cookie)
		expect(result.data.scopeIds).toEqual([a, b].sort())
		const payload = await claims(result.data.jwt)
		expect(payload.scopeIds).toEqual([a, b].sort())
		expect(staffingTokenClaimsSchema.safeParse(payload).success).toBe(true)
	})

	it('applies to every scope, not just staff', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		for (const key of ['timeclock', 'scheduling', 'hiring'] as const) {
			const [row] = await db
				.insert(ConfigFlag)
				.values({
					key: STAFFING_FLAG_KEYS[key],
					value: true,
					level: 'organization',
					organizationId: organization.id,
				})
				.returning({ id: ConfigFlag.id })
			flagIds.push(row!.id)
		}
		const a = await createLocation(organization.id)
		const { user, cookie } = await manager(organization.id, [
			P.READ_STAFF,
			P.READ_SCHEDULE,
			P.READ_TIMESHEET,
			P.READ_HIRING,
		])
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: user.id,
			value: { scope: 'selected', locationIds: [a] },
		})
		for (const scope of ['staff', 'schedule', 'timeclock', 'hiring']) {
			const result = await mint(organization.slug, cookie, `?scope=${scope}`)
			expect(result.data.scopeIds).toEqual([a])
			expect((await claims(result.data.jwt)).scopeIds).toEqual([a])
		}
	})

	it('mints nothing (403) for "selected" with no locations, rather than an all-access token', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const { user, cookie } = await manager(organization.id, [P.READ_STAFF])
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: user.id,
			value: { scope: 'selected', locationIds: [] },
		})
		expect(await failure(mint(organization.slug, cookie))).toBe(403)
		expect(
			await failure(
				teamLoader({
					request: request(organization.slug, 'staff/team', cookie),
					params: { orgSlug: organization.slug },
					context: {},
				} as never),
			),
		).toBe(403)
	})

	it('hides the Staff sidebar group for a member with no staffing locations', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const { user } = await manager(organization.id, [P.READ_STAFF])
		expect((await getStaffingNavAccess(user.id, organization.id)).visible).toBe(
			true,
		)
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: user.id,
			value: { scope: 'selected', locationIds: [] },
		})
		expect((await getStaffingNavAccess(user.id, organization.id)).visible).toBe(
			false,
		)
	})

	it('a flag that is off still wins: no token, whatever the scope', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id)
		const { user, cookie } = await manager(organization.id, [P.READ_STAFF])
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: user.id,
			value: { scope: 'selected', locationIds: [a] },
		})
		expect(await failure(mint(organization.slug, cookie))).toBe(404)
	})
})

describe('Team screens for a location-scoped manager', () => {
	it('lists only the locations the manager may use, and refuses the member import', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const [a, b] = [
			await createLocation(organization.id),
			await createLocation(organization.id),
		]
		const { user, cookie } = await manager(organization.id, [
			P.READ_STAFF,
			P.UPDATE_STAFF,
			'read:member:any',
		])
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: user.id,
			value: { scope: 'selected', locationIds: [a] },
		})
		const team = (await teamLoader({
			request: request(organization.slug, 'staff/team', cookie),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)) as unknown as {
			scopes: Array<{ id: string }>
			allScopes: boolean
		}
		expect(team.scopes.map((l) => l.id)).toEqual([a])
		expect(team.allScopes).toBe(false)
		expect(JSON.stringify(team)).not.toContain(b)

		expect(
			await failure(
				teamImportLoader({
					request: request(organization.slug, 'staff/team/import', cookie),
					params: { orgSlug: organization.slug },
					context: {},
				} as never),
			),
		).toBe(403)
	})

	it('still lets an unrestricted manager open the member import', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const { cookie } = await manager(organization.id, [
			P.READ_STAFF,
			P.UPDATE_STAFF,
			'read:member:any',
		])
		const result = (await teamImportLoader({
			request: request(organization.slug, 'staff/team/import', cookie),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)) as unknown as { members: unknown[] }
		expect(result.members.length).toBeGreaterThan(0)
	})
})
