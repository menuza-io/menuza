import {
	_OrganizationPermissionToRole,
	ConfigFlag,
	db,
	inArray,
	OrganizationRole,
} from '@repo/database'
import { blankReportDefinition } from '@repo/reports'
import { saveReport } from '@repo/reports/server'
import {
	RESERVATIONS_FLAG_KEYS,
	RESERVATIONS_PERMISSIONS as P,
} from '@repo/reservations'
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

import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader as indexLoader } from './_index.tsx'
import { loader as newLoader } from './new.tsx'

const flagIds: string[] = []

afterEach(async () => {
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
})

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
	return cookie
}

function args(slug: string, path: string, cookie: string) {
	return {
		request: createAuthenticatedRequest(
			`http://localhost:3000/${slug}/reports/${path}`,
			{},
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never
}

type Catalog = { subjects: Array<{ id: string }> }

const ANALYTICS = 'read:settings:any'

describe('report builder offers the Reservations subjects', () => {
	it('lists Bookings and Waitlist entries for a report reader', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableReservations(organization.id)
		const cookie = await member(organization.id, [
			ANALYTICS,
			P.READ_RESERVATION_REPORT,
		])
		const result = (await newLoader(
			args(organization.slug, 'new', cookie),
		)) as unknown as { catalog: Catalog }
		const ids = result.catalog.subjects.map((subject) => subject.id)
		expect(ids).toEqual(
			expect.arrayContaining(['bookings', 'waitlist_entries']),
		)
	})

	it('lists a saved Bookings report only for a report reader', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await enableReservations(organization.id)
		await saveReport({
			scope: 'organization',
			organizationId: organization.id,
			createdById: user.id,
			definition: {
				...blankReportDefinition('organization'),
				subject: 'bookings',
			},
		})
		const reader = await member(organization.id, [
			ANALYTICS,
			P.READ_RESERVATION_REPORT,
		])
		const other = await member(organization.id, [ANALYTICS])
		const countOf = async (cookie: string) =>
			(
				(await indexLoader(args(organization.slug, '', cookie))) as unknown as {
					savedReports: unknown[]
				}
			).savedReports.length
		expect(await countOf(reader)).toBe(1)
		expect(await countOf(other)).toBe(0)
	})

	it('hides both subjects without the report grant or with the flag off', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const noFlag = await member(organization.id, [
			ANALYTICS,
			P.READ_RESERVATION_REPORT,
		])
		await enableReservations(organization.id)
		const noGrant = await member(organization.id, [
			ANALYTICS,
			P.READ_RESERVATION,
		])
		for (const cookie of [noGrant]) {
			const result = (await newLoader(
				args(organization.slug, 'new', cookie),
			)) as unknown as { catalog: Catalog }
			const ids = result.catalog.subjects.map((subject) => subject.id)
			expect(ids).not.toContain('bookings')
			expect(ids).not.toContain('waitlist_entries')
		}
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
		const result = (await newLoader(
			args(organization.slug, 'new', noFlag),
		)) as unknown as { catalog: Catalog }
		expect(result.catalog.subjects.map((subject) => subject.id)).not.toContain(
			'bookings',
		)
	})
})
