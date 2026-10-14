import { Hono, type Context } from 'hono'
import { type ZodTypeAny, type z } from 'zod'
import {
	availabilityCreateSchema,
	availabilityDecisionSchema,
	availabilityListQuerySchema,
	demandQuerySchema,
	forecastQuerySchema,
	publicationsQuerySchema,
	publishSchema,
	recommendSchema,
	resendSchema,
	scheduleDecisionSchema,
	scheduleSettingsUpdateSchema,
	shiftAssignSchema,
	shiftCreateSchema,
	shiftDeleteQuerySchema,
	shiftRequestCreateSchema,
	shiftRequestListQuerySchema,
	shiftUnassignSchema,
	shiftUpdateSchema,
	STAFFING_PERMISSIONS as P,
	templateApplySchema,
	templateCreateSchema,
	templateListQuerySchema,
	timeOffCreateSchema,
	timeOffListQuerySchema,
	weekCopySchema,
	weekQuerySchema,
} from '@repo/staffing'
import { type TenantDatabase } from '@repo/tenant-db'
import { staffError } from '../lib/staff-auth.ts'
import { staffGuard, type StaffRequirement } from '../lib/staff-guard.ts'
import { json, readJsonBody, validationResponse } from '../lib/staff-http.ts'
import {
	applyTemplate,
	copyWeek,
	createTemplate,
	deleteTemplate,
	listTemplates,
	recommendWeek,
} from '../services/schedule-plan-service.ts'
import {
	getLinkStatus,
	listNotices,
	resendNotices,
	revokeLink,
} from '../services/schedule-notify-service.ts'
import {
	listPublications,
	publishWeek,
} from '../services/schedule-publish-service.ts'
import { registerSchedule } from '../services/schedule-registry.ts'
import {
	type ScheduleContext,
	type ScheduleResult,
} from '../services/schedule-shared.ts'
import {
	cancelShiftRequest,
	createShiftRequest,
	decideShiftRequest,
	listShiftRequests,
} from '../services/schedule-shift-request-service.ts'
import {
	assignShift,
	createShifts,
	deleteShift,
	revertShift,
	updateShift,
} from '../services/schedule-shift-service.ts'
import {
	cancelAvailability,
	cancelTimeOff,
	createAvailability,
	createTimeOff,
	decideAvailability,
	decideTimeOff,
	listAvailability,
	listTimeOff,
} from '../services/schedule-timeoff-service.ts'
import { loadForecastGap } from '../services/forecast-service.ts'
import {
	getDemand,
	getScheduleSettings,
	loadWeek,
	updateScheduleSettings,
} from '../services/schedule-week-service.ts'
import { kioskDeps } from './kiosk.ts'

/**
 * `/operator/schedule`: the week grid, shifts, copy, templates, "recommend a
 * schedule", publishing, the demand guide, time off, availability and swap,
 * cover and drop requests.
 *
 * Reached browser-direct with an App-minted token of scope `schedule`, which
 * the App only mints while `staffing.scheduling` is on. Views need
 * `read:schedule:any` (and `read:staff:any`, since the grid names people);
 * writes need `update:schedule:any`. A shift's estimated cost needs the pay
 * grant and the labor footers need the labor grant: without them the keys are
 * absent. A scope outside the token's scope answers 404 (or 403 when a write
 * names it in its body). Conflicts are warnings returned with the shift and
 * never refuse a write.
 */
export const scheduleOperatorRoutes = new Hono()

// The time clock asks the schedule what is scheduled; plug it in once.
registerSchedule()

type Ctx = ScheduleContext & { db: TenantDatabase }
type Handler = (ctx: Ctx, c: Context) => Promise<Response>

function guarded(requirement: StaffRequirement, handler: Handler) {
	return staffGuard('schedule', 'Schedule', requirement, (ctx, c) =>
		handler({ ...ctx, now: kioskDeps.punch.now() }, c),
	)
}

