import {
	_OrganizationPermissionToRole,
	ConfigFlag,
	db,
	inArray,
	OrganizationLocation,
	OrganizationRole,
} from '@repo/database'
import { verifyOperatorAnalyticsToken } from '@repo/reports/token'
import {
	RESERVATIONS_FLAG_KEYS,
	RESERVATIONS_PERMISSIONS as P,
} from '@repo/reservations'
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

const impersonating = vi.hoisted(() => ({ value: false }))
vi.mock('@repo/auth', async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	isImpersonating: vi.fn(async () => impersonating.value),
}))

import { setMemberLocationScope } from '#app/utils/staffing/restaurant/location-scope.server.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader } from './token.ts'

const flagIds: string[] = []

async function enableReservations(organizationId: string) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: RESERVATIONS_FLAG_KEYS.enabled,
			value: true,
			level: 'organization',
			organizationId,
		})
		.returning({ id: ConfigFlag.id })
	flagIds.push(row!.id)
}

afterEach(async () => {
	impersonating.value = false
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

async function member(organizationId: string, permissions: string[]) {
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

async function mint(slug: string, cookie: string) {
	const result = (await loader({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${slug}/reports/token`,
			{},
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never)) as { data: { token: string; subjects: string[] } }
	const claims = await verifyOperatorAnalyticsToken({
		internalCommandToken: ENV.INTERNAL_COMMAND_TOKEN || '',
		token: result.data.token,
	})
	return { subjects: result.data.subjects, claims: claims! }
}

const ANALYTICS = 'read:settings:any'
const RESERVATION_SUBJECTS = ['bookings', 'waitlist_entries']

describe('reports token for reservations subjects', () => {
	it('lists neither subject while reservations.enabled is off', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const { cookie } = await member(organization.id, [
			ANALYTICS,
			P.READ_RESERVATION_REPORT,
		])
		const { subjects, claims } = await mint(organization.slug, cookie)
		for (const subject of RESERVATION_SUBJECTS) {
			expect(subjects).not.toContain(subject)
			expect(claims.subjects).not.toContain(subject)
		}
	})

	it('gives a member without the report grant neither subject', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableReservations(organization.id)
		const { cookie } = await member(organization.id, [
			ANALYTICS,
			P.READ_RESERVATION,
			P.READ_RESERVATION_GUEST,
		])
		const { subjects, claims } = await mint(organization.slug, cookie)
		for (const subject of RESERVATION_SUBJECTS) {
			expect(subjects).not.toContain(subject)
			expect(claims.subjects).not.toContain(subject)
		}
	})

	it('gives a report reader both subjects across every location', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableReservations(organization.id)
		const { cookie } = await member(organization.id, [
			ANALYTICS,
			P.READ_RESERVATION_REPORT,
		])
		const { subjects, claims } = await mint(organization.slug, cookie)
		expect(subjects).toEqual(expect.arrayContaining(RESERVATION_SUBJECTS))
		expect(claims.subjects).toEqual(
			expect.arrayContaining(RESERVATION_SUBJECTS),
		)
		expect(claims.scopeIds).toBeNull()
	})

	it('limits the token to the locations the member may see', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableReservations(organization.id)
		const allowed = await createLocation(organization.id)
		await createLocation(organization.id)
		const { user, cookie } = await member(organization.id, [
			ANALYTICS,
			P.READ_RESERVATION_REPORT,
		])
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: user.id,
			value: { scope: 'selected', locationIds: [allowed] },
		})
		const { claims } = await mint(organization.slug, cookie)
		expect(claims.subjects).toEqual(
			expect.arrayContaining(RESERVATION_SUBJECTS),
		)
		expect(claims.scopeIds).toEqual([allowed])
	})

	it('gives an impersonated session neither subject', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableReservations(organization.id)
		const { cookie } = await member(organization.id, [
			ANALYTICS,
			P.READ_RESERVATION_REPORT,
		])
		impersonating.value = true
		const { subjects } = await mint(organization.slug, cookie)
		for (const subject of RESERVATION_SUBJECTS) {
			expect(subjects).not.toContain(subject)
		}
	})
})

describe('reports token gate for reservation-only roles', () => {
	it('mints a token for a role holding only the reservation report grant', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableReservations(organization.id)
		const { cookie } = await member(organization.id, [
			P.READ_RESERVATION_REPORT,
		])
		const { subjects, claims } = await mint(organization.slug, cookie)
		expect(subjects).toEqual(expect.arrayContaining(RESERVATION_SUBJECTS))
		expect(claims.subjects).toEqual(
			expect.arrayContaining(RESERVATION_SUBJECTS),
		)
		// No analytics grant: nothing beyond the reservation subjects.
		expect(subjects).not.toContain('orders')
		expect(subjects).not.toContain('phone_calls')
	})

	it('still refuses a role with neither an admin report grant nor a module grant', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableReservations(organization.id)
		const { cookie } = await member(organization.id, [
			P.READ_RESERVATION,
			P.READ_RESERVATION_GUEST,
		])
		await expect(mint(organization.slug, cookie)).rejects.toMatchObject({
			status: 403,
		})
	})

	it('refuses a reservation report holder while the flag is off', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const { cookie } = await member(organization.id, [
			P.READ_RESERVATION_REPORT,
		])
		await expect(mint(organization.slug, cookie)).rejects.toMatchObject({
			status: 403,
		})
	})
})
