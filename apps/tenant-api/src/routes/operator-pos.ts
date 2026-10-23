import { and, eq, isNull } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { getTenantDb, posDevices } from '@repo/tenant-db'
import {
	isPosEnabled,
	isPosHashUnavailable,
	posDisabledResponse,
	posError,
	posUnavailableResponse,
} from '../lib/pos-auth.ts'
import {
	countHeldUploads,
	createPairingCode,
	fiscalChainGaps,
	listDevices,
	listHeldUploads,
	listOrderRevisions,
	resolveHeldUpload,
	listPendingCodes,
	listPosOrders,
	isUnknownLocation,
	listStaffRoster,
	removeHost,
	removeManager,
	revokeDevice,
	revokePendingCode,
	setHost,
	setManager,
	updateDeviceSettings,
} from '../services/pos-service.ts'
import { getStaffingFeatures } from '../lib/scope-context.ts'
import {
	dayReport,
	listShifts,
	shiftReport,
} from '../services/pos-shift-service.ts'
import {
	listZatcaSubmissions,
	onboardUnit,
	reportDueZatca,
	saveZatcaSettings,
	zatcaOverview,
	zatcaSettingsSchema,
} from '../services/zatca-service.ts'
import {
	assertOperatorOrg,
	authenticateOrdersOperator,
} from './operator-orders.ts'

/**
 * Operator management of POS terminals. Same operator JWT as `/operator/orders`
 * (`orders:read` to look, `orders:write` to pair or remove), minted by App after
 * its menu authorization. Responses are always `private, no-store`.
 */
export const operatorPosRoutes = new Hono()

const noStore = { 'Cache-Control': 'private, no-store' }

/**
 * `keepWorkingWhenDisabled` is for looking and for removing: like kiosks, a
 * manager must always be able to revoke a terminal, above all when the switch
 * was flipped because one was lost. Creating codes stays off.
 */
async function guard(
	c: Context,
	scope: 'orders:read' | 'orders:write',
	options: { keepWorkingWhenDisabled?: boolean } = {},
) {
	if (!isPosEnabled() && !options.keepWorkingWhenDisabled)
		return { error: posDisabledResponse() }
	const auth = await authenticateOrdersOperator(c, scope)
	if ('error' in auth) return { error: auth.error }
	const denied = await assertOperatorOrg(auth.auth.orgId)
	if (denied) return { error: denied.error }
	return { auth: auth.auth, db: await getTenantDb(auth.auth.orgId) }
}

const createCodeSchema = z.strictObject({
	label: z.string().trim().min(1).max(60),
	terminalCode: z.string().trim().min(1).max(6),
	locationId: z.string().trim().min(1).max(100).nullable().optional(),
	scopeId: z.string().trim().min(1).max(64).optional(),
	signInRequired: z.boolean().optional(),
	dayStartMinutes: z.number().int().min(0).max(720).optional(),
	shiftsRequired: z.boolean().optional(),
	timeclockEnabled: z.boolean().optional(),
	reservationsEnabled: z.boolean().optional(),
})

operatorPosRoutes.get('/terminals', async (c) => {
	const g = await guard(c, 'orders:read', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	const [devices, pendingCodes, heldUploads] = await Promise.all([
		listDevices(g.db),
		listPendingCodes(g.db),
		countHeldUploads(g.db),
	])
	return c.json({ devices, pendingCodes, heldUploads }, 200, noStore)
})

operatorPosRoutes.post('/pairing-codes', async (c) => {
	const g = await guard(c, 'orders:write')
	if ('error' in g) return g.error
	const parsed = createCodeSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) return posError(400, 'invalid_request')
	const denied = await stationAppsDenied(g.auth, parsed.data)
	if (denied) return denied
	let result: Awaited<ReturnType<typeof createPairingCode>>
	try {
		result = await createPairingCode(g.db, g.auth.orgId, {
			label: parsed.data.label,
			terminalCode: parsed.data.terminalCode,
			locationId: parsed.data.locationId ?? null,
			scopeId: parsed.data.scopeId,
			signInRequired: parsed.data.signInRequired,
			dayStartMinutes: parsed.data.dayStartMinutes,
			shiftsRequired: parsed.data.shiftsRequired,
			timeclockEnabled: parsed.data.timeclockEnabled,
			reservationsEnabled: parsed.data.reservationsEnabled,
			createdBy: g.auth.userId,
		})
	} catch (error) {
		if (isPosHashUnavailable(error)) return posUnavailableResponse()
		throw error
	}
	if (!result.ok) {
		return posError(
			result.status,
			result.error,
			result.message ? { message: result.message } : {},
		)
	}
	// The code is shown once: only its hash is stored.
	return c.json(result.value, 201, noStore)
})

