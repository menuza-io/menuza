import { type Context, Hono } from 'hono'
import {
	kioskIdentifySchema,
	kioskPunchSchema,
	type KioskIdentifyResult,
} from '@repo/staffing'
import {
	authenticatePosDevice,
	isPosHashUnavailable,
	posError,
	posUnavailableResponse,
	type PosAuth,
} from '../lib/pos-auth.ts'
import { runExclusive } from '../lib/concurrency.ts'
import { getScopeFacts, getStaffingFeatures } from '../lib/scope-context.ts'
import { json, readJsonBody } from '../lib/staff-http.ts'
import { resolvePolicy } from '../services/labor-policy-service.ts'
import { timeclockGate } from '../services/pos-apps-service.ts'
import { touchDevice, verifyPosPin } from '../services/pos-service.ts'
import {
	defaultPunchDeps,
	describeClockState,
	processPunch,
	type PunchDeps,
} from '../services/punch-service.ts'
import { scheduleSeam } from '../services/schedule-seam.ts'
import { describeStaffError, hashClientIp } from '../services/staff-audit.ts'

/**
 * `/pos/timeclock`: the time clock on a paired Station terminal. The same punch
 * engine, request shapes and answers as the kiosk (`routes/kiosk.ts`), on the
 * terminal's own credential, so a till does not need a second pairing to be a
 * clock. Each punch names the person by PIN at the terminal's workplace; a
 * signed-in till session is never enough, so nobody clocks in a colleague.
 *
 * Wrong PINs share the terminal's sign-in backoff. Responses carry a first name,
 * a clock state and the person's own next shifts, nothing else.
 */
export const posTimeclockRoutes = new Hono()

/** Test seam: the punch engine's clock and shift matcher. */
export const posTimeclockDeps: { punch: PunchDeps } = {
	punch: defaultPunchDeps,
}

type Handler = (pos: PosAuth, c: Context) => Promise<Response>

function guarded(handler: Handler) {
	return async (c: Context) => {
		const authed = await authenticatePosDevice(c)
		if ('error' in authed) return authed.error
		const { pos } = authed
		try {
			const gate = await timeclockGate(
				pos.orgId,
				pos.device,
				posTimeclockDeps.punch.now(),
			)
			if (!gate.ok) return posError(403, gate.code)
			await touchDevice(pos.db, pos.device).catch(() => {})
			return await handler(pos, c)
		} catch (error) {
			if (isPosHashUnavailable(error)) return posUnavailableResponse()
			console.error(
				`POS time clock failed (${c.req.method} ${c.req.routePath})`,
				describeStaffError(error),
			)
			return posError(500, 'internal_error')
		}
	}
}

/** Control-plane facts first, then the workplace's labor policy snapshot. */
async function resolveTimeZone(pos: PosAuth): Promise<string | null> {
	const facts = await getScopeFacts(pos.orgId, pos.device.scopeId)
	if (facts) return facts.timeZone
	const policy = await resolvePolicy(pos.db, pos.device.scopeId)
	return policy.timeZone ?? null
}

const NEXT_SHIFTS = 3
const NEXT_SHIFTS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The person's own next published shifts here, while scheduling is on. Times
 * only. A till stands behind the counter, not in a public room, and the person
 * has just proven who they are with their PIN.
 */
async function nextShiftsFor(pos: PosAuth, staffId: string, now: number) {
	try {
		const flags = await getStaffingFeatures(pos.orgId, now)
		if (!flags?.features.enabled || !flags.features.scheduling) return []
		const upcoming = await scheduleSeam.listShifts(pos.db, {
			startsFromMs: now,
			startsToMs: now + NEXT_SHIFTS_WINDOW_MS,
			staffId,
			scopeId: pos.device.scopeId,
			limit: NEXT_SHIFTS,
		})
		return (upcoming ?? []).map((shift) => ({
			startAt: shift.startAt,
			endAt: shift.endAt,
		}))
	} catch (error) {
		console.warn(
			'POS time clock: could not read the next shifts',
			describeStaffError(error),
		)
		return []
	}
}

function pinRefused(
	code: 'invalid_pin' | 'backoff',
	retryAfterSeconds: number,
) {
	return Response.json(
		{ error: code, retryAfterSeconds },
		{
			status: code === 'backoff' ? 429 : 401,
			headers: {
				'Cache-Control': 'private, no-store',
				'Retry-After': String(retryAfterSeconds),
			},
		},
	)
}

/** Who is this and what can they do now? Changes nothing but the PIN counters. */
posTimeclockRoutes.post(
	'/identify',
	guarded(async (pos, c) => {
		const body = await readJsonBody(c, kioskIdentifySchema)
		if ('error' in body) return body.error
		const timeZone = await resolveTimeZone(pos)
		if (!timeZone) return posError(503, 'time_zone_unavailable')

		return runExclusive(pos.orgId, async () => {
			const verified = await verifyPosPin(
				pos.db,
				{ orgId: pos.orgId, device: pos.device, pin: body.data.pin },
				posTimeclockDeps.punch.now(),
			)
			if (!verified.ok) {
				return pinRefused(verified.code, verified.retryAfterSeconds)
			}
			const now = posTimeclockDeps.punch.now()
			const described = await describeClockState(
				pos.db,
				{ member: verified.member, device: pos.device, timeZone },
				now,
			)
			const result: KioskIdentifyResult = {
				firstName: verified.member.firstName,
				state: described.state,
				allowedEvents: described.allowedEvents,
				positions: described.positions,
				promptTips: described.promptTips,
				nextShifts: await nextShiftsFor(pos, verified.member.id, now),
				serverNow: now,
			}
			return json(result)
		})
	}),
)

posTimeclockRoutes.post(
	'/punch',
	guarded(async (pos, c) => {
		const body = await readJsonBody(c, kioskPunchSchema)
		if ('error' in body) return body.error
		const request = body.data
		const timeZone = await resolveTimeZone(pos)
		if (!timeZone) return posError(503, 'time_zone_unavailable')

		// One punch at a time per organization on this process; the unique
		// indexes arbitrate across processes and Durable Object instances.
		return runExclusive(pos.orgId, async () => {
			const verified = await verifyPosPin(
				pos.db,
				{ orgId: pos.orgId, device: pos.device, pin: request.pin },
				posTimeclockDeps.punch.now(),
			)
			if (!verified.ok) {
				return pinRefused(verified.code, verified.retryAfterSeconds)
			}
			const outcome = await processPunch(
				pos.db,
				{
					orgId: pos.orgId,
					device: pos.device,
					source: 'pos',
					assignment: verified.assignment,
					member: verified.member,
					ipHash: hashClientIp(c),
					timeZone,
				},
				request,
				posTimeclockDeps.punch,
			)
			if (outcome.ok) return json(outcome.result)
			return posError(outcome.status, outcome.code, outcome.extra ?? {})
		})
	}),
)
