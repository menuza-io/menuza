import {
	_OrganizationPermissionToRole,
	and,
	ConfigFlag,
	db,
	eq,
	inArray,
	Organization,
	OrganizationLocation,
	OrganizationRole,
	UserOrganization,
	UserOrganizationLocation,
} from '@repo/database'
import {
	RESERVATIONS_FLAG_KEYS,
	RESERVATIONS_PERMISSIONS as P,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
	reservationsTokenClaimsSchema,
	type ReservationsFeature,
} from '@repo/reservations'
import { decodeProtectedHeader, jwtVerify } from 'jose'
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

import { loader } from '#app/routes/_app+/$orgSlug_+/reservations+/token.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'

const flagIds: string[] = []

async function setFlag(
	feature: ReservationsFeature,
	organizationId: string,
	value = true,
) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: RESERVATIONS_FLAG_KEYS[feature],
			value,
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
			`http://localhost:3000/${slug}/reservations/token${query}`,
			{},
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never)
}

beforeEach(() => {
	mocks.impersonating = false
})

afterEach(async () => {
	if (flagIds.length > 0) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds.splice(0)))
	}
})

describe('Reservations operator token minting (VAL-FND-016)', () => {
	it('returns 404 when reservations.enabled is off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await expect(mint(organization.slug, cookie)).rejects.toMatchObject({
			status: 404,
		})
	})

	it('returns 400 on unknown scope and 403 when user lacks grants for the scope', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id, true)

		await expect(
			mint(organization.slug, cookie, '?scope=invalid'),
		).rejects.toMatchObject({
			init: { status: 400 },
		})

		const { cookie: guestOnlyCookie } = await memberWith(organization.id, [
			P.READ_RESERVATION_GUEST,
		])
		await expect(
			mint(organization.slug, guestOnlyCookie, '?scope=reports'),
		).rejects.toMatchObject({
			status: 403,
		})
	})

	it('returns 404 for scope=payments when reservations.payments is off, and mints when on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id, true)

		await expect(
			mint(organization.slug, cookie, '?scope=payments'),
		).rejects.toMatchObject({
			status: 404,
		})

		await setFlag('payments', organization.id, true)
		const res = await mint(organization.slug, cookie, '?scope=payments')
		expect(res.data.scope).toBe('payments')
		expect(res.data.grants).toEqual([
			P.READ_RESERVATION,
			P.UPDATE_RESERVATION_PAYMENT,
		])
	})

	it('signs HS256 rsv+jwt with aud tenant-api-reservations-operator, private no-store headers, and 900s/300s TTL', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id, true)

		// Host role (non-sensitive grants -> 900s TTL)
		const { user: hostUser, cookie: hostCookie } = await memberWith(
			organization.id,
			[P.READ_RESERVATION, P.UPDATE_RESERVATION],
		)
		const hostRes = await mint(organization.slug, hostCookie, '?scope=book')
		expect(hostRes.init?.headers).toEqual({
			'Cache-Control': 'private, no-store',
		})
		expect(hostRes.data.scope).toBe('book')
		expect(hostRes.data.grants).toEqual([
			P.READ_RESERVATION,
			P.UPDATE_RESERVATION,
		])
		expect(hostRes.data.locationIds).toBeNull()
		expect(hostRes.data.tenantApiUrl).toContain('3007')

		const header = decodeProtectedHeader(hostRes.data.jwt)
		expect(header).toEqual({ alg: 'HS256', typ: RESERVATIONS_TOKEN_TYP })

		const verified = await jwtVerify(
			hostRes.data.jwt,
			new TextEncoder().encode(ENV.TENANT_OPERATOR_TOKEN),
			{ audience: RESERVATIONS_TOKEN_AUDIENCE },
		)
		const claims = reservationsTokenClaimsSchema.parse(verified.payload)
		expect(claims.orgId).toBe(organization.id)
		expect(claims.sub).toBe(hostUser.id)
		expect(claims.region).toBe('us')
		expect(claims.exp - claims.iat).toBe(900)

		// Guestbook manager (sensitive guest grants -> 300s TTL)
		const { cookie: guestMgrCookie } = await memberWith(organization.id, [
			P.READ_RESERVATION_GUEST,
			P.UPDATE_RESERVATION_GUEST,
		])
		const guestRes = await mint(
			organization.slug,
			guestMgrCookie,
			'?scope=guests',
		)
		const guestVerified = await jwtVerify(
			guestRes.data.jwt,
			new TextEncoder().encode(ENV.TENANT_OPERATOR_TOKEN),
			{ audience: RESERVATIONS_TOKEN_AUDIENCE },
		)
		const guestClaims = reservationsTokenClaimsSchema.parse(
			guestVerified.payload,
		)
		expect(guestClaims.exp - guestClaims.iat).toBe(300)
		expect(guestClaims.grants).toEqual([
			P.READ_RESERVATION_GUEST,
			P.UPDATE_RESERVATION_GUEST,
		])

		// Impersonation strips write and sensitive grants and caps TTL at 300s
		mocks.impersonating = true
		const { cookie: adminCookie } = await createTestSession(user.id)
		const impRes = await mint(organization.slug, adminCookie, '?scope=book')
		const impVerified = await jwtVerify(
			impRes.data.jwt,
			new TextEncoder().encode(ENV.TENANT_OPERATOR_TOKEN),
			{ audience: RESERVATIONS_TOKEN_AUDIENCE },
		)
		const impClaims = reservationsTokenClaimsSchema.parse(impVerified.payload)
		expect(impClaims.impersonated).toBe(true)
		expect(impClaims.exp - impClaims.iat).toBe(300)
		expect(impClaims.grants).toEqual([P.READ_RESERVATION])
	})

	it('intersects locationIds with UserOrganization.locationScope and resolves KSA tenantApiUrl', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id, true)
		await db
			.update(Organization)
			.set({ dataRegion: 'ksa' })
			.where(eq(Organization.id, organization.id))

		const [locA] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: organization.id,
				name: 'Riyadh Main',
				slug: 'riyadh-main',
				isDefault: true,
				isActive: true,
			})
			.returning({ id: OrganizationLocation.id })

		const { user: scopedUser, cookie: scopedCookie } = await memberWith(
			organization.id,
			[P.READ_RESERVATION],
		)
		await db
			.update(UserOrganization)
			.set({ locationScope: 'selected' })
			.where(
				and(
					eq(UserOrganization.userId, scopedUser.id),
					eq(UserOrganization.organizationId, organization.id),
				),
			)

		// Selected with no locations -> 403
		await expect(
			mint(organization.slug, scopedCookie, '?scope=book'),
		).rejects.toMatchObject({
			status: 403,
		})

		// Assign locA -> locationIds: [locA.id] and KSA tenantApiUrl
		await db.insert(UserOrganizationLocation).values({
			userId: scopedUser.id,
			organizationId: organization.id,
			locationId: locA!.id,
		})
		const res = await mint(organization.slug, scopedCookie, '?scope=book')
		expect(res.data.locationIds).toEqual([locA!.id])
		expect(res.data.tenantApiUrl).toContain('3009')
	})
})
