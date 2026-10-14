import { and, asc, eq, isNotNull } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import {
	kioskIdentifySchema,
	kioskPairRequestSchema,
	kioskPunchSchema,
	parseKioskPairingCode,
	type KioskConfig,
	type KioskIdentifyResult,
	type KioskPerson,
} from '@repo/staffing'
import {
	getTenantDb,
	staffScopeAssignments,
	staffMembers,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	authenticateKioskDevice,
	isKioskEnabled,
	kioskDisabledResponse,
	kioskError,
	type KioskAuth,
} from '../lib/kiosk-auth.ts'
import { runExclusive } from '../lib/concurrency.ts'
import { getScopeFacts, getStaffingFeatures } from '../lib/scope-context.ts'
import { json, readJsonBody } from '../lib/staff-http.ts'
import { resolvePolicy } from '../services/labor-policy-service.ts'
import {
	redeemPairingCode,
	touchDevice,
} from '../services/kiosk-device-service.ts'
import {
	verifyKioskPin,
	type PinRejected,
} from '../services/kiosk-pin-service.ts'
import {
	describeClockState,
	processPunch,
	defaultPunchDeps,
	type PunchDeps,
} from '../services/punch-service.ts'
import { scheduleSeam } from '../services/schedule-seam.ts'
import { describeStaffError, hashClientIp } from '../services/staff-audit.ts'

/**
 * `/kiosk`: the shared-tablet time clock. Public routes authenticated by a
 * paired device's secret (`lib/kiosk-auth.ts`), never by an operator token. A
 * device is bound to one scope and can only identify people by PIN there
 * (or, in the optional pick-name mode, by name then PIN), punch, and read its
 * own configuration. In PIN mode it cannot list anyone.
 *
 * Responses carry a first name and a clock state, nothing else about a person:
 * the screen is shared and in a public room. Wrong PINs back off per device on
 * a persisted counter; the device is never locked out as a whole.
 */
export const kioskRoutes = new Hono()

/** Test seam: the punch engine's clock and shift matcher. */
export const kioskDeps: { punch: PunchDeps } = { punch: defaultPunchDeps }

type KioskHandler = (kiosk: KioskAuth, c: Context) => Promise<Response>

function deviceGuarded(handler: KioskHandler) {
	return async (c: Context) => {
		const authed = await authenticateKioskDevice(c)
		if ('error' in authed) return authed.error
		const { kiosk } = authed
		try {
			await touchDevice(
				kiosk.db,
				kiosk.device,
				kiosk.ipHash,
				kioskDeps.punch.now(),
			)
		} catch (error) {
			// Presence is best effort; never fail a punch over it.
			console.warn(
				'Kiosk: could not record last seen',
				describeStaffError(error),
			)
		}
		try {
			return await handler(kiosk, c)
		} catch (error) {
			console.error(
				`Kiosk route failed (${c.req.method} ${c.req.routePath})`,
				describeStaffError(error),
			)
			return kioskError(500, 'Internal Server Error')
		}
	}
}

/**
 * Time zone for a scope: control-plane facts first, then the policy
 * snapshot, then what the device was paired with.
 */
async function resolveTimeZone(kiosk: KioskAuth): Promise<string | null> {
	const facts = await getScopeFacts(kiosk.orgId, kiosk.device.scopeId)
	if (facts) return facts.timeZone
	const policy = await resolvePolicy(kiosk.db, kiosk.device.scopeId)
	return policy.timeZone ?? kiosk.device.timeZone ?? null
}

/** How many upcoming shifts a tablet that opted in shows, and how far ahead it looks. */
const KIOSK_NEXT_SHIFTS = 3
const KIOSK_NEXT_SHIFTS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The person's own next published shifts at this tablet's scope, only for a
 * tablet that opted in (a shared screen shows nothing by default) and only while
 * the organization's scheduling switch is on. Times only: no position, note or
 * teammate. The person has just proven who they are with their PIN.
 */
