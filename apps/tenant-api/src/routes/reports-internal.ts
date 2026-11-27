import { csvLines } from '@repo/reports/export'
import { reportFiguresRequestSchema } from '@repo/reports/figures-contract'
import { reportSendRequestSchema } from '@repo/reports/send-contract'
import { TENANT_ORG_ID_PATTERN, getTenantDb } from '@repo/tenant-db'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { verifyReportCsvToken } from '../lib/report-csv-link.ts'
import { checkReportLink } from '../lib/report-link-check.ts'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { rateLimit, rateLimitByKey } from '../lib/rate-limit.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import {
	ACCOUNTING_MAX_DAYS,
	loadAccountingFacts,
} from '../services/accounting-daily-records.ts'
import {
	buildCsvRows,
	computeMonthlyFigures,
	ReportHasPersonalFieldsError,
	sendScheduledReport,
} from '../services/scheduled-report-service.ts'

/**
 * App to region: scheduled report emails (#121). Server to server with the
 * internal command token; the App decides what is due and who may receive it,
 * the region runs the report and sends the email, and answers a status per
 * recipient (never a figure).
 *
 * - `POST /internal/reports/send` (the contract in `@repo/reports/send-contract`).
 *
 * And the public, signed CSV link the emails carry:
 * - `GET /reports/csv/:orgId?t=<token>` rebuilds the report for the grants in
 *   the token and answers it as a CSV file; 404 for anything forged, expired
 *   or for another organization.
 */
export const reportsInternalRoutes = new Hono()
export const reportsPublicRoutes = new Hono()

const NO_STORE = { 'Cache-Control': 'private, no-store' }

reportsInternalRoutes.use(
	'*',
	rateLimit('reports-internal', { windowMs: 60 * 1000, maxRequests: 120 }),
)

function respond(c: Context, status: number, body: Record<string, unknown>) {
	return c.json(body, status as 200, NO_STORE)
}

function authorize(c: Context): Response | null {
	const internalToken = getInternalCommandToken()
	if (internalToken.length < 16)
		return respond(c, 503, { error: 'not_configured' })
	const presented = getBearerToken(c.req.header('Authorization'))
	if (!presented || !timingSafeEqualString(presented, internalToken)) {
		return respond(c, 401, { error: 'unauthorized' })
	}
	return null
}

reportsInternalRoutes.post('/send', async (c) => {
	const denied = authorize(c)
	if (denied) return denied
	const parsed = reportSendRequestSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) {
		return respond(c, 400, { error: 'invalid_request' })
	}
	const req = parsed.data
	if (!TENANT_ORG_ID_PATTERN.test(req.orgId)) {
		return respond(c, 400, { error: 'invalid_request' })
	}
	const organization = await findActiveOrganizationById(req.orgId)
	if (!organization || !organization.hasProvisionedDb) {
		return respond(c, 404, { error: 'org_not_found' })
	}
	if (!orgMatchesNodeRegion(organization.dataRegion)) {
		return respond(c, 409, { error: 'region_mismatch' })
	}
	try {
		await getTenantDb(req.orgId)
		return c.json(await sendScheduledReport(req), 200, NO_STORE)
	} catch (error) {
		if (error instanceof ReportHasPersonalFieldsError) {
			return respond(c, 422, { error: 'report_has_personal_fields' })
		}
		console.error(
			'Scheduled report send failed:',
			error instanceof Error ? error.message : 'unknown',
		)
		return respond(c, 500, { error: 'send_failed' })
	}
})

/**
 * `POST /internal/reports/figures` (#221): the month's totals for the monthly
 * results email, one answer per set of grants. Totals only.
 */
reportsInternalRoutes.post('/figures', async (c) => {
	const denied = authorize(c)
	if (denied) return denied
	const parsed = reportFiguresRequestSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success || !TENANT_ORG_ID_PATTERN.test(parsed.data.orgId)) {
		return respond(c, 400, { error: 'invalid_request' })
	}
	const organization = await findActiveOrganizationById(parsed.data.orgId)
	if (!organization || !organization.hasProvisionedDb) {
		return respond(c, 404, { error: 'org_not_found' })
	}
	if (!orgMatchesNodeRegion(organization.dataRegion)) {
		return respond(c, 409, { error: 'region_mismatch' })
	}
	try {
		await getTenantDb(parsed.data.orgId)
		return c.json(await computeMonthlyFigures(parsed.data), 200, NO_STORE)
	} catch (error) {
		console.error(
			'Monthly figures failed:',
			error instanceof Error ? error.message : 'unknown',
		)
		return respond(c, 500, { error: 'figures_failed' })
	}
})

