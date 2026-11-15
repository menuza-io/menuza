import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
	getTenantDb,
	invSoldOut,
	posDevices,
	restaurantOrders,
	TENANT_ORG_ID_PATTERN,
	type TenantDatabase,
} from '@repo/tenant-db'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import { countedOrderCondition } from '../services/report-records.ts'

/**
 * App to region facts for the home page and the launch checklist, with the
 * internal command token. Server to server only, and never anything about a
 * person: ids the control plane already knows, booleans and one timestamp.
 *
 * - `POST /internal/home/launch-facts` `{ orgId }`: the locations that have a
 *   paired Station terminal or kitchen display (not revoked) and when the
 *   first order that counts toward sales was placed. Used by the App's launch
 *   checklist (`terminalPaired`) and, through the App, by Admin's Launch card.
 * - `POST /internal/home/stock-sold-out` `{ orgId, locationId }`: the menu
 *   items inventory took off at a location and still holds off, so the home
 *   page never gives them back by hand (only the inventory undo may).
 */
export const homeInternalRoutes = new Hono()

const NO_STORE = { 'Cache-Control': 'private, no-store' }

homeInternalRoutes.use(
	'*',
	rateLimit('home-internal', { windowMs: 60 * 1000, maxRequests: 240 }),
)

const orgIdSchema = z.string().regex(TENANT_ORG_ID_PATTERN)
const launchFactsSchema = z.object({ orgId: orgIdSchema })
const stockSoldOutSchema = z.object({
	orgId: orgIdSchema,
	locationId: z.string().min(1).max(64),
})

function respond(c: Context, status: number, body: Record<string, unknown>) {
	return c.json(body, status as 200, NO_STORE)
}

function authorize(c: Context): Response | null {
	const internalToken = getInternalCommandToken()
	if (internalToken.length < 16) {
		return respond(c, 503, { error: 'not_configured' })
	}
	const presented = getBearerToken(c.req.header('Authorization'))
	if (!presented || !timingSafeEqualString(presented, internalToken)) {
		return respond(c, 401, { error: 'unauthorized' })
	}
	return null
}

async function openOrgDb(
	c: Context,
	orgId: string,
): Promise<{ db: TenantDatabase } | { response: Response }> {
	const organization = await findActiveOrganizationById(orgId)
	if (!organization || !organization.hasProvisionedDb) {
		return { response: respond(c, 404, { error: 'org_not_found' }) }
	}
	if (!orgMatchesNodeRegion(organization.dataRegion)) {
		return { response: respond(c, 409, { error: 'region_mismatch' }) }
	}
	try {
		return { db: await getTenantDb(orgId) }
	} catch {
		return {
			response: respond(c, 500, { error: 'tenant_database_unavailable' }),
		}
	}
}

async function readBody<S extends z.ZodTypeAny>(
	c: Context,
	schema: S,
): Promise<z.infer<S> | null> {
	const parsed = schema.safeParse(await c.req.json().catch(() => null))
	return parsed.success ? parsed.data : null
}

export async function loadLaunchFacts(db: TenantDatabase) {
	const [paired, first] = await Promise.all([
		db
			.selectDistinct({ locationId: posDevices.locationId })
			.from(posDevices)
			.where(
				and(isNull(posDevices.revokedAt), isNotNull(posDevices.locationId)),
			),
		db
			.select({
				firstAt: sql`min(${restaurantOrders.createdAt})`.mapWith(
					restaurantOrders.createdAt,
				),
			})
			.from(restaurantOrders)
			.where(countedOrderCondition()),
	])
	const firstAt = first[0]?.firstAt
	return {
		pairedLocationIds: paired
			.map((row) => row.locationId)
			.filter((id): id is string => Boolean(id))
			.sort(),
		firstOrderAt:
			firstAt instanceof Date && !Number.isNaN(firstAt.getTime())
				? firstAt.toISOString()
				: null,
	}
}

homeInternalRoutes.post('/launch-facts', async (c) => {
	const denied = authorize(c)
	if (denied) return denied
	const input = await readBody(c, launchFactsSchema)
	if (!input) return respond(c, 400, { error: 'invalid_request' })
	const opened = await openOrgDb(c, input.orgId)
	if ('response' in opened) return opened.response
	return respond(c, 200, await loadLaunchFacts(opened.db))
})

homeInternalRoutes.post('/stock-sold-out', async (c) => {
	const denied = authorize(c)
	if (denied) return denied
	const input = await readBody(c, stockSoldOutSchema)
	if (!input) return respond(c, 400, { error: 'invalid_request' })
	const opened = await openOrgDb(c, input.orgId)
	if ('response' in opened) return opened.response
	const rows = await opened.db
		.select({ entityId: invSoldOut.entityId })
		.from(invSoldOut)
		.where(
			and(
				eq(invSoldOut.locationId, input.locationId),
				eq(invSoldOut.entityType, 'item'),
				eq(invSoldOut.state, 'out'),
			),
		)
		.limit(1000)
	return respond(c, 200, {
		itemIds: [...new Set(rows.map((row) => row.entityId))].sort(),
	})
})
