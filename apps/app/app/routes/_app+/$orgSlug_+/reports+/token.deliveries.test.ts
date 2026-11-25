import {
	_OrganizationPermissionToRole,
	ConfigFlag,
	db,
	inArray,
	OrganizationLocation,
	OrganizationRole,
} from '@repo/database'
import {
	DELIVERY_REPORT_SUBJECTS,
	SALES_STAFF_FIELD_PERMISSION,
	verifyOperatorAnalyticsToken,
} from '@repo/reports/token'
import { DELIVERY_IN_HOUSE_FLAG_KEY } from '@repo/common/delivery-runs'
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

import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader } from './token.ts'

const flagIds: string[] = []

async function enableDeliveries(organizationId: string) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: DELIVERY_IN_HOUSE_FLAG_KEY,
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
		signingSecret: ENV.OPERATOR_ANALYTICS_TOKEN || '',
		token: result.data.token,
	})
	return { subjects: result.data.subjects, claims: claims! }
}

const ANALYTICS = 'read:settings:any'
const MENU = 'read:menu:any'

describe('reports token for own-driver delivery subjects (#324)', () => {
	it('lists neither subject while delivery.in_house is off', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const { cookie } = await member(organization.id, [ANALYTICS, MENU])
		const { subjects, claims } = await mint(organization.slug, cookie)
		for (const subject of DELIVERY_REPORT_SUBJECTS) {
			expect(subjects).not.toContain(subject)
			expect(claims.subjects).not.toContain(subject)
		}
	})

	it('lists both subjects with the flag on, for a member who may read orders', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableDeliveries(organization.id)
		const { cookie } = await member(organization.id, [ANALYTICS, MENU])
		const { subjects, claims } = await mint(organization.slug, cookie)
		expect(subjects).toEqual(expect.arrayContaining([...DELIVERY_REPORT_SUBJECTS]))
		expect(claims.subjects).toEqual(expect.arrayContaining([...DELIVERY_REPORT_SUBJECTS]))
		// No staff grant: the driver name stays out of the token.
		expect(claims.subjects).not.toContain(SALES_STAFF_FIELD_PERMISSION)
	})

	it('gives a member without order access neither subject, even with the flag on', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableDeliveries(organization.id)
		const { cookie } = await member(organization.id, [ANALYTICS])
		const { subjects } = await mint(organization.slug, cookie)
		for (const subject of DELIVERY_REPORT_SUBJECTS) {
			expect(subjects).not.toContain(subject)
		}
	})

	it('carries the staff grant, which shows driver names, only for members who hold it', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableDeliveries(organization.id)
		const { cookie } = await member(organization.id, [
			ANALYTICS,
			MENU,
			'read:staff:any',
		])
		const { claims } = await mint(organization.slug, cookie)
		expect(claims.subjects).toEqual(
			expect.arrayContaining([...DELIVERY_REPORT_SUBJECTS, SALES_STAFF_FIELD_PERMISSION]),
		)
	})

	it('gives an impersonated session no driver names', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableDeliveries(organization.id)
		const { cookie } = await member(organization.id, [ANALYTICS, MENU, 'read:staff:any'])
		impersonating.value = true
		const { claims } = await mint(organization.slug, cookie)
		expect(claims.subjects).not.toContain(SALES_STAFF_FIELD_PERMISSION)
	})
})