const accountingRequestSchema = z.object({
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
	from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Limits the figures to these locations (a location-scoped caller); null is all. */
	locationIds: z
		.array(z.string().min(1).max(64))
		.max(500)
		.nullable()
		.default(null),
})

/**
 * `POST /internal/reports/accounting` (#189): the daily accounting figures for
 * a range, for the App's export and the weekly bookkeeper email, which build
 * the files from them. Totals per location, day and currency only.
 */
reportsInternalRoutes.post('/accounting', async (c) => {
	const denied = authorize(c)
	if (denied) return denied
	const parsed = accountingRequestSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) return respond(c, 400, { error: 'invalid_request' })
	const { orgId, from, to, locationIds } = parsed.data
	const span = (Date.parse(to) - Date.parse(from)) / 86_400_000
	if (!(span >= 0) || span + 1 > ACCOUNTING_MAX_DAYS) {
		return respond(c, 400, { error: 'invalid_range' })
	}
	const organization = await findActiveOrganizationById(orgId)
	if (!organization || !organization.hasProvisionedDb) {
		return respond(c, 404, { error: 'org_not_found' })
	}
	if (!orgMatchesNodeRegion(organization.dataRegion)) {
		return respond(c, 409, { error: 'region_mismatch' })
	}
	try {
		const facts = await loadAccountingFacts({
			db: await getTenantDb(orgId),
			orgId,
			locationIds,
			fromDate: from,
			toDate: to,
		})
		if (facts.truncated) return respond(c, 422, { error: 'range_too_large' })
		return c.json({ days: facts.days }, 200, NO_STORE)
	} catch (error) {
		console.error(
			'Accounting facts failed:',
			error instanceof Error ? error.message : 'unknown',
		)
		return respond(c, 500, { error: 'accounting_failed' })
	}
})

const csvParamsSchema = z.object({
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
})

/**
 * The link is a bearer capability, so it is rate limited per address and per
 * organization (each download reruns the report), never cached, never sent on
 * as a Referer, and checked with the App on every download.
 */
reportsPublicRoutes.use(
	'/csv/*',
	rateLimit('reports-csv', { windowMs: 60 * 1000, maxRequests: 20 }),
)
const CSV_ORG_LIMIT = { windowMs: 60 * 1000, maxRequests: 60 }
const CSV_HEADERS = {
	...NO_STORE,
	'Referrer-Policy': 'no-referrer',
	'X-Robots-Tag': 'noindex',
}

reportsPublicRoutes.get('/csv/:orgId', async (c) => {
	const notFound = () => c.body('Not found', 404, CSV_HEADERS)
	const params = csvParamsSchema.safeParse({ orgId: c.req.param('orgId') })
	const token = c.req.query('t')
	if (!params.success || !token) return notFound()
	const payload = verifyReportCsvToken(token)
	if (
		!payload ||
		payload.o !== params.data.orgId ||
		payload.spec.req.orgId !== params.data.orgId
	) {
		return notFound()
	}
	if (
		rateLimitByKey('reports-csv-org', params.data.orgId, CSV_ORG_LIMIT).limited
	) {
		return c.body('Too many requests', 429, {
			...CSV_HEADERS,
			'Retry-After': '60',
		})
	}
	const organization = await findActiveOrganizationById(params.data.orgId)
	if (
		!organization ||
		!organization.hasProvisionedDb ||
		!orgMatchesNodeRegion(organization.dataRegion)
	) {
		return notFound()
	}
	// Ask the App every time: a removed member, a deleted, paused or switched
	// off schedule or an unsubscribed recipient revokes the link, and the
	// recipient's grants are today's. An App that cannot answer fails closed.
	const check = await checkReportLink({
		orgId: params.data.orgId,
		scheduleId: payload.spec.req.scheduleId,
		userId: payload.u,
	})
	if (check.status === 'unavailable') {
		return c.body('Try again later', 503, {
			...CSV_HEADERS,
			'Retry-After': '60',
		})
	}
	if (check.status === 'revoked') return notFound()
	try {
		const rows = await buildCsvRows(payload.spec.req, check.grants)
		if (!Array.isArray(rows)) return notFound()
		return new Response(csvLines(rows), {
			status: 200,
			headers: {
				...CSV_HEADERS,
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': 'attachment; filename="report.csv"',
			},
		})
	} catch {
		return notFound()
	}
})
