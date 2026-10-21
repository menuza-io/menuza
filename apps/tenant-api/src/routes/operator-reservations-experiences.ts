import {
	experienceActionSchema,
	RESERVATIONS_PERMISSIONS,
	setupExperienceInputSchema,
	setupExperienceScheduleInputSchema,
	setupExperienceScheduleUpdateSchema,
	setupExperienceUpdateSchema,
} from '@repo/reservations'
import { getTenantDb } from '@repo/tenant-db'
import { type Context, Hono } from 'hono'
import { type z } from 'zod'
import { handleRouteError, json, NO_STORE } from '../lib/http.ts'
import {
	ensureActiveOrgInNodeRegion,
	getRsvAuth,
	rsvGuard,
} from '../lib/reservations-guard.ts'
import {
	archiveExperience,
	createExperience,
	createExperienceSchedule,
	deleteExperienceSchedule,
	getExperience,
	listExperiences,
	publishExperience,
	unpublishExperience,
	updateExperience,
	updateExperienceSchedule,
} from '../services/rsv-experience-service.ts'

/**
 * `/operator/reservations/setup/locations/:locationId/experiences*`
 * (scope `setup`, feature `experiences`). Reads need
 * `read:reservation_settings:any`, writes `update:reservation_settings:any`
 * and are refused for impersonated tokens. The guard already checks the path
 * location against the token's `locationIds`; every service query also filters
 * by that location, so an id from another location is a 404.
 */
export const operatorReservationsExperiencesRoutes = new Hono()

const READ = rsvGuard({
	scope: 'setup',
	feature: 'experiences',
	grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
})

const WRITE = rsvGuard({
	scope: 'setup',
	feature: 'experiences',
	grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
	write: true,
})

/** Field paths and issue codes only: never the rejected value. */
function invalidResponse(error: z.ZodError): Response {
	return Response.json(
		{
			error: 'invalid',
			issues: error.issues.slice(0, 25).map((issue) => ({
				path: issue.path.join('.'),
				code: issue.code,
			})),
		},
		{ status: 400, headers: NO_STORE },
	)
}

async function readBody<S extends z.ZodTypeAny>(
	c: Context,
	schema: S,
	options: { optional?: boolean } = {},
): Promise<{ data: z.infer<S> } | { error: Response }> {
	let raw: unknown = {}
	const text = await c.req.text()
	if (text.trim()) {
		try {
			raw = JSON.parse(text)
		} catch {
			return {
				error: Response.json(
					{ error: 'invalid', issues: [{ path: '', code: 'invalid_json' }] },
					{ status: 400, headers: NO_STORE },
				),
			}
		}
	} else if (!options.optional) {
		raw = undefined
	}
	const parsed = schema.safeParse(raw)
	if (!parsed.success) return { error: invalidResponse(parsed.error) }
	return { data: parsed.data }
}

function handler(
	run: (
		c: Context,
		scope: {
			orgId: string
			actorId: string
			locationId: string
		},
	) => Promise<Response>,
) {
	return async (c: Context) => {
		try {
			const ctx = getRsvAuth(c)
			const orgErr = await ensureActiveOrgInNodeRegion(ctx)
			if (orgErr) return orgErr
			return await run(c, {
				orgId: ctx.orgId,
				actorId: ctx.userId,
				locationId: c.req.param('locationId') ?? '',
			})
		} catch (error) {
			return handleRouteError(error)
		}
	}
}

const idOf = (c: Context) => c.req.param('id') ?? ''
const both = (path: string) => [path, `${path}/`]

for (const path of both('/')) {
	operatorReservationsExperiencesRoutes.get(
		path,
		READ,
		handler(async (c, scope) => {
			const db = await getTenantDb(scope.orgId)
			const experiences = await listExperiences(db, scope.locationId)
			return json({ locationId: scope.locationId, experiences })
		}),
	)
	operatorReservationsExperiencesRoutes.post(
		path,
		WRITE,
		handler(async (c, scope) => {
			const body = await readBody(c, setupExperienceInputSchema)
			if ('error' in body) return body.error
			const db = await getTenantDb(scope.orgId)
			const experience = await createExperience(db, {
				...scope,
				input: body.data,
			})
			return json({ experience }, 201)
		}),
	)
}

