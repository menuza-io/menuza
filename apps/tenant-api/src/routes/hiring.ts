import { Hono } from 'hono'
import {
	hiringDeclineSchema,
	hiringHireSchema,
	hiringListQuerySchema,
	hiringNoteInputSchema,
	hiringStageMoveSchema,
	interviewCreateSchema,
	interviewUpdateSchema,
	STAFFING_PERMISSIONS as P,
} from '@repo/staffing'
import { staffError } from '../lib/staff-auth.ts'
import { staffGuard } from '../lib/staff-guard.ts'
import {
	json,
	OPAQUE_ID_PATTERN,
	readJsonBody,
	validationResponse,
} from '../lib/staff-http.ts'
import {
	addNote,
	createInterview,
	declineApplication,
	eraseApplication,
	getApplication,
	hireApplicant,
	listApplications,
	listHirePositions,
	moveStage,
	removeNote,
	updateInterview,
	type HiringResult,
} from '../services/hiring-service.ts'
import {
	certificateOperatorRoutes,
	onboardingOperatorRoutes,
} from './onboarding.ts'

/**
 * `/operator/hiring`: the applicant pipeline. Reached browser-direct with an
 * App-minted staffing token of scope `hiring` (the App refuses to mint one
 * unless `staffing.hiring` is on and the member holds a hiring grant).
 *
 * Reads need `read:hiring:any`; every change needs `update:hiring:any` and is
 * refused for impersonated sessions. Applicants are visible only inside the
 * token's scope limit. Every response is `Cache-Control: private, no-store`.
 */
export const hiringOperatorRoutes = new Hono()

// Onboarding checklists and certificates share the hiring scope and flag.
hiringOperatorRoutes.route('/onboarding', onboardingOperatorRoutes)
hiringOperatorRoutes.route('/certificates', certificateOperatorRoutes)

const READ = { all: [P.READ_HIRING] }
const WRITE = { all: [P.UPDATE_HIRING], write: true }

function respond<T>(result: HiringResult<T>, status: 200 | 201 = 200) {
	if (result.ok) return json(result.value, status)
	return result.message
		? staffError(result.status, result.error, { message: result.message })
		: staffError(result.status, result.error)
}

/** A malformed id is the same 404 as an unknown one. */
function idParam(
	c: { req: { param: (name: string) => string | undefined } },
	name: string,
) {
	const value = c.req.param(name) ?? ''
	return OPAQUE_ID_PATTERN.test(value) ? value : null
}

const notFound = () => staffError(404, 'Application not found')

hiringOperatorRoutes.get(
	'/applications',
	staffGuard('hiring', 'Hiring', READ, async (ctx, c) => {
		const parsed = hiringListQuerySchema.safeParse(c.req.query())
		if (!parsed.success) return validationResponse(parsed.error)
		return respond(await listApplications(ctx, parsed.data))
	}),
)

hiringOperatorRoutes.get(
	'/positions',
	staffGuard('hiring', 'Hiring', READ, async (ctx) =>
		json(await listHirePositions(ctx.db)),
	),
)

hiringOperatorRoutes.get(
	'/applications/:id',
	staffGuard('hiring', 'Hiring', READ, async (ctx, c) => {
		const id = idParam(c, 'id')
		if (!id) return notFound()
		return respond(await getApplication(ctx, id))
	}),
)

hiringOperatorRoutes.post(
	'/applications/:id/stage',
	staffGuard('hiring', 'Hiring', WRITE, async (ctx, c) => {
		const id = idParam(c, 'id')
		if (!id) return notFound()
		const body = await readJsonBody(c, hiringStageMoveSchema)
		if ('error' in body) return body.error
		return respond(await moveStage(ctx, id, body.data.stage))
	}),
)

hiringOperatorRoutes.post(
	'/applications/:id/notes',
	staffGuard('hiring', 'Hiring', WRITE, async (ctx, c) => {
		const id = idParam(c, 'id')
		if (!id) return notFound()
		const body = await readJsonBody(c, hiringNoteInputSchema)
		if ('error' in body) return body.error
		return respond(await addNote(ctx, id, body.data.body), 201)
	}),
)

hiringOperatorRoutes.delete(
	'/applications/:id/notes/:noteId',
	staffGuard('hiring', 'Hiring', WRITE, async (ctx, c) => {
		const id = idParam(c, 'id')
		const noteId = idParam(c, 'noteId')
		if (!id || !noteId) return notFound()
		return respond(await removeNote(ctx, id, noteId))
	}),
)

hiringOperatorRoutes.post(
	'/applications/:id/interviews',
	staffGuard('hiring', 'Hiring', WRITE, async (ctx, c) => {
		const id = idParam(c, 'id')
		if (!id) return notFound()
		const body = await readJsonBody(c, interviewCreateSchema)
		if ('error' in body) return body.error
		return respond(await createInterview(ctx, id, body.data), 201)
	}),
)

hiringOperatorRoutes.patch(
	'/applications/:id/interviews/:interviewId',
	staffGuard('hiring', 'Hiring', WRITE, async (ctx, c) => {
		const id = idParam(c, 'id')
		const interviewId = idParam(c, 'interviewId')
		if (!id || !interviewId) return notFound()
		const body = await readJsonBody(c, interviewUpdateSchema)
		if ('error' in body) return body.error
		return respond(await updateInterview(ctx, id, interviewId, body.data))
	}),
)

hiringOperatorRoutes.post(
	'/applications/:id/decline',
	staffGuard('hiring', 'Hiring', WRITE, async (ctx, c) => {
		const id = idParam(c, 'id')
		if (!id) return notFound()
		const body = await readJsonBody(c, hiringDeclineSchema)
		if ('error' in body) return body.error
		return respond(await declineApplication(ctx, id, body.data))
	}),
)

hiringOperatorRoutes.post(
	'/applications/:id/hire',
	staffGuard('hiring', 'Hiring', WRITE, async (ctx, c) => {
		const id = idParam(c, 'id')
		if (!id) return notFound()
		const body = await readJsonBody(c, hiringHireSchema)
		if ('error' in body) return body.error
		return respond(await hireApplicant(ctx, id, body.data), 201)
	}),
)

hiringOperatorRoutes.delete(
	'/applications/:id',
	staffGuard('hiring', 'Hiring', WRITE, async (ctx, c) => {
		const id = idParam(c, 'id')
		if (!id) return notFound()
		return respond(await eraseApplication(ctx, id))
	}),
)