operatorPosRoutes.delete('/pairing-codes/:id', async (c) => {
	const g = await guard(c, 'orders:write', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	if (!(await revokePendingCode(g.db, c.req.param('id'))))
		return posError(404, 'not_found')
	return c.json({ ok: true }, 200, noStore)
})

operatorPosRoutes.delete('/terminals/:id', async (c) => {
	const g = await guard(c, 'orders:write', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	if (!(await revokeDevice(g.db, c.req.param('id'), g.auth.userId))) {
		return posError(404, 'not_found')
	}
	return c.json({ ok: true }, 200, noStore)
})

const listQuery = z.object({
	limit: z.coerce.number().int().min(1).max(200).optional(),
	status: z.enum(['open', 'paid', 'void', 'refunded']).optional(),
	review: z.enum(['1', 'true']).optional(),
	businessDate: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
})

operatorPosRoutes.get('/orders', async (c) => {
	const g = await guard(c, 'orders:read', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	const parsed = listQuery.safeParse(c.req.query())
	if (!parsed.success) return posError(400, 'invalid_request')
	const orders = await listPosOrders(g.db, {
		limit: parsed.data.limit ?? 100,
		status: parsed.data.status,
		needsReview: parsed.data.review !== undefined,
		businessDate: parsed.data.businessDate,
	})
	return c.json({ orders }, 200, noStore)
})

/** Every revision the server accepted for one order: what was on it, and when. */
operatorPosRoutes.get('/orders/:id/revisions', async (c) => {
	const g = await guard(c, 'orders:read', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	const id = z.string().uuid().safeParse(c.req.param('id'))
	if (!id.success) return posError(400, 'invalid_request')
	return c.json(
		{ revisions: await listOrderRevisions(g.db, id.data) },
		200,
		noStore,
	)
})

// ---------------------------------------------------------------------------
// Held uploads: what a till sent that the server could not apply
// ---------------------------------------------------------------------------

operatorPosRoutes.get('/held', async (c) => {
	const g = await guard(c, 'orders:read', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	const includeResolved = c.req.query('all') === '1'
	return c.json(
		{ held: await listHeldUploads(g.db, { limit: 100, includeResolved }) },
		200,
		noStore,
	)
})

operatorPosRoutes.post('/held/:id/resolve', async (c) => {
	const g = await guard(c, 'orders:write', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	if (!(await resolveHeldUpload(g.db, c.req.param('id'), g.auth.userId)))
		return posError(404, 'not_found')
	return c.json({ ok: true }, 200, noStore)
})

// ---------------------------------------------------------------------------
// Staff sign-in settings
// ---------------------------------------------------------------------------

/**
 * Switching a Station app on needs that module's settings permission, which App
 * signs into the token (`stationApps`); switching one off never does. The time
 * clock also needs the organization's staffing flag when this node can read it.
 */
async function stationAppsDenied(
	auth: {
		orgId: string
		stationApps: { timeclock: boolean; reservations: boolean }
	},
	patch: { timeclockEnabled?: boolean; reservationsEnabled?: boolean },
): Promise<Response | null> {
	if (patch.timeclockEnabled === true) {
		if (!auth.stationApps.timeclock)
			return posError(403, 'timeclock_permission_required')
		const flags = await getStaffingFeatures(auth.orgId).catch(() => null)
		if (flags && (!flags.features.enabled || !flags.features.timeclock))
			return posError(422, 'timeclock_disabled')
	}
	if (patch.reservationsEnabled === true && !auth.stationApps.reservations)
		return posError(403, 'reservations_permission_required')
	return null
}

const patchTerminalSchema = z
	.strictObject({
		signInRequired: z.boolean().optional(),
		dayStartMinutes: z.number().int().min(0).max(720).optional(),
		shiftsRequired: z.boolean().optional(),
		timeclockEnabled: z.boolean().optional(),
		reservationsEnabled: z.boolean().optional(),
		locationId: z.string().trim().min(1).max(100).optional(),
	})
	.refine((p) => Object.values(p).some((value) => value !== undefined))

operatorPosRoutes.patch('/terminals/:id', async (c) => {
	const g = await guard(c, 'orders:write')
	if ('error' in g) return g.error
	const parsed = patchTerminalSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) return posError(400, 'invalid_request')
	const denied = await stationAppsDenied(g.auth, parsed.data)
	if (denied) return denied
	if (
		parsed.data.locationId !== undefined &&
		(await isUnknownLocation(g.auth.orgId, parsed.data.locationId))
	)
		return posError(422, 'invalid_location')
	const result = await updateDeviceSettings(
		g.db,
		c.req.param('id'),
		parsed.data,
	)
	if (!result.ok) {
		return posError(
			result.status,
			result.error,
			result.message ? { message: result.message } : {},
		)
	}
	return c.json({ ok: true }, 200, noStore)
})

/** The people who can sign in at a workplace, whether each has a PIN, and who may manage a till. */
operatorPosRoutes.get('/staff', async (c) => {
	const g = await guard(c, 'orders:read', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	const scopeId = z
		.string()
		.regex(/^[A-Za-z0-9_-]{1,64}$/)
		.safeParse(c.req.query('scopeId') ?? 'main')
	if (!scopeId.success) return posError(400, 'invalid_request')
	return c.json(
		{ staff: await listStaffRoster(g.db, scopeId.data) },
		200,
		noStore,
	)
})

operatorPosRoutes.put('/managers/:staffId', async (c) => {
	const g = await guard(c, 'orders:write')
	if ('error' in g) return g.error
	if (!(await setManager(g.db, c.req.param('staffId'), g.auth.userId)))
		return posError(404, 'not_found')
	return c.json({ ok: true }, 200, noStore)
})

// The host roster: who may run the host stand at a till. Reservations settings,
// not the menu permission, decide it (App signs `stationApps.reservations`).
const hostSchema = z.strictObject({ guestDetails: z.boolean().optional() })

operatorPosRoutes.put('/hosts/:staffId', async (c) => {
	const g = await guard(c, 'orders:write')
	if ('error' in g) return g.error
	if (!g.auth.stationApps.reservations)
		return posError(403, 'reservations_permission_required')
	const parsed = hostSchema.safeParse(await c.req.json().catch(() => ({})))
	if (!parsed.success) return posError(400, 'invalid_request')
	if (
		!(await setHost(g.db, c.req.param('staffId'), g.auth.userId, {
			guestDetails: parsed.data.guestDetails ?? false,
		}))
	)
		return posError(404, 'not_found')
	return c.json({ ok: true }, 200, noStore)
})

operatorPosRoutes.delete('/hosts/:staffId', async (c) => {
	// Taking someone off is always allowed to whoever manages terminals.
	const g = await guard(c, 'orders:write', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	if (!(await removeHost(g.db, c.req.param('staffId'))))
		return posError(404, 'not_found')
	return c.json({ ok: true }, 200, noStore)
})

operatorPosRoutes.delete('/managers/:staffId', async (c) => {
	const g = await guard(c, 'orders:write')
	if ('error' in g) return g.error
	if (!(await removeManager(g.db, c.req.param('staffId'))))
		return posError(404, 'not_found')
	return c.json({ ok: true }, 200, noStore)
})

// ---------------------------------------------------------------------------
// Shifts and reports
// ---------------------------------------------------------------------------

const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** Recent cash drawer shifts with their Z reports (optionally one business day). */
operatorPosRoutes.get('/shifts', async (c) => {
	const g = await guard(c, 'orders:read', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	const day = businessDate.optional().safeParse(c.req.query('businessDate'))
	if (!day.success) return posError(400, 'invalid_request')
	return c.json(
		{ shifts: await listShifts(g.db, { limit: 50, businessDate: day.data }) },
		200,
		noStore,
	)
})

operatorPosRoutes.get('/shifts/:id', async (c) => {
	const g = await guard(c, 'orders:read', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	const report = await shiftReport(g.db, c.req.param('id'))
	if (!report) return posError(404, 'not_found')
	return c.json(report, 200, noStore)
})

/** Everything sold on one business day, across terminals, with that day's shifts. */
operatorPosRoutes.get('/reports/day', async (c) => {
	const g = await guard(c, 'orders:read', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	const day = businessDate.safeParse(c.req.query('businessDate'))
	const location = z
		.string()
		.min(1)
		.max(100)
		.optional()
		.safeParse(c.req.query('locationId'))
	if (!day.success || !location.success) return posError(400, 'invalid_request')
	return c.json(await dayReport(g.db, day.data, location.data), 200, noStore)
})

// ---------------------------------------------------------------------------
// ZATCA e-invoicing (Phase 2)
// ---------------------------------------------------------------------------

operatorPosRoutes.get('/zatca', async (c) => {
	const g = await guard(c, 'orders:read', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	return c.json(await zatcaOverview(g.db), 200, noStore)
})

operatorPosRoutes.put('/zatca/settings', async (c) => {
	const g = await guard(c, 'orders:write', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	const parsed = zatcaSettingsSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) {
		return posError(400, 'invalid_request', {
			message: parsed.error.issues[0]?.message ?? 'Invalid settings',
		})
	}
	return c.json(
		{ settings: await saveZatcaSettings(g.db, parsed.data, g.auth.userId) },
		200,
		noStore,
	)
})

const onboardSchema = z.strictObject({
	otp: z.string().regex(/^\d{6}$/, 'The one-time password has 6 digits'),
})

/** Onboards a terminal as an EGS unit with a one-time password from the Fatoora portal. */
operatorPosRoutes.post('/zatca/units/:deviceId/onboard', async (c) => {
	const g = await guard(c, 'orders:write')
	if ('error' in g) return g.error
	const parsed = onboardSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success)
		return posError(400, 'invalid_request', {
			message: parsed.error.issues[0]?.message ?? 'Invalid request',
		})
	const [device] = await g.db
		.select({ id: posDevices.id, terminalCode: posDevices.terminalCode })
		.from(posDevices)
		.where(
			and(
				eq(posDevices.id, c.req.param('deviceId')),
				isNull(posDevices.revokedAt),
			),
		)
		.limit(1)
	if (!device) return posError(404, 'not_found')
	const result = await onboardUnit(g.db, device, parsed.data.otp)
	if (!result.ok)
		return posError(422, 'onboarding_failed', {
			step: result.step,
			message: result.error,
		})
	return c.json({ ok: true }, 200, noStore)
})

operatorPosRoutes.get('/zatca/submissions', async (c) => {
	const g = await guard(c, 'orders:read', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	const status = z
		.enum(['pending', 'reported', 'warning', 'rejected'])
		.optional()
		.safeParse(c.req.query('status'))
	if (!status.success) return posError(400, 'invalid_request')
	return c.json(
		{
			submissions: await listZatcaSubmissions(g.db, {
				status: status.data,
				limit: 100,
			}),
		},
		200,
		noStore,
	)
})

/** Reports what is due now instead of waiting for the next tick. */
operatorPosRoutes.post('/zatca/report', async (c) => {
	const g = await guard(c, 'orders:write', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	return c.json(await reportDueZatca(g.db, { limit: 50 }), 200, noStore)
})

/** Fiscal documents a till numbered that the server has not received after a day. */
operatorPosRoutes.get('/fiscal/gaps', async (c) => {
	const g = await guard(c, 'orders:read', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	return c.json({ gaps: await fiscalChainGaps(g.db) }, 200, noStore)
})
