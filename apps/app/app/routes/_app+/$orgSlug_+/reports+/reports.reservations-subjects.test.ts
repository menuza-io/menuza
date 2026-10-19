import {
	_OrganizationPermissionToRole,
	ConfigFlag,
	db,
	inArray,
	OrganizationLocation,
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

describe('Reservations category deep link', () => {
	async function reader(organizationId: string) {
		await enableReservations(organizationId)
		// A host-style role: only the reservation report grant.
		return member(organizationId, [P.READ_RESERVATION_REPORT])
	}

	it('lists the Reservations templates for a report reader and passes the category and location', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const cookie = await reader(organization.id)
		const result = (await indexLoader({
			...(args(organization.slug, '', cookie) as object),
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/reports?category=Reservations&location=loc_1`,
				{},
				cookie,
			),
		} as never)) as unknown as {
			category: string | null
			location: string | null
			templates: Array<{ id: string; category: string }>
		}
		expect(result.category).toBe('Reservations')
		expect(result.location).toBe('loc_1')
		const ids = result.templates
			.filter((template) => template.category === 'Reservations')
			.map((template) => template.id)
		expect(ids).toEqual(
			expect.arrayContaining(['rsv-daily-summary', 'rsv-pacing']),
		)
	})

	it('offers no Reservations template to someone without the report grant', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableReservations(organization.id)
		const cookie = await member(organization.id, [
			ANALYTICS,
			P.READ_RESERVATION,
		])
		const result = (await indexLoader(
			args(organization.slug, '', cookie),
		)) as unknown as { templates: Array<{ category: string }> }
		expect(
			result.templates.filter(
				(template) => template.category === 'Reservations',
			),
		).toEqual([])
	})

	it('opens a template limited to the location the link carries', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const cookie = await reader(organization.id)
		const [location] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: organization.id,
				name: 'Harbor Street',
				slug: `harbor-${crypto.randomUUID().slice(0, 6)}`,
			})
			.returning({ id: OrganizationLocation.id })
		const open = async (query: string) =>
			(await newLoader({
				...(args(organization.slug, 'new', cookie) as object),
				request: createAuthenticatedRequest(
					`http://localhost:3000/${organization.slug}/reports/new?${query}`,
					{},
					cookie,
				),
			} as never)) as unknown as {
				definition: {
					subject: string
					filters: { conditions: Array<{ field: string; value: string }> }
				}
			}
		const filtered = await open(
			`template=rsv-no-show-rate&location=${location!.id}`,
		)
		expect(filtered.definition.subject).toBe('bookings')
		expect(filtered.definition.filters.conditions).toContainEqual(
			expect.objectContaining({ field: 'location', value: 'Harbor Street' }),
		)
		// A location id from another organization adds no filter.
		const foreign = await open('template=rsv-no-show-rate&location=nope')
		expect(
			foreign.definition.filters.conditions.some((c) => c.field === 'location'),
		).toBe(false)
		// A category alone opens on one of its own templates.
		const byCategory = await open('category=Reservations')
		expect(byCategory.definition.subject).toBe('bookings')
	})

	it('opens a blank report, not a Reservations template, without the grant', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableReservations(organization.id)
		const cookie = await member(organization.id, [ANALYTICS])
		const result = (await newLoader({
			...(args(organization.slug, 'new', cookie) as object),
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/reports/new?category=Reservations`,
				{},
				cookie,
			),
		} as never)) as unknown as { definition: { subject: string } }
		expect(result.definition.subject).not.toBe('bookings')
	})
})
