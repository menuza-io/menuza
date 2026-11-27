import { csvLines } from '@repo/reports/export'
import {
	reportGrantsSchema,
	reportRunSpecSchema,
	reportSendRequestSchema,
} from '@repo/reports/send-contract'
import { TENANT_ORG_ID_PATTERN, getTenantDb } from '@repo/tenant-db'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { verifyReportCsvToken } from '../lib/report-csv-link.ts'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import {
	buildCsvRows,
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
	if (internalToken.length < 16) return respond(c, 503, { error: 'not_configured' })
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

const csvParamsSchema = z.object({ orgId: z.string().regex(TENANT_ORG_ID_PATTERN) })
const csvSpecSchema = z.object({
	req: reportRunSpecSchema,
	grants: reportGrantsSchema,
})

reportsPublicRoutes.get('/csv/:orgId', async (c) => {
	const notFound = () => c.body('Not found', 404, NO_STORE)
	const params = csvParamsSchema.safeParse({ orgId: c.req.param('orgId') })
	const token = c.req.query('t')
	if (!params.success || !token) return notFound()
	const payload = verifyReportCsvToken(token)
	if (!payload || payload.o !== params.data.orgId) return notFound()
	const spec = csvSpecSchema.safeParse(payload.spec)
	if (!spec.success || spec.data.req.orgId !== params.data.orgId) return notFound()
	const organization = await findActiveOrganizationById(params.data.orgId)
	if (
		!organization ||
		!organization.hasProvisionedDb ||
		!orgMatchesNodeRegion(organization.dataRegion)
	) {
		return notFound()
	}
	try {
		const rows = await buildCsvRows(spec.data.req, spec.data.grants)
		if (!Array.isArray(rows)) return notFound()
		return new Response(csvLines(rows), {
			status: 200,
			headers: {
				...NO_STORE,
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': 'attachment; filename="report.csv"',
			},
		})
	} catch {
		return notFound()
	}
})
