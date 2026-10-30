import { Hono, type Context } from 'hono'
import { type ZodTypeAny, z } from 'zod'
import {
	localDateSchema,
	STAFF_BULK_MAX_ROWS,
	staffAssignmentInputSchema,
	staffAssignmentUpdateSchema,
	staffBulkEnvelopeSchema,
	staffCreateSchema,
	staffImportRowSchema,
	staffJobCreateSchema,
	staffListQuerySchema,
	staffNoteInputSchema,
	staffPinSetSchema,
	staffPositionCreateSchema,
	staffPositionUpdateSchema,
	staffPrivateUpdateSchema,
	staffRateChangeSchema,
	staffRehireSchema,
	staffExportQuerySchema,
	staffTerminateSchema,
	staffUpdateSchema,
	staffingSettingsUpdateSchema,
	STAFFING_PERMISSIONS as P,
	type StaffBulkRowResult,
	type StaffingPermission,
} from '@repo/staffing'
import { getTenantDb } from '@repo/tenant-db'
import {
	authenticateStaffOperator,
	requireGrant,
	requireWriteGrant,
	scopeToScopes,
	staffError,
} from '../lib/staff-auth.ts'
import {
	addAssignment,
	addNote,
	changeRate,
	clearPin,
	createJob,
	createPosition,
	createStaff,
	getSettings,
	getStaffDetail,
	listAssignments,
	listAudit,
	listNotes,
	listPositions,
	listStaff,
	rehireStaff,
	removeAssignment,
	removeNote,
	serializeSettings,
	setPin,
	terminateStaff,
	updateAssignment,
	updatePosition,
	updatePrivate,
	updateSettings,
	updateStaff,
	type Result,
	type StaffContext,
} from '../services/staff-service.ts'
import { describeStaffError, hashClientIp } from '../services/staff-audit.ts'
import { exportForOperator } from '../services/staff-internal-service.ts'

/**
 * `/operator/staff`: roster, positions, assignments, effective-dated pay,
 * PINs, termination, notes and the audit log. Reached browser-direct with
 * App-minted staffing tokens (see `lib/staff-auth.ts`); staff, pay and private
 * data never transit the US control plane.
 *
 * Every handler: verifies the token and org, requires the route's grants (pay
 * and private fields are omitted, not hidden, without their grants), applies
 * the token's scope limit, writes an audit row inside the same transaction
 * as the change, and answers `Cache-Control: private, no-store`.
 */
export const staffOperatorRoutes = new Hono()

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function json(body: unknown, status: 200 | 201 = 200) {
	return Response.json(body, { status, headers: NO_STORE })
}

/** Zod messages for these codes would echo the rejected value back. */
const ECHOING_CODES = new Set(['invalid_value', 'invalid_union'])

function validationError(error: z.ZodError) {
	return staffError(400, 'Invalid request', {
		issues: error.issues.slice(0, 20).map((issue) => ({
			path: issue.path.join('.'),
			code: issue.code,
			...(ECHOING_CODES.has(issue.code) ? {} : { message: issue.message }),
		})),
	})
}

async function readBody<S extends ZodTypeAny>(
	c: Context,
	schema: S,
): Promise<{ data: z.infer<S> } | { error: Response }> {
	let raw: unknown
	try {
		raw = await c.req.json()
	} catch {
		return { error: staffError(400, 'Invalid JSON body') }
	}
	const parsed = schema.safeParse(raw)
	if (!parsed.success) return { error: validationError(parsed.error) }
	return { data: parsed.data }
}

function respond<T>(result: Result<T>, status: 200 | 201 = 200) {
	if (result.ok) return json(result.value, status)
	return staffError(result.status, result.error, { message: result.message })
}

type Requirement = {
	/** Every one of these grants is required (a stronger grant satisfies a read). */
	all: StaffingPermission[]
	/** Mutating routes also refuse impersonated sessions. */
	write?: boolean
}

type Handler = (ctx: StaffContext, c: Context) => Promise<Response>