async function nextShiftsFor(
	kiosk: KioskAuth,
	staffId: string,
	now: number,
): Promise<Array<{ startAt: number; endAt: number }>> {
	if (!kiosk.device.showNextShifts) return []
	try {
		const flags = await getStaffingFeatures(kiosk.orgId, now)
		if (!flags?.features.enabled || !flags.features.scheduling) return []
		const upcoming = await scheduleSeam.listShifts(kiosk.db, {
			startsFromMs: now,
			startsToMs: now + KIOSK_NEXT_SHIFTS_WINDOW_MS,
			staffId,
			scopeId: kiosk.device.scopeId,
			limit: KIOSK_NEXT_SHIFTS,
		})
		return (upcoming ?? []).map((shift) => ({
			startAt: shift.startAt,
			endAt: shift.endAt,
		}))
	} catch (error) {
		// A clock that cannot read the schedule still lets people punch.
		console.warn(
			'Kiosk: could not read the next shifts',
			describeStaffError(error),
		)
		return []
	}
}

function pinFailureResponse(failure: PinRejected) {
	const retry = failure.retryAfterSeconds
	const headers: Record<string, string> =
		retry > 0 ? { 'Retry-After': String(retry) } : {}
	if (failure.code === 'invalid_pin') {
		return kioskError(401, 'invalid_pin', { retryAfterSeconds: retry }, headers)
	}
	return kioskError(429, failure.code, { retryAfterSeconds: retry }, headers)
}

// ---------------------------------------------------------------------------
// Pairing (no device yet; the one-time code is the credential)
// ---------------------------------------------------------------------------

kioskRoutes.post('/pair', async (c) => {
	if (!isKioskEnabled()) return kioskDisabledResponse()
	const body = await readJsonBody(c, kioskPairRequestSchema)
	if ('error' in body) return body.error

	// Every failure below answers the same, so a code cannot be probed.
	const invalid = () => kioskError(401, 'invalid_pairing_code')
	const parsed = parseKioskPairingCode(body.data.code)
	if (!parsed) return invalid()

	let db: TenantDatabase
	try {
		db = await getTenantDb(parsed.orgId)
	} catch {
		return invalid()
	}

	try {
		const paired = await redeemPairingCode(
			db,
			parsed.orgId,
			body.data.code,
			hashClientIp(c),
			kioskDeps.punch.now(),
		)
		if (!paired) return invalid()
		const { config } = paired
		// The control plane's facts are fresher than the pairing snapshot.
		const facts = await getScopeFacts(parsed.orgId, config.device.scopeId)
		const response: { deviceSecret: string } & KioskConfig = {
			deviceSecret: paired.secret,
			...config,
			scope: {
				name: facts?.name ?? config.scope.name,
				timeZone: facts?.timeZone ?? config.scope.timeZone,
			},
		}
		return json(response, 201)
	} catch (error) {
		console.error('Kiosk pairing failed', describeStaffError(error))
		return kioskError(500, 'Internal Server Error')
	}
})

// ---------------------------------------------------------------------------
// Device routes
// ---------------------------------------------------------------------------

kioskRoutes.get(
	'/config',
	deviceGuarded(async (kiosk) => {
		const { device } = kiosk
		const facts = await getScopeFacts(kiosk.orgId, device.scopeId)
		const config: KioskConfig = {
			device: {
				id: device.id,
				name: device.name,
				scopeId: device.scopeId,
				identifyMode: device.identifyMode,
				showNextShifts: device.showNextShifts,
			},
			scope: {
				name: facts?.name ?? device.scopeName,
				timeZone: facts?.timeZone ?? device.timeZone,
			},
			serverNow: kioskDeps.punch.now(),
		}
		return json(config)
	}),
)

