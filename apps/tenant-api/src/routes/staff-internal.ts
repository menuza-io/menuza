import { Hono, type Context } from 'hono'
import { type ZodTypeAny, type z } from 'zod'
import {
	internalEraseUserRequestSchema,
	internalExportUserRequestSchema,
	internalLinkUserRequestSchema,
	internalSummaryRequestSchema,
	internalUnlinkUserRequestSchema,
} from '@repo/staffing'
import { getTenantDb, type TenantDatabase } from '@repo/tenant-db'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import { getNodeRegion, orgMatchesNodeRegion } from '../lib/region.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import { describeStaffError } from '../services/staff-audit.ts'
import {
	eraseLinkedUser,
	exportSubject,
	linkUser,
	summarizeStaff,
	unlinkUser,
	type InternalResult,
} from '../services/staff-internal-service.ts'

/**
 * `/internal/staff`: commands the App's control plane sends to the regional
 * node (summary for the region-switch guard, link and unlink a login, erase a
 * deleted account, in-region export for access requests).
 *
 * Authenticated with `INTERNAL_COMMAND_TOKEN` only; an operator token never
 * works here. Every request names the organization, which must belong to this
 * node's region and have a database here. Bodies and responses are ids and
 * counts (the one exception, `export-user`, returns the data subject's own
 * record and refuses to run on a node whose data may not reach the US).
 */
export const staffInternalRoutes = new Hono()

const NO_STORE = { 'Cache-Control': 'private, no-store' }

staffInternalRoutes.use(
	'*',
	rateLimit('staff-internal', { windowMs: 60 * 1000, maxRequests: 240 }),
)

function respond(
	c: Context,
	status: number,
	body: Record<string, unknown>,
): Response {
	return c.json(body, status as 200, NO_STORE)
}

function authorize(c: Context): Response | null {
	const internalToken = getInternalCommandToken()
	if (internalToken.length < 16) {
		return respond(c, 503, { error: 'Not configured' })
	}
	const presented = getBearerToken(c.req.header('Authorization'))
	if (!presented || !timingSafeEqualString(presented, internalToken)) {
		return respond(c, 401, { error: 'Unauthorized' })
	}
	return null
}

type Handled<S extends ZodTypeAny> = (args: {
	c: Context
	db: TenantDatabase
	input: z.infer<S>
}) => Promise<Response>

/**
 * Shared prologue: token, body shape, organization, region, provisioning, then
 * the tenant database. The org id in the body is the only thing the caller
 * chooses, and it is checked against the control plane's own record.
 */
function internalHandler<S extends ZodTypeAny>(schema: S, handler: Handled<S>) {
	return async (c: Context) => {
		const denied = authorize(c)
		if (denied) return denied

		const raw = await c.req.json().catch(() => null)
		const parsed = schema.safeParse(raw)
		if (!parsed.success) {
			// Codes and paths only: a rejected value is never echoed back.
			return respond(c, 400, {
				error: 'invalid_request',
				issues: parsed.error.issues.slice(0, 10).map((issue) => ({
					path: issue.path.join('.'),
					code: issue.code,
				})),
			})
		}
		const input = parsed.data as { orgId: string }

		const organization = await findActiveOrganizationById(input.orgId)
		if (!organization) return respond(c, 404, { error: 'org_not_found' })
		if (!orgMatchesNodeRegion(organization.dataRegion)) {
			return respond(c, 409, {
				error: 'region_mismatch',
				orgRegion: organization.dataRegion,
				nodeRegion: getNodeRegion(),
			})
		}
		if (!organization.hasProvisionedDb) {
			return respond(c, 404, { error: 'org_not_provisioned' })
		}

		let db: TenantDatabase
		try {
			db = await getTenantDb(input.orgId)
		} catch (error) {
			console.error(
				'Staff internal: tenant database unavailable',
				describeStaffError(error),
			)
			return respond(c, 500, { error: 'tenant_database_unavailable' })
		}

		try {
			return await handler({ c, db, input: parsed.data })
		} catch (error) {
			// Drizzle quotes SQL parameters (names, ids) in its message; log the
			// root cause only.
			console.error(
				`Staff internal failed (${c.req.routePath})`,
				describeStaffError(error),
			)
			return respond(c, 500, { error: 'internal_error' })
		}
	}
}

function answer<T extends Record<string, unknown>>(
	c: Context,
	result: InternalResult<T>,
	status: 200 | 201 = 200,
) {
	if (result.ok) return respond(c, status, result.value)
	return respond(c, result.status, {
		error: result.error,
		...(result.message ? { message: result.message } : {}),
	})
}

staffInternalRoutes.post(
	'/summary',
	internalHandler(internalSummaryRequestSchema, async ({ c, db }) =>
		respond(c, 200, { ...(await summarizeStaff(db)) }),
	),
)

staffInternalRoutes.post(
	'/link-user',
	internalHandler(internalLinkUserRequestSchema, async ({ c, db, input }) =>
		answer(
			c,
			await linkUser(db, {
				staffMemberId: input.staffMemberId,
				userId: input.userId,
			}),
		),
	),
)

staffInternalRoutes.post(
	'/unlink-user',
	internalHandler(internalUnlinkUserRequestSchema, async ({ c, db, input }) =>
		answer(c, await unlinkUser(db, { userId: input.userId })),
	),
)

staffInternalRoutes.post(
	'/erase-user',
	internalHandler(internalEraseUserRequestSchema, async ({ c, db, input }) =>
		answer(c, await eraseLinkedUser(db, { userId: input.userId })),
	),
)

staffInternalRoutes.post(
	'/export-user',
	internalHandler(internalExportUserRequestSchema, async ({ c, db, input }) =>
		answer(
			c,
			await exportSubject(db, { userId: input.userId }, { orgId: input.orgId }),
		),
	),
)