function guarded(requirement: Requirement, handler: Handler) {
	return async (c: Context) => {
		const authed = await authenticateStaffOperator(c, 'staff')
		if ('error' in authed) return authed.error
		const { auth } = authed

		for (const permission of requirement.all) {
			const isWritePermission = permission.startsWith('update:')
			const denied =
				requirement.write && isWritePermission
					? requireWriteGrant(auth, permission)
					: requireGrant(auth, permission)
			if (denied) return denied
		}
		if (requirement.write && auth.impersonated) {
			return staffError(403, 'Impersonated sessions are read-only')
		}

		let db
		try {
			db = await getTenantDb(auth.orgId)
		} catch (error) {
			console.error(
				'Staff: tenant database unavailable',
				describeStaffError(error),
			)
			return staffError(500, 'Tenant Database unavailable')
		}

		const ctx: StaffContext = {
			db,
			auth,
			scope: scopeToScopes(auth),
			ipHash: hashClientIp(c),
		}
		try {
			return await handler(ctx, c)
		} catch (error) {
			// Never log the raw error: Drizzle quotes SQL parameters (names, wages)
			// in its message.
			console.error(
				`Staff route failed (${c.req.method} ${c.req.routePath})`,
				describeStaffError(error),
			)
			return staffError(500, 'Internal Server Error')
		}
	}
}

/** Path parameters are always present on the routes that read them. */
function param(c: Context, name: string): string {
	return c.req.param(name) ?? ''
}

const READ_STAFF = [P.READ_STAFF]
const WRITE_STAFF = { all: [P.UPDATE_STAFF], write: true }

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

staffOperatorRoutes.get(
	'/',
	guarded({ all: READ_STAFF }, async (ctx, c) => {
		const parsed = staffListQuerySchema.safeParse(c.req.query())
		if (!parsed.success) return validationError(parsed.error)
		return json(await listStaff(ctx, parsed.data))
	}),
)

staffOperatorRoutes.post(
	'/',
	guarded(WRITE_STAFF, async (ctx, c) => {
		const body = await readBody(c, staffCreateSchema)
		if ('error' in body) return body.error
		return respond(await createStaff(ctx, body.data, { source: 'manual' }), 201)
	}),
)

type BulkMode = 'import' | 'bulk'

async function runBulk(ctx: StaffContext, c: Context, mode: BulkMode) {
	// Linking a login is a trust decision about identity, so it is limited to
	// tokens that are not scope-limited.
	if (mode === 'import' && !ctx.scope.unrestricted) {
		return staffError(403, 'unrestricted_scope_required')
	}
	const envelope = await readBody(c, staffBulkEnvelopeSchema)
	if ('error' in envelope) return envelope.error

	const results: StaffBulkRowResult[] = []
	for (const [index, raw] of envelope.data.members.entries()) {
		const parsed = staffImportRowSchema.safeParse(raw)
		if (!parsed.success) {
			results.push({
				index,
				status: 'invalid',
				error: parsed.error.issues
					.slice(0, 3)
					.map((issue) => `${issue.path.join('.') || 'row'}: ${issue.code}`)
					.join('; '),
			})
			continue
		}
		const { userId, ...row } = parsed.data
		if (mode === 'import' && !userId) {
			results.push({ index, status: 'invalid', error: 'userId: required' })
			continue
		}
		if (userId && mode === 'bulk') {
			// Linking a login is `/import` only, so a CSV upload can never attach a
			// staff row to someone's account.
			results.push({ index, status: 'invalid', error: 'userId: use_import' })
			continue
		}
		if (userId && !ctx.scope.unrestricted) {
			results.push({
				index,
				status: 'invalid',
				error: 'userId: unrestricted_scope_required',
			})
			continue
		}
		const outcome = await createStaff(ctx, row, {
			userId,
			source: mode,
		})
		if (outcome.ok) {
			results.push({
				index,
				status: outcome.value.created ? 'created' : 'existing',
				staffId: outcome.value.staff.id,
			})
		} else {
			results.push({
				index,
				status: outcome.status === 409 ? 'conflict' : 'invalid',
				error: outcome.error,
			})
		}
	}
	const summary = { created: 0, existing: 0, invalid: 0, conflict: 0 }
	for (const result of results) summary[result.status] += 1
	return json({ results, summary, maxRows: STAFF_BULK_MAX_ROWS })
}

staffOperatorRoutes.post(
	'/import',
	guarded(WRITE_STAFF, (ctx, c) => runBulk(ctx, c, 'import')),
)
staffOperatorRoutes.post(
	'/bulk',
	guarded(WRITE_STAFF, (ctx, c) => runBulk(ctx, c, 'bulk')),
)

// ---------------------------------------------------------------------------
// Positions (declared before `/:id` so the static segment wins)
// ---------------------------------------------------------------------------

staffOperatorRoutes.get(
	'/positions',
	guarded({ all: READ_STAFF }, async (ctx, c) => {
		return json(
			await listPositions(ctx, {
				includeArchived: c.req.query('includeArchived') === '1',
			}),
		)
	}),
)

staffOperatorRoutes.post(
	'/positions',
	guarded(WRITE_STAFF, async (ctx, c) => {
		const body = await readBody(c, staffPositionCreateSchema)
		if ('error' in body) return body.error
		return respond(await createPosition(ctx, body.data), 201)
	}),
)