/** First name and last initial; only for pick-name devices. */
kioskRoutes.get(
	'/people',
	deviceGuarded(async (kiosk) => {
		if (kiosk.device.identifyMode !== 'pick_name') {
			return kioskError(403, 'not_available')
		}
		const rows = await kiosk.db
			.select({
				staffId: staffMembers.id,
				firstName: staffMembers.firstName,
				lastName: staffMembers.lastName,
			})
			.from(staffScopeAssignments)
			.innerJoin(
				staffMembers,
				eq(staffMembers.id, staffScopeAssignments.staffId),
			)
			.where(
				and(
					eq(staffScopeAssignments.scopeId, kiosk.device.scopeId),
					eq(staffScopeAssignments.active, true),
					isNotNull(staffScopeAssignments.pinLookup),
					eq(staffMembers.status, 'active'),
				),
			)
			.orderBy(asc(staffMembers.firstName), asc(staffMembers.lastName))
			.limit(300)
		const people: KioskPerson[] = rows.map((row) => ({
			staffId: row.staffId,
			firstName: row.firstName,
			lastInitial: (Array.from(row.lastName.trim())[0] ?? '').toUpperCase(),
		}))
		return json({ people })
	}),
)

/** Who is this and what can they do now? Never changes anything but counters. */
kioskRoutes.post(
	'/identify',
	deviceGuarded(async (kiosk, c) => {
		const body = await readJsonBody(c, kioskIdentifySchema)
		if ('error' in body) return body.error
		if (kiosk.device.identifyMode === 'pick_name' && !body.data.staffId) {
			return kioskError(400, 'Invalid request', {
				issues: [{ path: 'staffId', code: 'required' }],
			})
		}
		const timeZone = await resolveTimeZone(kiosk)
		if (!timeZone) return kioskError(503, 'time_zone_unavailable')

		// Serialized with punches so a burst of simultaneous guesses cannot all
		// read the counter before the first one has written it.
		return runExclusive(kiosk.orgId, async () => {
			const verified = await verifyKioskPin(
				kiosk.db,
				{
					orgId: kiosk.orgId,
					device: kiosk.device,
					pin: body.data.pin,
					staffId: body.data.staffId,
					ipHash: kiosk.ipHash,
				},
				kioskDeps.punch.now(),
			)
			if (!verified.ok) return pinFailureResponse(verified)

			const now = kioskDeps.punch.now()
			const described = await describeClockState(
				kiosk.db,
				{ member: verified.member, device: kiosk.device, timeZone },
				now,
			)
			const result: KioskIdentifyResult = {
				firstName: verified.member.firstName,
				state: described.state,
				allowedEvents: described.allowedEvents,
				positions: described.positions,
				promptTips: described.promptTips,
				nextShifts: await nextShiftsFor(kiosk, verified.member.id, now),
				serverNow: now,
			}
			return json(result)
		})
	}),
)

kioskRoutes.post(
	'/punch',
	deviceGuarded(async (kiosk, c) => {
		const body = await readJsonBody(c, kioskPunchSchema)
		if ('error' in body) return body.error
		const request = body.data
		if (kiosk.device.identifyMode === 'pick_name' && !request.staffId) {
			return kioskError(400, 'Invalid request', {
				issues: [{ path: 'staffId', code: 'required' }],
			})
		}
		const timeZone = await resolveTimeZone(kiosk)
		if (!timeZone) return kioskError(503, 'time_zone_unavailable')

		// One punch at a time per organization on this process; the unique
		// indexes arbitrate across processes and Durable Object instances.
		return runExclusive(kiosk.orgId, async () => {
			const verified = await verifyKioskPin(
				kiosk.db,
				{
					orgId: kiosk.orgId,
					device: kiosk.device,
					pin: request.pin,
					staffId: request.staffId,
					ipHash: kiosk.ipHash,
				},
				kioskDeps.punch.now(),
			)
			if (!verified.ok) return pinFailureResponse(verified)

			const outcome = await processPunch(
				kiosk.db,
				{
					orgId: kiosk.orgId,
					device: kiosk.device,
					assignment: verified.assignment,
					member: verified.member,
					ipHash: kiosk.ipHash,
					timeZone,
				},
				request,
				kioskDeps.punch,
			)
			if (outcome.ok) return json(outcome.result)
			return kioskError(outcome.status, outcome.code, outcome.extra ?? {})
		})
	}),
)
