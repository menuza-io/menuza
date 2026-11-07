import { ConfigFlag, db, inArray } from '@repo/database'
import { organizationTemplates } from '@repo/reports'
import { saveReport } from '@repo/reports/server'
import { STAFFING_FLAG_KEYS } from '@repo/staffing'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Every App route that hands the browser a regional tenant-api credential (a
 * JWT, or the tenant-api URL next to one) refuses a caller with no session
 * (login redirect or 401) and a signed-in user from another organization (403
 * or 404), and never puts a token in what it returns or throws. The static
 * sweep (`route-guards.test.ts`) proves each loader calls a membership guard;
 * this proves the guard actually answers.
 */

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

import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { loader as customersLoader } from '../routes/_app+/$orgSlug_+/customers.tsx'
import { loader as mailboxTokenLoader } from '../routes/_app+/$orgSlug_+/mailbox-token.ts'
import { loader as marketingLoader } from '../routes/_app+/$orgSlug_+/marketing+/_index.tsx'
import { loader as callsTokenLoader } from '../routes/_app+/$orgSlug_+/phone-agent+/calls-token.ts'
import { loader as reportLoader } from '../routes/_app+/$orgSlug_+/reports+/$reportId.tsx'
import { loader as newReportLoader } from '../routes/_app+/$orgSlug_+/reports+/new.tsx'
import { loader as reportsTokenLoader } from '../routes/_app+/$orgSlug_+/reports+/token.ts'
import { loader as staffTokenLoader } from '../routes/_app+/$orgSlug_+/staff+/token.ts'

type Loader = (args: never) => unknown

/** Route, path under the org, and loader. */
const ROUTES: Array<[string, string, Loader]> = [
	['mailbox-token.ts', 'mailbox-token', mailboxTokenLoader as Loader],
	['reports+/token.ts', 'reports/token', reportsTokenLoader as Loader],
	['staff+/token.ts', 'staff/token', staffTokenLoader as Loader],
	[
		'phone-agent+/calls-token.ts',
		'phone-agent/calls-token',
		callsTokenLoader as Loader,
	],
	['customers.tsx', 'customers', customersLoader as Loader],
	['marketing+/_index.tsx', 'marketing', marketingLoader as Loader],
	['reports+/new.tsx', 'reports/new', newReportLoader as Loader],
	['reports+/$reportId.tsx', 'reports/rpt_missing', reportLoader as Loader],
]

const flagIds: string[] = []

afterEach(async () => {
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
})

/** Turns every staffing flag on, so a refusal cannot come from a flag. */
async function enableStaffing(organizationId: string) {
	const rows = await db
		.insert(ConfigFlag)
		.values(
			Object.values(STAFFING_FLAG_KEYS).map((key) => ({
				key,
				value: true,
				level: 'organization' as const,
				organizationId,
			})),
		)
		.returning({ id: ConfigFlag.id })
	flagIds.push(...rows.map((row) => row.id))
}

function call(
	loader: Loader,
	slug: string,
	subpath: string,
	cookie?: string,
	reportId = 'rpt_missing',
) {
	const headers = new Headers()
	if (cookie) headers.set('Cookie', cookie)
	return loader({
		request: new Request(`http://localhost:3000/${slug}/${subpath}`, {
			headers,
		}),
		params: { orgSlug: slug, reportId },
		context: {},
		url: new URL(`http://localhost:3000/${slug}/${subpath}`),
	} as never)
}

/** A saved report in the organization, from the first built-in template. */
async function createReport(organizationId: string, createdById: string) {
	const template = organizationTemplates()[0]
	if (!template) throw new Error('No report templates')
	const report = await saveReport({
		scope: 'organization',
		organizationId,
		createdById,
		definition: template.definition,
	})
	if (!report) throw new Error('Failed to save the report')
	return report.id
}

type Outcome =
	| { kind: 'ok'; body: string }
	| { kind: 'refused'; status: number; location: string | null; body: string }