staffOperatorRoutes.patch(
	'/positions/:positionId',
	guarded(WRITE_STAFF, async (ctx, c) => {
		const body = await readBody(c, staffPositionUpdateSchema)
		if ('error' in body) return body.error
		return respond(await updatePosition(ctx, param(c, 'positionId'), body.data))
	}),
)

// Positions are archived, never deleted, so history keeps resolving them.
staffOperatorRoutes.delete(
	'/positions/:positionId',
	guarded(WRITE_STAFF, async (ctx, c) =>
		respond(
			await updatePosition(ctx, param(c, 'positionId'), { archived: true }),
		),
	),
)

// ---------------------------------------------------------------------------
// Settings and audit log
// ---------------------------------------------------------------------------

staffOperatorRoutes.get(
	'/settings',
	guarded({ all: READ_STAFF }, async (ctx) =>
		json({ settings: serializeSettings(await getSettings(ctx.db)) }),
	),
)

staffOperatorRoutes.put(
	'/settings',
	guarded(WRITE_STAFF, async (ctx, c) => {
		const body = await readBody(c, staffingSettingsUpdateSchema)
		if ('error' in body) return body.error
		return respond(await updateSettings(ctx, body.data))
	}),
)

const auditQuerySchema = z.object({
	staffId: z.string().min(1).max(64).optional(),
	action: z.string().min(1).max(80).optional(),
	before: z.coerce.number().int().positive().optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
})

staffOperatorRoutes.get(
	'/audit',
	guarded({ all: READ_STAFF }, async (ctx, c) => {
		const parsed = auditQuerySchema.safeParse(c.req.query())
		if (!parsed.success) return validationError(parsed.error)
		return json(await listAudit(ctx, parsed.data))
	}),
)

// A complete file of what this region holds about staff: the browser-side
// backup offered before a region switch, and the in-region copy for an access
// request. Declared before `/:id` so the static segment wins.
staffOperatorRoutes.get(
	'/export',
	guarded({ all: READ_STAFF }, async (ctx, c) => {
		const parsed = staffExportQuerySchema.safeParse(c.req.query())
		if (!parsed.success) return validationError(parsed.error)
		const result = await exportForOperator(ctx, parsed.data)
		if (!result.ok) {
			return staffError(result.status, result.error, {
				message: result.message,
			})
		}
		return json(result.value)
	}),
)

// ---------------------------------------------------------------------------
// One staff member
// ---------------------------------------------------------------------------

staffOperatorRoutes.get(
	'/:id',
	guarded({ all: READ_STAFF }, async (ctx, c) => {
		const include = (c.req.query('include') ?? '').split(',')
		return respond(
			await getStaffDetail(ctx, param(c, 'id'), {
				pay: include.includes('pay'),
				private: include.includes('private'),
			}),
		)
	}),
)

staffOperatorRoutes.patch(
	'/:id',
	guarded(WRITE_STAFF, async (ctx, c) => {
		const body = await readBody(c, staffUpdateSchema)
		if ('error' in body) return body.error
		return respond(await updateStaff(ctx, param(c, 'id'), body.data))
	}),
)

staffOperatorRoutes.get(
	'/:id/private',
	guarded({ all: [P.READ_STAFF, P.READ_STAFF_PRIVATE] }, async (ctx, c) => {
		const detail = await getStaffDetail(ctx, param(c, 'id'), {
			pay: false,
			private: true,
		})
		if (!detail.ok) return respond(detail)
		return json({ private: detail.value.private })
	}),
)

staffOperatorRoutes.put(
	'/:id/private',
	guarded(
		{ all: [P.READ_STAFF, P.UPDATE_STAFF_PRIVATE], write: true },
		async (ctx, c) => {
			const body = await readBody(c, staffPrivateUpdateSchema)
			if ('error' in body) return body.error
			return respond(await updatePrivate(ctx, param(c, 'id'), body.data))
		},
	),
)

staffOperatorRoutes.get(
	'/:id/jobs',
	guarded({ all: [P.READ_STAFF, P.READ_STAFF_PAY] }, async (ctx, c) => {
		const detail = await getStaffDetail(ctx, param(c, 'id'), {
			pay: true,
			private: false,
		})
		if (!detail.ok) return respond(detail)
		return json({ jobs: detail.value.jobs })
	}),
)

staffOperatorRoutes.post(
	'/:id/jobs',
	guarded(WRITE_STAFF, async (ctx, c) => {
		const body = await readBody(c, staffJobCreateSchema)
		if ('error' in body) return body.error
		return respond(await createJob(ctx, param(c, 'id'), body.data), 201)
	}),
)

