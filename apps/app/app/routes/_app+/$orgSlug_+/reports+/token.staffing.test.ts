import {
	_OrganizationPermissionToRole,
	ConfigFlag,
	db,
	inArray,
	OrganizationRole,
} from '@repo/database'
import { verifyOperatorAnalyticsToken } from '@repo/reports/token'
import { STAFFING_FLAG_KEYS, STAFFING_PERMISSIONS as P } from '@repo/staffing'
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
import { loader as indexLoader } from './_index.tsx'
import { loader as newLoader } from './new.tsx'
import { loader } from './token.ts'

const flagIds: string[] = []

async function setFlags(
	organizationId: string,
	keys: Array<keyof typeof STAFFING_FLAG_KEYS>,
) {
	for (const key of keys) {
		const [row] = await db
			.insert(ConfigFlag)
			.values({
				key: STAFFING_FLAG_KEYS[key],
				value: true,
				level: 'organization',
				organizationId,
			})
			.returning({ id: ConfigFlag.id })
		flagIds.push(row!.id)
	}
}

afterEach(async () => {
	impersonating.value = false
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
})

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

function args(slug: string, path: string, cookie: string) {
	return {
		request: createAuthenticatedRequest(
			`http://localhost:3000/${slug}/${path}`,
			{},
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never
}

async function mint(slug: string, cookie: string) {
	const result = (await loader(args(slug, 'reports/token', cookie))) as {
		data: { token: string; subjects: string[] }
		init?: { headers?: Record<string, string> } | null
	}
	const claims = await verifyOperatorAnalyticsToken({
		internalCommandToken: ENV.INTERNAL_COMMAND_TOKEN || '',
		token: result.data.token,
	})
	return {
		subjects: result.data.subjects,
		claims: claims!,
		headers: result.init?.headers ?? {},
	}
}

const ANALYTICS = 'read:settings:any'

describe('reports token for staff subjects', () => {
	it('lists no staff subject while the staffing flags are off', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const { cookie } = await manager(organization.id, [
			ANALYTICS,
			P.READ_STAFF,
			P.READ_TIMESHEET,
			P.READ_LABOR,
			P.READ_STAFF_PAY,
		])
		const { subjects, claims } = await mint(organization.slug, cookie)
		for (const staff of [
			'time_entries',
			'shifts',
			'labor_daily',
			'applications',
			'staff_pay',
		]) {
			expect(subjects).not.toContain(staff)
			expect(claims.subjects).not.toContain(staff)
		}
	})

	it('lists exactly the subjects the flags and permissions allow', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlags(organization.id, ['enabled', 'timeclock', 'labor'])
		const { cookie } = await manager(organization.id, [
			ANALYTICS,
			P.READ_STAFF,
			P.READ_TIMESHEET,
			P.READ_LABOR,
			P.READ_HIRING,
		])
		const { subjects, claims } = await mint(organization.slug, cookie)
		// Hiring access without the hiring flag, and no pay grant, stay out.
		expect(subjects.filter((s) => !['phone_calls'].includes(s)).sort()).toEqual(
			expect.arrayContaining(['labor_daily', 'time_entries']),
		)
		expect(subjects).not.toContain('applications')
		expect(subjects).not.toContain('shifts')
		expect(subjects).not.toContain('staff_pay')
		expect(claims.scopeIds).toBeNull()
	})

	it('never lets a token that can unlock staff data be cached', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlags(organization.id, ['enabled', 'timeclock'])
		const { cookie } = await manager(organization.id, [
			ANALYTICS,
			P.READ_STAFF,
			P.READ_TIMESHEET,
		])
		const { headers } = await mint(organization.slug, cookie)
		expect(headers['Cache-Control']).toBe('private, no-store')
	})

	it('carries the pay permission and every scope', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlags(organization.id, ['enabled', 'timeclock', 'labor'])
		const { cookie } = await manager(organization.id, [
			ANALYTICS,
			P.READ_STAFF,
			P.READ_TIMESHEET,
			P.READ_STAFF_PAY,
		])
		const { subjects, claims } = await mint(organization.slug, cookie)
		expect(subjects).toEqual(
			expect.arrayContaining(['time_entries', 'staff_pay']),
		)
		expect(claims.scopeIds).toBeNull()
	})

	it('gives an impersonated session no staff subject', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlags(organization.id, ['enabled', 'timeclock', 'labor'])
		const { cookie } = await manager(organization.id, [
			ANALYTICS,
			P.READ_STAFF,
			P.READ_TIMESHEET,
			P.READ_LABOR,
			P.READ_STAFF_PAY,
		])
		impersonating.value = true
		const { subjects } = await mint(organization.slug, cookie)
		expect(subjects).not.toContain('time_entries')
		expect(subjects).not.toContain('labor_daily')
		expect(subjects).not.toContain('staff_pay')
	})
})

describe('reports screens hide staff reports', () => {
	it('offers no staff template or subject while the flags are off, and all of them with access', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const { cookie } = await manager(organization.id, [
			ANALYTICS,
			P.READ_STAFF,
			P.READ_TIMESHEET,
			P.READ_LABOR,
		])
		const off = (await indexLoader(
			args(organization.slug, 'reports', cookie),
		)) as { templates: Array<{ category: string }> }
		expect(off.templates.some((t) => t.category === 'Labor')).toBe(false)
		const offNew = (await newLoader(
			args(organization.slug, 'reports/new?template=hours-by-employee', cookie),
		)) as { catalog: { subjects: Array<{ id: string }> }; definition: any }
		expect(offNew.catalog.subjects.map((s) => s.id)).not.toContain(
			'time_entries',
		)
		// A template that is not offered opens a blank report instead.
		expect(offNew.definition.subject).not.toBe('time_entries')

		await setFlags(organization.id, ['enabled', 'timeclock', 'labor'])
		const on = (await indexLoader(
			args(organization.slug, 'reports', cookie),
		)) as { templates: Array<{ id: string; category: string }> }
		const ids = on.templates.map((t) => t.id)
		expect(ids).toContain('hours-by-employee')
		expect(ids).toContain('labor-cost-percent-by-day')
		// No scheduling or hiring flag, and no pay grant.
		expect(ids).not.toContain('applicant-funnel')
		expect(ids).not.toContain('labor-by-position')
		const onNew = (await newLoader(
			args(organization.slug, 'reports/new?template=hours-by-employee', cookie),
		)) as { definition: any }
		expect(onNew.definition.subject).toBe('time_entries')
	})
})