operatorReservationsExperiencesRoutes.get(
	'/:id',
	READ,
	handler(async (c, scope) => {
		const db = await getTenantDb(scope.orgId)
		return json({
			experience: await getExperience(db, scope.locationId, idOf(c)),
		})
	}),
)

const updateHandler = handler(async (c, scope) => {
	const body = await readBody(c, setupExperienceUpdateSchema)
	if ('error' in body) return body.error
	const db = await getTenantDb(scope.orgId)
	const experience = await updateExperience(db, {
		...scope,
		experienceId: idOf(c),
		patch: body.data,
	})
	return json({ experience })
})
operatorReservationsExperiencesRoutes.patch('/:id', WRITE, updateHandler)
operatorReservationsExperiencesRoutes.put('/:id', WRITE, updateHandler)

const transitions = {
	publish: publishExperience,
	unpublish: unpublishExperience,
	archive: archiveExperience,
} as const

for (const [action, run] of Object.entries(transitions)) {
	operatorReservationsExperiencesRoutes.post(
		`/:id/${action}`,
		WRITE,
		handler(async (c, scope) => {
			const body = await readBody(c, experienceActionSchema, {
				optional: true,
			})
			if ('error' in body) return body.error
			const db = await getTenantDb(scope.orgId)
			const experience = await run(db, {
				...scope,
				experienceId: idOf(c),
				expectedVersion: body.data.expectedVersion,
			})
			return json({ experience })
		}),
	)
}

operatorReservationsExperiencesRoutes.post(
	'/:id/schedules',
	WRITE,
	handler(async (c, scope) => {
		const body = await readBody(c, setupExperienceScheduleInputSchema)
		if ('error' in body) return body.error
		const db = await getTenantDb(scope.orgId)
		const experience = await createExperienceSchedule(db, {
			...scope,
			experienceId: idOf(c),
			input: body.data,
		})
		return json({ experience }, 201)
	}),
)

const updateScheduleHandler = handler(async (c, scope) => {
	const body = await readBody(c, setupExperienceScheduleUpdateSchema)
	if ('error' in body) return body.error
	const db = await getTenantDb(scope.orgId)
	const experience = await updateExperienceSchedule(db, {
		...scope,
		experienceId: idOf(c),
		scheduleId: c.req.param('scheduleId') ?? '',
		patch: body.data,
	})
	return json({ experience })
})
operatorReservationsExperiencesRoutes.patch(
	'/:id/schedules/:scheduleId',
	WRITE,
	updateScheduleHandler,
)
operatorReservationsExperiencesRoutes.put(
	'/:id/schedules/:scheduleId',
	WRITE,
	updateScheduleHandler,
)

operatorReservationsExperiencesRoutes.delete(
	'/:id/schedules/:scheduleId',
	WRITE,
	handler(async (c, scope) => {
		const raw = c.req.query('expectedVersion')
		const expectedVersion = raw === undefined ? undefined : Number(raw)
		if (
			expectedVersion !== undefined &&
			(!Number.isInteger(expectedVersion) || expectedVersion < 1)
		) {
			return Response.json(
				{
					error: 'invalid',
					issues: [{ path: 'expectedVersion', code: 'invalid_type' }],
				},
				{ status: 400, headers: NO_STORE },
			)
		}
		const db = await getTenantDb(scope.orgId)
		const experience = await deleteExperienceSchedule(db, {
			...scope,
			experienceId: idOf(c),
			scheduleId: c.req.param('scheduleId') ?? '',
			expectedVersion,
		})
		return json({ experience })
	}),
)
