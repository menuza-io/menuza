import { Hono, type Context } from 'hono'
import { type ZodTypeAny, type z } from 'zod'
import {
	payPeriodSettingsSchema,
	STAFFING_PERMISSIONS as P,
	timeCardCreateSchema,
	timeCardReviewSchema,
	timeCardUpdateSchema,
	timeCardVoidSchema,
	timesheetApproveSchema,
	timesheetDayQuerySchema,
	timesheetExportQuerySchema,
	timesheetPeriodQuerySchema,
	timesheetReopenSchema,
	timesheetReviewQuerySchema,
	type TimesheetWriteResult,
} from '@repo/staffing'
import { staffError } from '../lib/staff-auth.ts'
import {
	staffGuard,
	type StaffRequirement,
	type StaffRouteContext,
} from '../lib/staff-guard.ts'
import { json, readJsonBody, validationResponse } from '../lib/staff-http.ts'
import {
	createCard,
	reviewCard,
	runBatch,
	updateCard,
	voidCard,
	type BatchOp,
	type WriteContext,
	type WriteOutcome,
} from '../services/timesheet-write-service.ts'
import {
	buildExport,
	getPayPeriodSettings,
	loadCardById,
	loadCardDetail,
	loadDayView,
	loadPayrollSummary,
	loadPeriodView,
	loadReviewQueue,
	toEditLogEntry,
	updatePayPeriodSettings,
} from '../services/timesheet-view-service.ts'
import {
	moneyAccess,
	toTimesheetCard,
	type TimesheetContext,
	type TimesheetResult,
} from '../services/timesheet-shared.ts'
import { kioskDeps } from './kiosk.ts'

/**
 * `/operator/timeclock/timesheets`: day and pay-period views, the needs-review
 * queue, manager edits with a required reason and an append-only log, approval
 * and locking (a separate grant), the payroll summary and the CSV export.
 *
 * Reached browser-direct with an App-minted token of scope `timeclock`. Names
 * come from the roster, so views need `read:staff:any` besides
 * `read:timesheet:any`. Money (rates, pay, tips) is left out of every response
 * unless the token holds `read:staff_pay:any`; an aggregate labor cost needs
 * `read:labor:any`. A scope outside the token's scope answers 404.
 */
export const timesheetRoutes = new Hono()

type Handler = (ctx: TimesheetContext, c: Context) => Promise<Response>

function guarded(requirement: StaffRequirement, handler: Handler) {
	return staffGuard(
		'timeclock',
		'Timesheets',
		requirement,
		(ctx: StaffRouteContext, c) =>
			handler({ ...ctx, now: kioskDeps.punch.now() }, c),
	)
}

