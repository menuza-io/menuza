import { Hono, type Context } from 'hono'
import {
	kioskDeviceUpdateSchema,
	kioskPairingCodeCreateSchema,
	laborPolicyPatchSchema,
	STAFFING_PERMISSIONS as P,
} from '@repo/staffing'
import { isKioskEnabled, kioskDisabledResponse } from '../lib/kiosk-auth.ts'
import { staffGuard, type StaffRequirement } from '../lib/staff-guard.ts'
import { staffError } from '../lib/staff-auth.ts'
import { json, OPAQUE_ID_PATTERN, readJsonBody } from '../lib/staff-http.ts'
import {
	cancelPairingCode,
	createPairingCode,
	listDevices,
	listPendingPairingCodes,
	revokeDevice,
	updateDevice,
	type DeviceContext,
	type DeviceResult,
} from '../services/kiosk-device-service.ts'
import {
	getDefaultPolicy,
	getEffectivePolicy,
	listPolicies,
	savePolicy,
	type PolicyContext,
	type PolicyResult,
} from '../services/labor-policy-service.ts'
import { loadTimeclockToday } from '../services/timeclock-today-service.ts'
import { kioskDeps } from './kiosk.ts'
import { timesheetRoutes } from './timesheets.ts'

/**
 * `/operator/timeclock`: labor policy and kiosk device management. Reached
 * browser-direct with App-minted staffing tokens of scope `timeclock`. The
 * policy and device grants are `read|update:labor_policy:any`; the scope
 * scope in the token limits every route, and an out-of-scope id answers 404 so
 * it is not confirmed to exist.
 */
export const timeclockOperatorRoutes = new Hono()

// Timesheets: views, manager edits, approval, payroll summary and export.
timeclockOperatorRoutes.route('/timesheets', timesheetRoutes)

function guarded(
	requirement: StaffRequirement,
	handler: (
		ctx: PolicyContext & DeviceContext,
		c: Context,
	) => Promise<Response>,
) {
	return staffGuard('timeclock', 'Timeclock', requirement, handler)
}

type Failing = {
	ok: false
	status: 400 | 403 | 404 | 409 | 422
	error: string
	extra?: Record<string, unknown>
}

function respond<T>(
	result: PolicyResult<T> | DeviceResult<T>,
	status: 200 | 201 = 200,
) {
	if (result.ok) return json(result.value, status)
	const failed = result as Failing
	return staffError(failed.status, failed.error, failed.extra ?? {})
}

function param(c: Context, name: string): string {
	return c.req.param(name) ?? ''
}

const READ_POLICY = { all: [P.READ_LABOR_POLICY] }
const READ_TODAY = { all: [P.READ_TIMESHEET, P.READ_STAFF] }
const WRITE_POLICY = { all: [P.UPDATE_LABOR_POLICY], write: true }

// ---------------------------------------------------------------------------
// Today's status
// ---------------------------------------------------------------------------

/**
 * Who is clocked in, on a break or running long, plus recent clock-outs.
 * Names and times only; limited to the token's scopes (an id outside them
 * answers 404, never an empty list that would confirm it exists).
 */
timeclockOperatorRoutes.get(
	'/today',
	guarded(READ_TODAY, async (ctx, c) => {
		const scopeId = c.req.query('scopeId')
		if (scopeId !== undefined) {
			if (!OPAQUE_ID_PATTERN.test(scopeId) || !ctx.scope.allows(scopeId)) {
				return staffError(404, 'not_found')
			}
		}
		return json(
			await loadTimeclockToday(ctx, { scopeId }, kioskDeps.punch.now()),
		)
	}),
)

// ---------------------------------------------------------------------------
// Labor policy
// ---------------------------------------------------------------------------

timeclockOperatorRoutes.get(
	'/policies',
	guarded(READ_POLICY, async (ctx) => json(await listPolicies(ctx))),
)

// Declared before `/policies/:scopeId` so the static segment wins.
timeclockOperatorRoutes.get(
	'/policies/default',
	guarded(READ_POLICY, async (ctx) =>
		json({ policy: await getDefaultPolicy(ctx.db) }),
	),
)

timeclockOperatorRoutes.put(
	'/policies/default',
	guarded(WRITE_POLICY, async (ctx, c) => {
		const body = await readJsonBody(c, laborPolicyPatchSchema)
		if ('error' in body) return body.error
		return respond(await savePolicy(ctx, null, body.data))
	}),
)

timeclockOperatorRoutes.get(
	'/policies/:scopeId',
	guarded(READ_POLICY, async (ctx, c) => {
		const scopeId = param(c, 'scopeId')
		if (!OPAQUE_ID_PATTERN.test(scopeId)) return staffError(404, 'not_found')
		return respond(await getEffectivePolicy(ctx, scopeId))
	}),
)

timeclockOperatorRoutes.put(
	'/policies/:scopeId',
	guarded(WRITE_POLICY, async (ctx, c) => {
		const scopeId = param(c, 'scopeId')
		if (!OPAQUE_ID_PATTERN.test(scopeId)) return staffError(404, 'not_found')
		const body = await readJsonBody(c, laborPolicyPatchSchema)
		if ('error' in body) return body.error
		return respond(await savePolicy(ctx, scopeId, body.data))
	}),
)

// ---------------------------------------------------------------------------
// Kiosk pairing and devices
// ---------------------------------------------------------------------------

timeclockOperatorRoutes.post(
	'/kiosk/pairing-codes',
	guarded(WRITE_POLICY, async (ctx, c) => {
		if (!isKioskEnabled()) return kioskDisabledResponse()
		const body = await readJsonBody(c, kioskPairingCodeCreateSchema)
		if ('error' in body) return body.error
		if (!OPAQUE_ID_PATTERN.test(body.data.scopeId)) {
			return staffError(404, 'not_found')
		}
		return respond(await createPairingCode(ctx, body.data), 201)
	}),
)

timeclockOperatorRoutes.get(
	'/kiosk/pairing-codes',
	guarded(READ_POLICY, async (ctx) =>
		json({ codes: await listPendingPairingCodes(ctx) }),
	),
)

timeclockOperatorRoutes.delete(
	'/kiosk/pairing-codes/:id',
	guarded(WRITE_POLICY, async (ctx, c) =>
		respond(await cancelPairingCode(ctx, param(c, 'id'))),
	),
)

timeclockOperatorRoutes.get(
	'/kiosk/devices',
	guarded(READ_POLICY, async (ctx) =>
		json({ devices: await listDevices(ctx) }),
	),
)

timeclockOperatorRoutes.patch(
	'/kiosk/devices/:id',
	guarded(WRITE_POLICY, async (ctx, c) => {
		const body = await readJsonBody(c, kioskDeviceUpdateSchema)
		if ('error' in body) return body.error
		return respond(await updateDevice(ctx, param(c, 'id'), body.data))
	}),
)

// Revoking is always allowed, even with the kiosk kill switch on.
timeclockOperatorRoutes.post(
	'/kiosk/devices/:id/revoke',
	guarded(WRITE_POLICY, async (ctx, c) =>
		respond(await revokeDevice(ctx, param(c, 'id'))),
	),
)