function respond<T>(result: ScheduleResult<T>, status: 200 | 201 = 200) {
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

const READ_GRID: StaffRequirement = { all: [P.READ_SCHEDULE, P.READ_STAFF] }
const READ_SCHEDULE: StaffRequirement = { all: [P.READ_SCHEDULE] }
const WRITE: StaffRequirement = { all: [P.UPDATE_SCHEDULE], write: true }

// ---------------------------------------------------------------------------
// Week, demand, settings
// ---------------------------------------------------------------------------

scheduleOperatorRoutes.get(
	'/week',
	guarded(READ_GRID, async (ctx, c) => {
		const query = readQuery(c, weekQuerySchema)
		if ('error' in query) return query.error
		return respond(await loadWeek(ctx, query.data))
	}),
)

scheduleOperatorRoutes.get(
	'/demand',
	guarded(READ_SCHEDULE, async (ctx, c) => {
		const query = readQuery(c, demandQuerySchema)
		if ('error' in query) return query.error
		return respond(await getDemand(ctx, query.data))
	}),
)

// The forecast against the schedule belongs to the labor feature: the schedule
// token only carries `read:labor:any` while `staffing.labor` is on, so asking
// for it here also keeps it behind the flag.
scheduleOperatorRoutes.get(
	'/forecast',
	guarded({ all: [P.READ_SCHEDULE, P.READ_LABOR] }, async (ctx, c) => {
		const query = readQuery(c, forecastQuerySchema)
		if ('error' in query) return query.error
		return respond(await loadForecastGap(ctx, query.data))
	}),
)

scheduleOperatorRoutes.get(
	'/settings',
	guarded(READ_SCHEDULE, async (ctx) =>
		json(await getScheduleSettings(ctx.db)),
	),
)

scheduleOperatorRoutes.put(
	'/settings',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, scheduleSettingsUpdateSchema)
		if ('error' in body) return body.error
		return respond(await updateScheduleSettings(ctx, body.data))
	}),
)

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

scheduleOperatorRoutes.post(
	'/shifts',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, shiftCreateSchema)
		if ('error' in body) return body.error
		return respond(await createShifts(ctx, body.data), 201)
	}),
)

scheduleOperatorRoutes.patch(
	'/shifts/:id',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, shiftUpdateSchema)
		if ('error' in body) return body.error
		return respond(await updateShift(ctx, param(c, 'id'), body.data))
	}),
)

scheduleOperatorRoutes.delete(
	'/shifts/:id',
	guarded(WRITE, async (ctx, c) => {
		const query = readQuery(c, shiftDeleteQuerySchema)
		if ('error' in query) return query.error
		return respond(
			await deleteShift(ctx, param(c, 'id'), query.data.expectedVersion),
		)
	}),
)

scheduleOperatorRoutes.post(
	'/shifts/:id/assign',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, shiftAssignSchema)
		if ('error' in body) return body.error
		return respond(
			await assignShift(
				ctx,
				param(c, 'id'),
				body.data.staffId,
				body.data.expectedVersion,
			),
		)
	}),
)

scheduleOperatorRoutes.post(
	'/shifts/:id/unassign',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, shiftUnassignSchema)
		if ('error' in body) return body.error
		return respond(
			await assignShift(ctx, param(c, 'id'), null, body.data.expectedVersion),
		)
	}),
)

scheduleOperatorRoutes.post(
	'/shifts/:id/revert',
	guarded(WRITE, async (ctx, c) =>
		respond(await revertShift(ctx, param(c, 'id'))),
	),
)

// ---------------------------------------------------------------------------
// Copy, templates, recommend, publish
// ---------------------------------------------------------------------------

scheduleOperatorRoutes.post(
	'/copy',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, weekCopySchema)
		if ('error' in body) return body.error
		return respond(await copyWeek(ctx, body.data), 201)
	}),
)

scheduleOperatorRoutes.get(
	'/templates',
	guarded(READ_SCHEDULE, async (ctx, c) => {
		const query = readQuery(c, templateListQuerySchema)
		if ('error' in query) return query.error
		return respond(await listTemplates(ctx, query.data.scopeId))
	}),
)

scheduleOperatorRoutes.post(
	'/templates',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, templateCreateSchema)
		if ('error' in body) return body.error
		return respond(await createTemplate(ctx, body.data), 201)
	}),
)

scheduleOperatorRoutes.post(
	'/templates/:id/apply',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, templateApplySchema)
		if ('error' in body) return body.error
		return respond(await applyTemplate(ctx, param(c, 'id'), body.data), 201)
	}),
)

scheduleOperatorRoutes.delete(
	'/templates/:id',
	guarded(WRITE, async (ctx, c) =>
		respond(await deleteTemplate(ctx, param(c, 'id'))),
	),
)

scheduleOperatorRoutes.post(
	'/recommend',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, recommendSchema)
		if ('error' in body) return body.error
		const result = await recommendWeek(ctx, body.data)
		return respond(result, body.data.apply ? 201 : 200)
	}),
)

