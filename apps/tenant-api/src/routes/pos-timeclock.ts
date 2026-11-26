import { desc, eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import {
	announcementReadSchema,
	kioskIdentifySchema,
	kioskPunchSchema,
	type KioskIdentifyResult,
} from '@repo/staffing'
import { timeEntries } from '@repo/tenant-db'
import { z } from 'zod'
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
import { queueClockSlipPrint } from '../services/pos-auto-print.ts'
import { timeclockGate } from '../services/pos-apps-service.ts'
import { touchDevice, verifyPosPin } from '../services/pos-service.ts'
import {
	defaultPunchDeps,
	describeClockState,
	processPunch,
	replayRecordedPunch,
	type PunchDeps,
} from '../services/punch-service.ts'
import { loadMyWeek } from '../services/schedule-self-service.ts'
import { scheduleSeam } from '../services/schedule-seam.ts'
import {
	loadMyAnnouncements,
	markAnnouncementRead,
} from '../services/staff-announcements-service.ts'
import {
	describeStaffError,
	hashClientIp,
	writeDeviceAudit,
} from '../services/staff-audit.ts'

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

/** A punch the till made offline and sends now (with the time it was made), or null. */
async function offlineReplay(
	c: Context,
): Promise<{ at: number | null } | null> {
	if (c.req.method !== 'POST' || !c.req.path.endsWith('/punch')) return null
	const body = (await c.req.raw
		.clone()
		.json()
		.catch(() => null)) as { offline?: unknown; clientAt?: unknown } | null
	if (body?.offline !== true) return null
	return {
		at:
			typeof body.clientAt === 'number' && Number.isFinite(body.clientAt)
				? body.clientAt
				: null,
	}
}

function guarded(handler: Handler) {
	return async (c: Context) => {
		const authed = await authenticatePosDevice(c)
		if ('error' in authed) return authed.error
		const { pos } = authed
		try {
			const gate = await timeclockGate(pos.orgId, pos.device, {
				now: posTimeclockDeps.punch.now(),
				offlineReplay: await offlineReplay(c),
			})
			if (!gate.ok) return posError(gate.status, gate.code)
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
				staffId: verified.member.id,
				breakKinds: described.breakKinds,
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
			// Recorded already (the answer was lost): the same answer, whatever the PIN is now.
			const recorded = await replayRecordedPunch(
				pos.db,
				pos.device.id,
				request,
				posTimeclockDeps.punch.now(),
				pos.device.scopeId,
			)
			if (recorded) return json(recorded.result)
			const verified = await verifyPosPin(
				pos.db,
				{ orgId: pos.orgId, device: pos.device, pin: request.pin },
				posTimeclockDeps.punch.now(),
			)
			if (!verified.ok) {
				return pinRefused(verified.code, verified.retryAfterSeconds)
			}
			// The till knew whose punch this was; the PIN now names someone else
			// (reissued since). Final: it is never recorded for the wrong person.
			if (request.staffId && request.staffId !== verified.member.id)
				return posError(409, 'pin_owner_changed')
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
			if (outcome.ok) {
				if (request.kind === 'clock_in' || request.kind === 'clock_out') {
					const [entry] = await pos.db
						.select({
							id: timeEntries.id,
							paidMinutes: timeEntries.paidMinutes,
						})
						.from(timeEntries)
						.where(eq(timeEntries.staffId, verified.member.id))
						.orderBy(desc(timeEntries.clockInAt))
						.limit(1)
					if (entry) {
						const minutes = entry.paidMinutes ?? 0
						await queueClockSlipPrint(pos.db, {
							deviceId: pos.device.id,
							enabled: pos.device.printClockSlip,
							entryId: entry.id,
							firstName: verified.member.firstName,
							action: request.kind === 'clock_in' ? 'in' : 'out',
							atLabel: new Date(outcome.result.at).toISOString(),
							shiftTotalLabel:
								request.kind === 'clock_out'
									? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
									: null,
						}).catch(() => {})
					}
				}
				return json(outcome.result)
			}
			return posError(outcome.status, outcome.code, outcome.extra ?? {})
		})
	}),
)

// ---------------------------------------------------------------------------
// After a punch (#514, #486): the person's own week and the announcements meant
// for them. Each call names the person by PIN again (the till holds the PIN
// only while the after-punch screen is open), so a session left on the screen
// never opens someone's pay or their notices. The answer is first name, hours,
// the next shift and, only when the organization turned it on, an estimate of
// pay: nothing about anyone else.
// ---------------------------------------------------------------------------

const afterPunchSchema = z
	.object({ pin: kioskIdentifySchema.shape.pin })
	.strict()
const readAnnouncementSchema = z
	.object({
		pin: kioskIdentifySchema.shape.pin,
		announcementId: announcementReadSchema.shape.announcementId,
	})
	.strict()

/** The person this PIN names at this terminal, or the PIN refusal to send. */
async function personByPin(pos: PosAuth, pin: string) {
	const verified = await verifyPosPin(
		pos.db,
		{ orgId: pos.orgId, device: pos.device, pin },
		posTimeclockDeps.punch.now(),
	)
	return verified.ok
		? ({ ok: true, member: verified.member } as const)
		: ({
				ok: false,
				response: pinRefused(verified.code, verified.retryAfterSeconds),
			} as const)
}

posTimeclockRoutes.post(
	'/my-week',
	guarded(async (pos, c) => {
		const body = await readJsonBody(c, afterPunchSchema)
		if ('error' in body) return body.error
		return runExclusive(pos.orgId, async () => {
			const who = await personByPin(pos, body.data.pin)
			if (!who.ok) return who.response
			const now = posTimeclockDeps.punch.now()
			const week = await loadMyWeek({
				db: pos.db,
				orgId: pos.orgId,
				staff: who.member,
				now,
			})
			if (!week.ok) return posError(week.status, week.error)
			return json({
				firstName: who.member.firstName,
				week: week.value,
				...(await loadMyAnnouncements({
					db: pos.db,
					staffId: who.member.id,
					now,
				})),
			})
		})
	}),
)

posTimeclockRoutes.post(
	'/announcements',
	guarded(async (pos, c) => {
		const body = await readJsonBody(c, afterPunchSchema)
		if ('error' in body) return body.error
		return runExclusive(pos.orgId, async () => {
			const who = await personByPin(pos, body.data.pin)
			if (!who.ok) return who.response
			return json(
				await loadMyAnnouncements(
					{
						db: pos.db,
						staffId: who.member.id,
						now: posTimeclockDeps.punch.now(),
					},
					{ unreadOnly: true },
				),
			)
		})
	}),
)

posTimeclockRoutes.post(
	'/announcements/read',
	guarded(async (pos, c) => {
		const body = await readJsonBody(c, readAnnouncementSchema)
		if ('error' in body) return body.error
		const ipHash = hashClientIp(c)
		return runExclusive(pos.orgId, async () => {
			const who = await personByPin(pos, body.data.pin)
			if (!who.ok) return who.response
			const result = await markAnnouncementRead(
				{
					db: pos.db,
					staffId: who.member.id,
					now: posTimeclockDeps.punch.now(),
					audit: (tx, event) =>
						writeDeviceAudit(tx, 'pos', pos.device, ipHash, event),
				},
				body.data.announcementId,
				'station',
			)
			if (!result.ok) return posError(result.status, result.error)
			return json(result.value)
		})
	}),
)