/** The same context with a transactional database handle for writes. */
function writable(ctx: TimesheetContext): WriteContext {
	return ctx as WriteContext
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

function param(c: Context, name: string): string {
	return c.req.param(name) ?? ''
}

const READ_VIEW: StaffRequirement = { all: [P.READ_TIMESHEET, P.READ_STAFF] }
const WRITE_CARD: StaffRequirement = { all: [P.UPDATE_TIMESHEET], write: true }
const APPROVE: StaffRequirement = { all: [P.APPROVE_TIMESHEET], write: true }

/** The result of a write: the card as it is now (money only with the grant) and its log row. */
async function writeResponse(
	ctx: TimesheetContext,
	result: TimesheetResult<WriteOutcome>,
	status: 200 | 201,
) {
	if (!result.ok) return respond(result)
	const access = moneyAccess(ctx.auth)
	const live = await loadCardById(ctx, result.value.entryId)
	const body: TimesheetWriteResult = {
		card: live ? toTimesheetCard(live, access) : null,
		edit: toEditLogEntry(result.value.edit, access),
		reducedHours: result.value.reducedHours,
	}
	return json(body, status)
}

// ---------------------------------------------------------------------------
// Pay period settings
// ---------------------------------------------------------------------------

timesheetRoutes.get(
	'/settings',
	guarded({ all: [P.READ_TIMESHEET] }, async (ctx) =>
		json(await getPayPeriodSettings(ctx)),
	),
)

timesheetRoutes.put(
	'/settings',
	guarded({ all: [P.UPDATE_LABOR_POLICY], write: true }, async (ctx, c) => {
		const body = await readJsonBody(c, payPeriodSettingsSchema)
		if ('error' in body) return body.error
		return respond(await updatePayPeriodSettings(ctx, body.data))
	}),
)

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

timesheetRoutes.get(
	'/day',
	guarded(READ_VIEW, async (ctx, c) => {
		const query = readQuery(c, timesheetDayQuerySchema)
		if ('error' in query) return query.error
		return respond(await loadDayView(ctx, query.data))
	}),
)

timesheetRoutes.get(
	'/period',
	guarded(READ_VIEW, async (ctx, c) => {
		const query = readQuery(c, timesheetPeriodQuerySchema)
		if ('error' in query) return query.error
		return respond(await loadPeriodView(ctx, query.data))
	}),
)

timesheetRoutes.get(
	'/review',
	guarded(READ_VIEW, async (ctx, c) => {
		const query = readQuery(c, timesheetReviewQuerySchema)
		if ('error' in query) return query.error
		return respond(await loadReviewQueue(ctx, query.data))
	}),
)

timesheetRoutes.get(
	'/summary',
	guarded(READ_VIEW, async (ctx, c) => {
		const query = readQuery(c, timesheetPeriodQuerySchema)
		if ('error' in query) return query.error
		return respond(await loadPayrollSummary(ctx, query.data))
	}),
)

timesheetRoutes.get(
	'/export',
	guarded(READ_VIEW, async (ctx, c) => {
		const query = readQuery(c, timesheetExportQuerySchema)
		if ('error' in query) return query.error
		return respond(await buildExport(ctx, query.data))
	}),
)

timesheetRoutes.get(
	'/entries/:id',
	guarded(READ_VIEW, async (ctx, c) =>
		respond(await loadCardDetail(ctx, param(c, 'id'))),
	),
)

// ---------------------------------------------------------------------------
// Card writes
// ---------------------------------------------------------------------------

timesheetRoutes.post(
	'/entries',
	guarded(WRITE_CARD, async (ctx, c) => {
		const body = await readJsonBody(c, timeCardCreateSchema)
		if ('error' in body) return body.error
		return writeResponse(ctx, await createCard(writable(ctx), body.data), 201)
	}),
)

timesheetRoutes.patch(
	'/entries/:id',
	guarded(WRITE_CARD, async (ctx, c) => {
		const body = await readJsonBody(c, timeCardUpdateSchema)
		if ('error' in body) return body.error
		return writeResponse(
			ctx,
			await updateCard(writable(ctx), param(c, 'id'), body.data),
			200,
		)
	}),
)

// The reason travels in the body: a delete without one is refused.
timesheetRoutes.delete(
	'/entries/:id',
	guarded(WRITE_CARD, async (ctx, c) => {
		const body = await readJsonBody(c, timeCardVoidSchema)
		if ('error' in body) return body.error
		return writeResponse(
			ctx,
			await voidCard(writable(ctx), param(c, 'id'), body.data),
			200,
		)
	}),
)

timesheetRoutes.post(
	'/entries/:id/review',
	guarded(WRITE_CARD, async (ctx, c) => {
		const body = await readJsonBody(c, timeCardReviewSchema)
		if ('error' in body) return body.error
		return writeResponse(
			ctx,
			await reviewCard(writable(ctx), param(c, 'id'), body.data),
			200,
		)
	}),
)

// ---------------------------------------------------------------------------
// Approval (separate grant)
// ---------------------------------------------------------------------------

function batchRoute(op: BatchOp, withReason: boolean) {
	return guarded(APPROVE, async (ctx, c) => {
		const body = withReason
			? await readJsonBody(c, timesheetReopenSchema)
			: await readJsonBody(c, timesheetApproveSchema)
		if ('error' in body) return body.error
		const data = body.data as {
			entries: Array<{ id: string; version: number }>
			note?: string
			reason?: string
		}
		return respond(
			await runBatch(
				writable(ctx),
				op,
				data.entries,
				withReason ? data.reason : data.note,
			),
		)
	})
}

timesheetRoutes.post('/approve', batchRoute('approve', false))
timesheetRoutes.post('/lock', batchRoute('lock', false))
timesheetRoutes.post('/unlock', batchRoute('unlock', true))
timesheetRoutes.post('/reopen', batchRoute('reopen', true))
