import { Hono, type Context } from 'hono'
import { type ZodTypeAny, type z } from 'zod'
import {
	laborScopeQuerySchema,
	laborRangeQuerySchema,
	laborSettingsUpdateSchema,
	salesBulkSchema,
	salesDeleteQuerySchema,
	salesEntryPutSchema,
	STAFFING_PERMISSIONS as P,
	tipPoolSettingsUpdateSchema,
} from '@repo/staffing'
import { type TenantDatabase } from '@repo/tenant-db'
import { staffError } from '../lib/staff-auth.ts'
import {
	staffGuard,
	type StaffRequirement,
	type StaffRouteContext,
} from '../lib/staff-guard.ts'
import { json, readJsonBody, validationResponse } from '../lib/staff-http.ts'
import {
	bulkSales,
	deleteSale,
	exportLaborSummary,
	getLaborSettings,
	type LaborContext,
	listLaborPositions,
	listSales,
	loadLaborSummary,
	putSale,
	updateLaborSettings,
} from '../services/labor-service.ts'
import {
	buildTipPool,
	exportTipPool,
	getTipPoolSettings,
	updateTipPoolSettings,
} from '../services/tip-pool-service.ts'
import { type TimesheetResult } from '../services/timesheet-shared.ts'
import { kioskDeps } from './kiosk.ts'

/**
 * `/operator/labor`: the labor summary (hours, estimated wages, sales and the
 * labor share by day), the scope's sales source and staffing standards, the
 * sales a team enters by hand or uploads, and the tip-pool report.
 *
 * Reached browser-direct with an App-minted token of scope `labor`, which the
 * App only mints while `staffing.labor` is on, so the feature flag is enforced
 * at the token and nothing here looks flags up. Every route needs the labor
 * grant (`read:labor:any`); impersonated sessions are refused by the services
 * because they never see wages. The tip report also needs the pay grant (it
 * names people and amounts) and the roster grant. Writes need the matching
 * update grant: settings use `update:labor_policy:any`, daily sales use
 * `update:timesheet:any`. A scope outside the token's scope answers 404
 * (403 when a write names it in its body).
 */
export const laborRoutes = new Hono()

type Handler = (ctx: LaborContext, c: Context) => Promise<Response>

function guarded(requirement: StaffRequirement, handler: Handler) {
	return staffGuard(
		'labor',
		'Labor',
		requirement,
		(ctx: StaffRouteContext, c) =>
			handler(
				{ ...ctx, now: kioskDeps.punch.now() } as LaborContext & {
					db: TenantDatabase
				},
				c,
			),
	)
}

function respond<T>(result: TimesheetResult<T>, status: 200 | 201 = 200) {
	if (result.ok) return json(result.value, status)
	return staffError(result.status, result.error, result.extra ?? {})
}

function readQuery<S extends ZodTypeAny>(
	c: Context,
	schema: S,
): { data: z.infer<S> } | { error: Response } {
	const parsed = schema.safeParse(
		Object.fromEntries(new URL(c.req.url).searchParams),
	)
	if (!parsed.success) return { error: validationResponse(parsed.error) }
	return { data: parsed.data }
}

const READ: StaffRequirement = { all: [P.READ_LABOR] }
const READ_TIPS: StaffRequirement = {
	all: [P.READ_LABOR, P.READ_STAFF_PAY, P.READ_STAFF],
}
const WRITE_SETTINGS: StaffRequirement = {
	all: [P.READ_LABOR, P.UPDATE_LABOR_POLICY],
	write: true,
}
const WRITE_SALES: StaffRequirement = {
	all: [P.READ_LABOR, P.UPDATE_TIMESHEET],
	write: true,
}
const WRITE_TIP_SETTINGS: StaffRequirement = {
	all: [P.READ_LABOR, P.READ_STAFF_PAY, P.UPDATE_LABOR_POLICY],
	write: true,
}

// ---------------------------------------------------------------------------
// Sales source and staffing standards
// ---------------------------------------------------------------------------

laborRoutes.get(
	'/settings',
	guarded(READ, async (ctx, c) => {
		const query = readQuery(c, laborScopeQuerySchema)
		if ('error' in query) return query.error
		return respond(await getLaborSettings(ctx, query.data))
	}),
)

laborRoutes.put(
	'/settings',
	guarded(WRITE_SETTINGS, async (ctx, c) => {
		const body = await readJsonBody(c, laborSettingsUpdateSchema)
		if ('error' in body) return body.error
		return respond(await updateLaborSettings(ctx, body.data))
	}),
)

laborRoutes.get(
	'/positions',
	guarded(READ, async (ctx) => respond(await listLaborPositions(ctx))),
)

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

laborRoutes.get(
	'/summary',
	guarded(READ, async (ctx, c) => {
		const query = readQuery(c, laborRangeQuerySchema)
		if ('error' in query) return query.error
		return respond(await loadLaborSummary(ctx, query.data))
	}),
)

laborRoutes.get(
	'/summary/export',
	guarded(READ, async (ctx, c) => {
		const query = readQuery(c, laborRangeQuerySchema)
		if ('error' in query) return query.error
		return respond(await exportLaborSummary(ctx, query.data))
	}),
)

// ---------------------------------------------------------------------------
// Sales a team enters
// ---------------------------------------------------------------------------

laborRoutes.get(
	'/sales',
	guarded(READ, async (ctx, c) => {
		const query = readQuery(c, laborRangeQuerySchema)
		if ('error' in query) return query.error
		return respond(await listSales(ctx, query.data))
	}),
)

laborRoutes.put(
	'/sales',
	guarded(WRITE_SALES, async (ctx, c) => {
		const body = await readJsonBody(c, salesEntryPutSchema)
		if ('error' in body) return body.error
		return respond(await putSale(ctx, body.data))
	}),
)

laborRoutes.post(
	'/sales/bulk',
	guarded(WRITE_SALES, async (ctx, c) => {
		const body = await readJsonBody(c, salesBulkSchema)
		if ('error' in body) return body.error
		return respond(await bulkSales(ctx, body.data))
	}),
)

laborRoutes.delete(
	'/sales',
	guarded(WRITE_SALES, async (ctx, c) => {
		const query = readQuery(c, salesDeleteQuerySchema)
		if ('error' in query) return query.error
		return respond(await deleteSale(ctx, query.data))
	}),
)

// ---------------------------------------------------------------------------
// Tip pool
// ---------------------------------------------------------------------------

laborRoutes.get(
	'/tips/settings',
	guarded(READ_TIPS, async (ctx, c) => {
		const query = readQuery(c, laborScopeQuerySchema)
		if ('error' in query) return query.error
		return respond(await getTipPoolSettings(ctx, query.data))
	}),
)

laborRoutes.put(
	'/tips/settings',
	guarded(WRITE_TIP_SETTINGS, async (ctx, c) => {
		const body = await readJsonBody(c, tipPoolSettingsUpdateSchema)
		if ('error' in body) return body.error
		return respond(await updateTipPoolSettings(ctx, body.data))
	}),
)

laborRoutes.get(
	'/tips',
	guarded(READ_TIPS, async (ctx, c) => {
		const query = readQuery(c, laborRangeQuerySchema)
		if ('error' in query) return query.error
		return respond(await buildTipPool(ctx, query.data))
	}),
)

laborRoutes.get(
	'/tips/export',
	guarded(READ_TIPS, async (ctx, c) => {
		const query = readQuery(c, laborRangeQuerySchema)
		if ('error' in query) return query.error
		return respond(await exportTipPool(ctx, query.data))
	}),
)
