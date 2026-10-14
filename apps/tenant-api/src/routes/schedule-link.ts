import { Hono, type Context } from 'hono'
import { type ZodTypeAny, type z } from 'zod'
import {
	selfAvailabilitySchema,
	selfRangeQuerySchema,
	selfShiftRequestSchema,
	selfTeammatesQuerySchema,
	selfTimeOffSchema,
} from '@repo/staffing'
import {
	authenticateScheduleLink,
	linkError,
	type ScheduleLinkAuth,
} from '../lib/schedule-link-auth.ts'
import { rateLimitByKey } from '../lib/rate-limit.ts'
import { json, readJsonBody, validationResponse } from '../lib/staff-http.ts'
import {
	cancelMyAvailability,
	cancelMyShiftRequest,
	cancelMyTimeOff,
	createMyAvailability,
	createMyShiftRequest,
	createMyTimeOff,
	listMyRequests,
	loadMySchedule,
	loadMyTeammates,
	loadMyTimeCards,
	type SelfContext,
} from '../services/schedule-self-service.ts'
import { type ScheduleResult } from '../services/schedule-shared.ts'
import { describeStaffError } from '../services/staff-audit.ts'

/**
 * `/schedule-link`: what a person can do with their own "my schedule" link.
 * Public routes authenticated by the link's bearer token
 * (`lib/schedule-link-auth.ts`), never by an operator token. The page is a
 * client app that calls these straight from the browser (the token lives in the
 * page address fragment), so no shift, time card or name passes through the
 * App's server.
 *
 * Reads return the person's own published shifts and time cards. Writes record
 * requests (time off, availability, swap, cover, drop) that wait for a manager;
 * none of them changes the schedule. A person's own audit rows carry the
 * `staff_link` actor kind.
 */
export const scheduleLinkRoutes = new Hono()

/** Test seam: the clock. */
export const scheduleLinkDeps: { now: () => number } = {
	now: () => Date.now(),
}

type Handler = (ctx: SelfContext, c: Context) => Promise<Response>

function selfContext(principal: ScheduleLinkAuth): SelfContext {
	return {
		db: principal.db,
		orgId: principal.orgId,
		staff: principal.staff,
		link: principal.link,
		ipHash: principal.ipHash,
		now: scheduleLinkDeps.now(),
	}
}

function guarded(handler: Handler, options: { write?: boolean } = {}) {
	return async (c: Context) => {
		const authed = await authenticateScheduleLink(c, scheduleLinkDeps)
		if ('error' in authed) return authed.error
		const { principal } = authed
		if (options.write) {
			// A leaked link cannot be used to flood a manager's queue.
			const limited = rateLimitByKey('schedule-link-write', principal.link.id, {
				windowMs: 60 * 60 * 1000,
				maxRequests: 40,
			})
			if (limited.limited) {
				return linkError(
					429,
					'rate_limit_exceeded',
					{ retryAfterSeconds: limited.retryAfter },
					{ 'Retry-After': String(limited.retryAfter) },
				)
			}
		}
		try {
			return await handler(selfContext(principal), c)
		} catch (error) {
			console.error(
				`Schedule link route failed (${c.req.method} ${c.req.routePath})`,
				describeStaffError(error),
			)
			return linkError(500, 'Internal Server Error')
		}
	}
}

function respond<T>(result: ScheduleResult<T>, status: 200 | 201 = 200) {
	if (result.ok) return json(result.value, status)
	return linkError(result.status, result.error, result.extra ?? {})
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

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

scheduleLinkRoutes.get(
	'/me',
	guarded(async (ctx, c) => {
		const query = readQuery(c, selfRangeQuerySchema)
		if ('error' in query) return query.error
		return respond(await loadMySchedule(ctx, query.data))
	}),
)

scheduleLinkRoutes.get(
	'/me/time-cards',
	guarded(async (ctx, c) => {
		const query = readQuery(c, selfRangeQuerySchema)
		if ('error' in query) return query.error
		return respond(await loadMyTimeCards(ctx, query.data))
	}),
)

scheduleLinkRoutes.get(
	'/me/requests',
	guarded(async (ctx) => respond(await listMyRequests(ctx))),
)

scheduleLinkRoutes.get(
	'/me/teammates',
	guarded(async (ctx, c) => {
		const query = readQuery(c, selfTeammatesQuerySchema)
		if ('error' in query) return query.error
		return respond(await loadMyTeammates(ctx, query.data.shiftId))
	}),
)

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

scheduleLinkRoutes.post(
	'/me/time-off',
	guarded(
		async (ctx, c) => {
			const body = await readJsonBody(c, selfTimeOffSchema)
			if ('error' in body) return body.error
			return respond(await createMyTimeOff(ctx, body.data), 201)
		},
		{ write: true },
	),
)

scheduleLinkRoutes.post(
	'/me/time-off/:id/cancel',
	guarded(
		async (ctx, c) => respond(await cancelMyTimeOff(ctx, param(c, 'id'))),
		{
			write: true,
		},
	),
)

scheduleLinkRoutes.post(
	'/me/availability',
	guarded(
		async (ctx, c) => {
			const body = await readJsonBody(c, selfAvailabilitySchema)
			if ('error' in body) return body.error
			return respond(await createMyAvailability(ctx, body.data), 201)
		},
		{ write: true },
	),
)

scheduleLinkRoutes.post(
	'/me/availability/:id/cancel',
	guarded(
		async (ctx, c) => respond(await cancelMyAvailability(ctx, param(c, 'id'))),
		{ write: true },
	),
)

scheduleLinkRoutes.post(
	'/me/shift-requests',
	guarded(
		async (ctx, c) => {
			const body = await readJsonBody(c, selfShiftRequestSchema)
			if ('error' in body) return body.error
			return respond(await createMyShiftRequest(ctx, body.data), 201)
		},
		{ write: true },
	),
)

scheduleLinkRoutes.post(
	'/me/shift-requests/:id/cancel',
	guarded(
		async (ctx, c) => respond(await cancelMyShiftRequest(ctx, param(c, 'id'))),
		{ write: true },
	),
)