scheduleOperatorRoutes.post(
	'/publish',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, publishSchema)
		if ('error' in body) return body.error
		return respond(await publishWeek(ctx, body.data))
	}),
)

scheduleOperatorRoutes.get(
	'/publications',
	guarded(READ_SCHEDULE, async (ctx, c) => {
		const query = readQuery(c, publicationsQuerySchema)
		if ('error' in query) return query.error
		return respond(await listPublications(ctx, query.data))
	}),
)

scheduleOperatorRoutes.get(
	'/publications/:id/notices',
	guarded(READ_SCHEDULE, async (ctx, c) =>
		respond(await listNotices(ctx, param(c, 'id'))),
	),
)

scheduleOperatorRoutes.post(
	'/publications/:id/resend',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, resendSchema)
		if ('error' in body) return body.error
		return respond(await resendNotices(ctx, param(c, 'id'), body.data))
	}),
)

// A person's read-only "my schedule" link: whether it is live, and revoking it.
scheduleOperatorRoutes.get(
	'/links/:staffId',
	guarded(READ_GRID, async (ctx, c) =>
		respond(await getLinkStatus(ctx, param(c, 'staffId'))),
	),
)

scheduleOperatorRoutes.post(
	'/links/:staffId/revoke',
	guarded(WRITE, async (ctx, c) =>
		respond(await revokeLink(ctx, param(c, 'staffId'))),
	),
)

// ---------------------------------------------------------------------------
// Time off
// ---------------------------------------------------------------------------

scheduleOperatorRoutes.get(
	'/time-off',
	guarded(READ_GRID, async (ctx, c) => {
		const query = readQuery(c, timeOffListQuerySchema)
		if ('error' in query) return query.error
		return respond(await listTimeOff(ctx, query.data))
	}),
)

scheduleOperatorRoutes.post(
	'/time-off',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, timeOffCreateSchema)
		if ('error' in body) return body.error
		return respond(await createTimeOff(ctx, body.data), 201)
	}),
)

scheduleOperatorRoutes.post(
	'/time-off/:id/decision',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, scheduleDecisionSchema)
		if ('error' in body) return body.error
		return respond(await decideTimeOff(ctx, param(c, 'id'), body.data))
	}),
)

scheduleOperatorRoutes.post(
	'/time-off/:id/cancel',
	guarded(WRITE, async (ctx, c) =>
		respond(await cancelTimeOff(ctx, param(c, 'id'))),
	),
)

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

scheduleOperatorRoutes.get(
	'/availability',
	guarded(READ_GRID, async (ctx, c) => {
		const query = readQuery(c, availabilityListQuerySchema)
		if ('error' in query) return query.error
		return respond(await listAvailability(ctx, query.data))
	}),
)

scheduleOperatorRoutes.post(
	'/availability',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, availabilityCreateSchema)
		if ('error' in body) return body.error
		return respond(await createAvailability(ctx, body.data), 201)
	}),
)

scheduleOperatorRoutes.post(
	'/availability/decision',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, availabilityDecisionSchema)
		if ('error' in body) return body.error
		return respond(await decideAvailability(ctx, body.data))
	}),
)

scheduleOperatorRoutes.post(
	'/availability/:id/cancel',
	guarded(WRITE, async (ctx, c) =>
		respond(await cancelAvailability(ctx, param(c, 'id'))),
	),
)

// ---------------------------------------------------------------------------
// Swap, cover and drop requests
// ---------------------------------------------------------------------------

scheduleOperatorRoutes.get(
	'/requests',
	guarded(READ_GRID, async (ctx, c) => {
		const query = readQuery(c, shiftRequestListQuerySchema)
		if ('error' in query) return query.error
		return respond(await listShiftRequests(ctx, query.data))
	}),
)

scheduleOperatorRoutes.post(
	'/requests',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, shiftRequestCreateSchema)
		if ('error' in body) return body.error
		return respond(await createShiftRequest(ctx, body.data), 201)
	}),
)

scheduleOperatorRoutes.post(
	'/requests/:id/decision',
	guarded(WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, scheduleDecisionSchema)
		if ('error' in body) return body.error
		return respond(await decideShiftRequest(ctx, param(c, 'id'), body.data))
	}),
)

scheduleOperatorRoutes.post(
	'/requests/:id/cancel',
	guarded(WRITE, async (ctx, c) =>
		respond(await cancelShiftRequest(ctx, param(c, 'id'))),
	),
)
