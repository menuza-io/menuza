import { Hono } from 'hono'
import {
	certificateInputSchema,
	certificateUpdateSchema,
	onboardingApplySchema,
	onboardingSummaryQuerySchema,
	onboardingTaskCreateSchema,
	onboardingTaskUpdateSchema,
	onboardingTemplateInputSchema,
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
	addCertificate,
	addTask,
	applyChecklist,
	archiveTemplate,
	createTemplate,
	getChecklist,
	listCertificates,
	listTemplates,
	removeCertificate,
	removeTask,
	summarizeChecklists,
	updateCertificate,
	updateTask,
	updateTemplate,
	type OnboardingResult,
} from '../services/onboarding-service.ts'

/**
 * Onboarding checklists, templates and certificates, mounted under
 * `/operator/hiring` so they share the hiring token scope: the App mints a
 * `hiring` token only while `staffing.hiring` is on and the member holds a
 * hiring grant. Reads need `read:hiring:any`, changes `update:hiring:any`
 * (refused for impersonated sessions). A person outside the token's scope
 * scope is a 404. Every response is `Cache-Control: private, no-store`.
 */
export const onboardingOperatorRoutes = new Hono()

const READ = { all: [P.READ_HIRING] }
const WRITE = { all: [P.UPDATE_HIRING], write: true }
const LABEL = 'Onboarding'

function respond<T>(result: OnboardingResult<T>, status: 200 | 201 = 200) {
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

const notFound = () => staffError(404, 'Not found')

// Templates --------------------------------------------------------------

onboardingOperatorRoutes.get(
	'/templates',
	staffGuard('hiring', LABEL, READ, async (ctx) =>
		respond(await listTemplates(ctx)),
	),
)

onboardingOperatorRoutes.post(
	'/templates',
	staffGuard('hiring', LABEL, WRITE, async (ctx, c) => {
		const body = await readJsonBody(c, onboardingTemplateInputSchema)
		if ('error' in body) return body.error
		return respond(await createTemplate(ctx, body.data), 201)
	}),
)

onboardingOperatorRoutes.put(
	'/templates/:id',
	staffGuard('hiring', LABEL, WRITE, async (ctx, c) => {
		const id = idParam(c, 'id')
		if (!id) return notFound()
		const body = await readJsonBody(c, onboardingTemplateInputSchema)
		if ('error' in body) return body.error
		return respond(await updateTemplate(ctx, id, body.data))
	}),
)

onboardingOperatorRoutes.delete(
	'/templates/:id',
	staffGuard('hiring', LABEL, WRITE, async (ctx, c) => {
		const id = idParam(c, 'id')
		if (!id) return notFound()
		return respond(await archiveTemplate(ctx, id))
	}),
)

// Roster progress ----------------------------------------------------------

onboardingOperatorRoutes.get(
	'/summary',
	staffGuard('hiring', LABEL, READ, async (ctx, c) => {
		const parsed = onboardingSummaryQuerySchema.safeParse(c.req.query())
		if (!parsed.success) return validationResponse(parsed.error)
		return respond(await summarizeChecklists(ctx, parsed.data.staffIds))
	}),
)

// One person's checklist -----------------------------------------------------

onboardingOperatorRoutes.get(
	'/staff/:staffId/tasks',
	staffGuard('hiring', LABEL, READ, async (ctx, c) => {
		const staffId = idParam(c, 'staffId')
		if (!staffId) return notFound()
		return respond(await getChecklist(ctx, staffId))
	}),
)

onboardingOperatorRoutes.post(
	'/staff/:staffId/tasks',
	staffGuard('hiring', LABEL, WRITE, async (ctx, c) => {
		const staffId = idParam(c, 'staffId')
		if (!staffId) return notFound()
		const body = await readJsonBody(c, onboardingTaskCreateSchema)
		if ('error' in body) return body.error
		return respond(await addTask(ctx, staffId, body.data), 201)
	}),
)

onboardingOperatorRoutes.post(
	'/staff/:staffId/apply',
	staffGuard('hiring', LABEL, WRITE, async (ctx, c) => {
		const staffId = idParam(c, 'staffId')
		if (!staffId) return notFound()
		const body = await readJsonBody(c, onboardingApplySchema)
		if ('error' in body) return body.error
		return respond(await applyChecklist(ctx, staffId, body.data), 201)
	}),
)

onboardingOperatorRoutes.patch(
	'/staff/:staffId/tasks/:taskId',
	staffGuard('hiring', LABEL, WRITE, async (ctx, c) => {
		const staffId = idParam(c, 'staffId')
		const taskId = idParam(c, 'taskId')
		if (!staffId || !taskId) return notFound()
		const body = await readJsonBody(c, onboardingTaskUpdateSchema)
		if ('error' in body) return body.error
		return respond(await updateTask(ctx, staffId, taskId, body.data))
	}),
)

onboardingOperatorRoutes.delete(
	'/staff/:staffId/tasks/:taskId',
	staffGuard('hiring', LABEL, WRITE, async (ctx, c) => {
		const staffId = idParam(c, 'staffId')
		const taskId = idParam(c, 'taskId')
		if (!staffId || !taskId) return notFound()
		return respond(await removeTask(ctx, staffId, taskId))
	}),
)

// Certificates ---------------------------------------------------------------

export const certificateOperatorRoutes = new Hono()

certificateOperatorRoutes.get(
	'/staff/:staffId',
	staffGuard('hiring', 'Certificates', READ, async (ctx, c) => {
		const staffId = idParam(c, 'staffId')
		if (!staffId) return notFound()
		return respond(await listCertificates(ctx, staffId))
	}),
)

certificateOperatorRoutes.post(
	'/staff/:staffId',
	staffGuard('hiring', 'Certificates', WRITE, async (ctx, c) => {
		const staffId = idParam(c, 'staffId')
		if (!staffId) return notFound()
		const body = await readJsonBody(c, certificateInputSchema)
		if ('error' in body) return body.error
		return respond(await addCertificate(ctx, staffId, body.data), 201)
	}),
)

certificateOperatorRoutes.patch(
	'/staff/:staffId/:certificateId',
	staffGuard('hiring', 'Certificates', WRITE, async (ctx, c) => {
		const staffId = idParam(c, 'staffId')
		const certificateId = idParam(c, 'certificateId')
		if (!staffId || !certificateId) return notFound()
		const body = await readJsonBody(c, certificateUpdateSchema)
		if ('error' in body) return body.error
		return respond(
			await updateCertificate(ctx, staffId, certificateId, body.data),
		)
	}),
)

certificateOperatorRoutes.delete(
	'/staff/:staffId/:certificateId',
	staffGuard('hiring', 'Certificates', WRITE, async (ctx, c) => {
		const staffId = idParam(c, 'staffId')
		const certificateId = idParam(c, 'certificateId')
		if (!staffId || !certificateId) return notFound()
		return respond(await removeCertificate(ctx, staffId, certificateId))
	}),
)