staffOperatorRoutes.post(
	'/:id/jobs/:jobId/rate-change',
	guarded(
		{ all: [P.READ_STAFF, P.UPDATE_STAFF_PAY], write: true },
		async (ctx, c) => {
			const body = await readBody(c, staffRateChangeSchema)
			if ('error' in body) return body.error
			return respond(
				await changeRate(ctx, param(c, 'id'), param(c, 'jobId'), body.data),
				201,
			)
		},
	),
)

// ---------------------------------------------------------------------------
// Assignments and PINs
// ---------------------------------------------------------------------------

staffOperatorRoutes.get(
	'/:id/assignments',
	guarded({ all: READ_STAFF }, async (ctx, c) =>
		respond(await listAssignments(ctx, param(c, 'id'))),
	),
)

staffOperatorRoutes.post(
	'/:id/assignments',
	guarded(WRITE_STAFF, async (ctx, c) => {
		const body = await readBody(c, staffAssignmentInputSchema)
		if ('error' in body) return body.error
		return respond(await addAssignment(ctx, param(c, 'id'), body.data), 201)
	}),
)

staffOperatorRoutes.patch(
	'/:id/assignments/:assignmentId',
	guarded(WRITE_STAFF, async (ctx, c) => {
		const body = await readBody(c, staffAssignmentUpdateSchema)
		if ('error' in body) return body.error
		return respond(
			await updateAssignment(
				ctx,
				param(c, 'id'),
				param(c, 'assignmentId'),
				body.data,
			),
		)
	}),
)

staffOperatorRoutes.delete(
	'/:id/assignments/:assignmentId',
	guarded(WRITE_STAFF, async (ctx, c) => {
		const date = c.req.query('effectiveDate')
		if (date !== undefined && !localDateSchema.safeParse(date).success) {
			return staffError(400, 'Invalid request', {
				issues: [{ path: 'effectiveDate', code: 'invalid_format' }],
			})
		}
		return respond(
			await removeAssignment(
				ctx,
				param(c, 'id'),
				param(c, 'assignmentId'),
				date,
			),
		)
	}),
)

/**
 * Generates (or sets, when the manager supplies one) a PIN for one scope.
 * The PIN is returned in this response only. Only an HMAC lookup is stored,
 * so no later read can return it.
 */
staffOperatorRoutes.post(
	'/:id/assignments/:assignmentId/pin',
	guarded(WRITE_STAFF, async (ctx, c) => {
		const body = await readBody(c, staffPinSetSchema)
		if ('error' in body) return body.error
		return respond(
			await setPin(
				ctx,
				param(c, 'id'),
				param(c, 'assignmentId'),
				body.data.pin,
			),
			201,
		)
	}),
)

staffOperatorRoutes.delete(
	'/:id/assignments/:assignmentId/pin',
	guarded(WRITE_STAFF, async (ctx, c) =>
		respond(await clearPin(ctx, param(c, 'id'), param(c, 'assignmentId'))),
	),
)

// ---------------------------------------------------------------------------
// Termination, notes
// ---------------------------------------------------------------------------

staffOperatorRoutes.post(
	'/:id/terminate',
	guarded(WRITE_STAFF, async (ctx, c) => {
		const body = await readBody(c, staffTerminateSchema)
		if ('error' in body) return body.error
		return respond(await terminateStaff(ctx, param(c, 'id'), body.data))
	}),
)

staffOperatorRoutes.post(
	'/:id/rehire',
	guarded(WRITE_STAFF, async (ctx, c) => {
		const body = await readBody(c, staffRehireSchema)
		if ('error' in body) return body.error
		return respond(await rehireStaff(ctx, param(c, 'id'), body.data))
	}),
)

staffOperatorRoutes.get(
	'/:id/notes',
	guarded({ all: READ_STAFF }, async (ctx, c) =>
		respond(await listNotes(ctx, param(c, 'id'))),
	),
)

staffOperatorRoutes.post(
	'/:id/notes',
	guarded(WRITE_STAFF, async (ctx, c) => {
		const body = await readBody(c, staffNoteInputSchema)
		if ('error' in body) return body.error
		return respond(await addNote(ctx, param(c, 'id'), body.data.body), 201)
	}),
)

staffOperatorRoutes.delete(
	'/:id/notes/:noteId',
	guarded(WRITE_STAFF, async (ctx, c) =>
		respond(await removeNote(ctx, param(c, 'id'), param(c, 'noteId'))),
	),
)