async function outcome(run: () => unknown): Promise<Outcome> {
	try {
		const value = await run()
		return { kind: 'ok', body: JSON.stringify(value) }
	} catch (error) {
		if (error instanceof Response) {
			return {
				kind: 'refused',
				status: error.status,
				location: error.headers.get('Location'),
				body: await error.text(),
			}
		}
		// `data()` throws a DataWithResponseInit.
		const init = (error as { init?: { status?: number } } | null)?.init
		if (init?.status) {
			return {
				kind: 'refused',
				status: init.status,
				location: null,
				body: JSON.stringify((error as { data?: unknown }).data ?? null),
			}
		}
		throw error
	}
}

/** A JWT (header.payload.signature, base64url JSON) anywhere in the text. */
const JWT_PATTERN = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/

describe('token-minting routes refuse callers outside the organization', () => {
	it.each(ROUTES)(
		'%s: no session gets a login redirect or 401, and no token',
		async (_name, subpath, loader) => {
			const { organization } = await setupTestOrgWithUser('admin')
			await enableStaffing(organization.id)
			const result = await outcome(() =>
				call(loader, organization.slug, subpath),
			)
			expect(result.kind).toBe('refused')
			if (result.kind !== 'refused') return
			if (result.status === 401) {
				expect(result.location).toBeNull()
			} else {
				expect(result.status).toBe(302)
				expect(result.location).toMatch(/^\/login(\?|$)/)
			}
			expect(result.body).not.toMatch(JWT_PATTERN)
			expect(result.body).not.toMatch(/tenantApiUrl/)
		},
	)

	it.each(ROUTES)(
		'%s: a signed-in admin of another organization gets 403 or 404, and no token',
		async (_name, subpath, loader) => {
			const target = await setupTestOrgWithUser('admin')
			const outsider = await setupTestOrgWithUser('admin')
			await enableStaffing(target.organization.id)
			await enableStaffing(outsider.organization.id)
			const result = await outcome(() =>
				call(loader, target.organization.slug, subpath, outsider.cookie),
			)
			expect(result.kind).toBe('refused')
			if (result.kind !== 'refused') return
			expect([403, 404]).toContain(result.status)
			expect(result.body).not.toMatch(JWT_PATTERN)
			expect(result.body).not.toMatch(/tenantApiUrl/)
		},
	)

	it.each(
		ROUTES.filter(([name]) =>
			[
				'mailbox-token.ts',
				'reports+/token.ts',
				'staff+/token.ts',
				'phone-agent+/calls-token.ts',
				'customers.tsx',
				'marketing+/_index.tsx',
			].includes(name),
		),
	)(
		'%s: an admin of the organization does get a credential (control)',
		async (_name, subpath, loader) => {
			const { organization, cookie } = await setupTestOrgWithUser('admin')
			await enableStaffing(organization.id)
			const result = await outcome(() =>
				call(loader, organization.slug, subpath, cookie),
			)
			expect(result).toMatchObject({ kind: 'ok' })
			expect(result.body).toMatch(JWT_PATTERN)
		},
	)

	it('reports+/$reportId.tsx: an outsider cannot open a report that exists', async () => {
		const target = await setupTestOrgWithUser('admin')
		const outsider = await setupTestOrgWithUser('admin')
		const reportId = await createReport(target.organization.id, target.user.id)
		const subpath = `reports/${reportId}`

		// Control: the organization's admin can open it.
		const own = await outcome(() =>
			call(
				reportLoader,
				target.organization.slug,
				subpath,
				target.cookie,
				reportId,
			),
		)
		expect(own).toMatchObject({ kind: 'ok' })

		const result = await outcome(() =>
			call(
				reportLoader,
				target.organization.slug,
				subpath,
				outsider.cookie,
				reportId,
			),
		)
		expect(result.kind).toBe('refused')
		if (result.kind !== 'refused') return
		expect([403, 404]).toContain(result.status)
		expect(result.body).not.toMatch(JWT_PATTERN)
		expect(result.body).not.toMatch(/tenantApiUrl/)
	})
})
