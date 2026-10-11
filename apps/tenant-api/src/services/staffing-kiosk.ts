import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import {
	localDateOf,
	PAIRING_CODE_TTL_MINUTES,
	pinProblem,
	shiftInstants,
	type StaffingTokenClaims,
	staffingTokenAllowsLocation,
	staffingTokenLocationZone,
} from '@repo/staffing'
import {
	getTenantDb,
	type KioskDevice,
	kioskDevices,
	kioskPairingCodes,
	shifts,
	staffAssignments,
	staffMembers,
	staffPositions,
	type TimeEntry,
	timeEntries,
	timeEntryEvents,
} from '@repo/tenant-db'

import {
	createDeviceToken,
	createPunchToken,
	generatePairingCode,
	generatePin,
	hashDeviceToken,
	hashPairingCode,
	hashPin,
	PIN_LOCKOUT_THRESHOLD,
	pinLockoutMs,
	verifyPunchToken,
} from '../lib/staff-pin.ts'
import { type StaffingAuth } from '../lib/staffing-auth.ts'
import {
	loadVisibleStaff,
	onStaffTerminated,
	recordStaffEvent,
	type ServiceResult,
} from './staffing-roster.ts'
import { assignmentRate } from './staffing-pay.ts'
import { upcomingPublishedShifts } from './staffing-schedule.ts'

type TenantDatabase = Awaited<ReturnType<typeof getTenantDb>>
type Transaction = Parameters<Parameters<TenantDatabase['transaction']>[0]>[0]
type Writer = TenantDatabase | Transaction

const failure = (status: 400 | 404 | 409, code: string) =>
	({ ok: false, status, code }) as const

function isUniqueViolation(error: unknown) {
	const text = error instanceof Error ? `${error.message} ${error.cause}` : ''
	return /UNIQUE constraint failed/i.test(text)
}

// ---------------------------------------------------------------------------
// Operator side: PINs and devices
// ---------------------------------------------------------------------------

export async function setStaffPin(
	orgId: string,
	auth: StaffingAuth,
	staffId: string,
	requested: string | undefined,
): Promise<ServiceResult<{ pin: string; generated: boolean }>> {
	if (requested !== undefined) {
		const problem = pinProblem(requested)
		if (problem) return failure(400, `pin_${problem}`)
	}
	const db = await getTenantDb(orgId)
	const existing = await loadVisibleStaff(db, auth.claims, staffId)
	if (!existing) return failure(404, 'not_found')
	if (existing.member.status !== 'active') return failure(409, 'staff_inactive')
	for (let attempt = 0; attempt < 20; attempt++) {
		const pin = requested ?? generatePin(attempt < 10 ? 4 : 6)
		try {
			await db
				.update(staffMembers)
				.set({
					pinHash: hashPin(orgId, pin),
					pinSetAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(staffMembers.id, staffId))
			await recordStaffEvent(db, auth, 'staff.pin_set', staffId, {
				generated: requested === undefined,
			})
			return { ok: true, data: { pin, generated: requested === undefined } }
		} catch (error) {
			if (!isUniqueViolation(error)) throw error
			// PINs identify people, so two people cannot share one.
			if (requested !== undefined) return failure(409, 'pin_taken')
		}
	}
	return failure(409, 'pin_taken')
}

export async function clearStaffPin(
	orgId: string,
	auth: StaffingAuth,
	staffId: string,
): Promise<ServiceResult<{ cleared: true }>> {
	const db = await getTenantDb(orgId)
	const existing = await loadVisibleStaff(db, auth.claims, staffId)
	if (!existing) return failure(404, 'not_found')
	await db
		.update(staffMembers)
		.set({ pinHash: null, pinSetAt: null, updatedAt: new Date() })
		.where(eq(staffMembers.id, staffId))
	await recordStaffEvent(db, auth, 'staff.pin_cleared', staffId)
	return { ok: true, data: { cleared: true } }
}

function serializeDevice(device: KioskDevice) {
	return {
		id: device.id,
		name: device.name,
		locationId: device.locationId,
		createdAt: device.createdAt.toISOString(),
		createdBy: device.createdBy,
		lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
		lockedUntil: device.lockedUntil?.toISOString() ?? null,
		revokedAt: device.revokedAt?.toISOString() ?? null,
	}
}

export async function createPairingCode(
	orgId: string,
	auth: StaffingAuth,
	input: { locationId: string; locationName: string; name: string },
): Promise<ServiceResult<{ code: string; expiresAt: string }>> {
	if (!staffingTokenAllowsLocation(auth.claims, input.locationId)) {
		return failure(400, 'unknown_location')
	}
	const timeZone = staffingTokenLocationZone(auth.claims, input.locationId)!
	const db = await getTenantDb(orgId)
	const code = generatePairingCode()
	const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MINUTES * 60_000)
	await db
		.delete(kioskPairingCodes)
		.where(
			sql`${kioskPairingCodes.expiresAt} < ${Math.floor(Date.now() / 1000)}`,
		)
	await db.insert(kioskPairingCodes).values({
		codeHash: hashPairingCode(orgId, code),
		locationId: input.locationId,
		locationName: input.locationName,
		timeZone,
		name: input.name,
		createdBy: auth.actorRef,
		expiresAt,
	})
	return { ok: true, data: { code, expiresAt: expiresAt.toISOString() } }
}

export async function listKiosks(orgId: string, claims: StaffingTokenClaims) {
	const db = await getTenantDb(orgId)
	const rows = await db
		.select()
		.from(kioskDevices)
		.orderBy(desc(kioskDevices.createdAt))
		.limit(200)
	return rows
		.filter((row) => staffingTokenAllowsLocation(claims, row.locationId))
		.map(serializeDevice)
}

export async function revokeKiosk(
	orgId: string,
	auth: StaffingAuth,
	deviceId: string,
): Promise<ServiceResult<ReturnType<typeof serializeDevice>>> {
	const db = await getTenantDb(orgId)
	const [device] = await db
		.select()
		.from(kioskDevices)
		.where(eq(kioskDevices.id, deviceId))
		.limit(1)
	if (!device || !staffingTokenAllowsLocation(auth.claims, device.locationId)) {
		return failure(404, 'not_found')
	}
	if (device.revokedAt) return failure(409, 'already_revoked')
	const [row] = await db
		.update(kioskDevices)
		.set({ revokedAt: new Date(), revokedBy: auth.actorRef })
		.where(eq(kioskDevices.id, deviceId))
		.returning()
	await recordStaffEvent(db, auth, 'kiosk.revoked', null, {
		deviceId,
		locationId: device.locationId,
	})
	return { ok: true, data: serializeDevice(row!) }
}

// ---------------------------------------------------------------------------
// Kiosk side
// ---------------------------------------------------------------------------

export type KioskContext = { orgId: string; device: KioskDevice }

function kioskActor(device: Pick<KioskDevice, 'id'>) {
	return `kiosk:${device.id}`
}

function publicDevice(device: KioskDevice) {
	return {
		id: device.id,
		name: device.name,
		locationId: device.locationId,
		locationName: device.locationName,
		timeZone: device.timeZone,
	}
}

export async function pairKiosk(
	orgId: string,
	code: string,
): Promise<
	ServiceResult<{
		deviceToken: string
		device: ReturnType<typeof publicDevice>
	}>
> {
	const db = await getTenantDb(orgId)
	const codeHash = hashPairingCode(orgId, code)
	const deviceToken = createDeviceToken(orgId)
	return db.transaction(async (tx) => {
		const [pairing] = await tx
			.select()
			.from(kioskPairingCodes)
			.where(eq(kioskPairingCodes.codeHash, codeHash))
			.limit(1)
		if (
			!pairing ||
			pairing.usedAt ||
			pairing.expiresAt.getTime() < Date.now()
		) {
			return failure(400, 'invalid_code')
		}
		const [device] = await tx
			.insert(kioskDevices)
			.values({
				locationId: pairing.locationId,
				locationName: pairing.locationName,
				timeZone: pairing.timeZone,
				name: pairing.name,
				tokenHash: hashDeviceToken(deviceToken),
				createdBy: pairing.createdBy,
				lastSeenAt: new Date(),
			})
			.returning()
		const used = await tx
			.update(kioskPairingCodes)
			.set({ usedAt: new Date(), deviceId: device!.id })
			.where(
				and(
					eq(kioskPairingCodes.codeHash, codeHash),
					isNull(kioskPairingCodes.usedAt),
				),
			)
			.returning({ codeHash: kioskPairingCodes.codeHash })
		if (used.length !== 1) throw new Error('pairing code raced')
		await recordStaffEvent(
			tx,
			{ actorRef: pairing.createdBy },
			'kiosk.paired',
			null,
			{ deviceId: device!.id, locationId: pairing.locationId },
		)
		return {
			ok: true as const,
			data: { deviceToken, device: publicDevice(device!) },
		}
	})
}

export async function loadKioskDevice(orgId: string, deviceToken: string) {
	const db = await getTenantDb(orgId)
	const [device] = await db
		.select()
		.from(kioskDevices)
		.where(eq(kioskDevices.tokenHash, hashDeviceToken(deviceToken)))
		.limit(1)
	if (!device || device.revokedAt) return null
	const now = new Date()
	if (
		!device.lastSeenAt ||
		now.getTime() - device.lastSeenAt.getTime() > 60_000
	) {
		await db
			.update(kioskDevices)
			.set({ lastSeenAt: now })
			.where(eq(kioskDevices.id, device.id))
	}
	return device
}

export function kioskDeviceView(device: KioskDevice) {
	return publicDevice(device)
}

async function staffPositionsAt(
	db: Writer,
	staffId: string,
	locationId: string,
) {
	return db
		.select({
			id: staffPositions.id,
			name: staffPositions.name,
			colorKey: staffPositions.colorKey,
			isPrimary: staffAssignments.isPrimary,
		})
		.from(staffAssignments)
		.innerJoin(
			staffPositions,
			eq(staffPositions.id, staffAssignments.positionId),
		)
		.where(
			and(
				eq(staffAssignments.staffId, staffId),
				eq(staffAssignments.locationId, locationId),
			),
		)
		.orderBy(desc(staffAssignments.isPrimary), asc(staffPositions.name))
}

async function openEntryFor(db: Writer, staffId: string) {
	const [entry] = await db
		.select()
		.from(timeEntries)
		.where(
			and(
				eq(timeEntries.staffId, staffId),
				isNull(timeEntries.clockOutAt),
				isNull(timeEntries.deletedAt),
			),
		)
		.limit(1)
	return entry ?? null
}

function entryView(entry: TimeEntry) {
	return {
		id: entry.id,
		locationId: entry.locationId,
		positionId: entry.positionId,
		clockInAt: entry.clockInAt.toISOString(),
		clockOutAt: entry.clockOutAt?.toISOString() ?? null,
	}
}

async function kioskPersonView(
	db: Writer,
	context: KioskContext,
	staff: { id: string; firstName: string; lastName: string },
	now: Date,
) {
	const [positions, open, upcoming] = await Promise.all([
		staffPositionsAt(db, staff.id, context.device.locationId),
		openEntryFor(db, staff.id),
		upcomingPublishedShifts(db, staff.id, now, 10),
	])
	return {
		staff: {
			firstName: staff.firstName,
			lastInitial: staff.lastName.slice(0, 1),
		},
		clockedIn: open !== null,
		openEntry: open ? entryView(open) : null,
		positions: positions.map(({ isPrimary: ignoredPrimary, ...rest }) => rest),
		nextShifts: upcoming
			.filter((shift) => shift.locationId === context.device.locationId)
			.slice(0, 3)
			.map((shift) => ({
				localDate: shift.localDate,
				startTime: shift.startTime,
				endTime: shift.endTime,
				positionId: shift.positionId,
			})),
	}
}

export type IdentifyResult =
	| {
			ok: true
			data: Awaited<ReturnType<typeof kioskPersonView>> & { punchToken: string }
	  }
	| { ok: false; code: 'invalid_pin'; remainingAttempts: number }
	| { ok: false; code: 'locked'; retryAfterSeconds: number }

/**
 * A PIN identifies one active person assigned to the device's location. Wrong
 * PINs count against the device; a run of them locks it with backoff.
 */
export async function identifyAtKiosk(
	context: KioskContext,
	pin: string,
	now = new Date(),
): Promise<IdentifyResult> {
	const db = await getTenantDb(context.orgId)
	const [device] = await db
		.select()
		.from(kioskDevices)
		.where(eq(kioskDevices.id, context.device.id))
		.limit(1)
	if (device?.lockedUntil && device.lockedUntil.getTime() > now.getTime()) {
		return {
			ok: false,
			code: 'locked',
			retryAfterSeconds: Math.ceil(
				(device.lockedUntil.getTime() - now.getTime()) / 1000,
			),
		}
	}
	const [match] = await db
		.select({
			id: staffMembers.id,
			firstName: staffMembers.firstName,
			lastName: staffMembers.lastName,
		})
		.from(staffMembers)
		.innerJoin(
			staffAssignments,
			and(
				eq(staffAssignments.staffId, staffMembers.id),
				eq(staffAssignments.locationId, context.device.locationId),
			),
		)
		.where(
			and(
				eq(staffMembers.pinHash, hashPin(context.orgId, pin)),
				eq(staffMembers.status, 'active'),
			),
		)
		.limit(1)
	if (!match) {
		const [updated] = await db
			.update(kioskDevices)
			.set({ failedPinCount: sql`${kioskDevices.failedPinCount} + 1` })
			.where(eq(kioskDevices.id, context.device.id))
			.returning({ failedPinCount: kioskDevices.failedPinCount })
		const failed = updated?.failedPinCount ?? PIN_LOCKOUT_THRESHOLD
		const lockMs = pinLockoutMs(failed)
		if (lockMs > 0 && failed % PIN_LOCKOUT_THRESHOLD === 0) {
			await db
				.update(kioskDevices)
				.set({ lockedUntil: new Date(now.getTime() + lockMs) })
				.where(eq(kioskDevices.id, context.device.id))
			return {
				ok: false,
				code: 'locked',
				retryAfterSeconds: Math.ceil(lockMs / 1000),
			}
		}
		return {
			ok: false,
			code: 'invalid_pin',
			remainingAttempts:
				PIN_LOCKOUT_THRESHOLD - (failed % PIN_LOCKOUT_THRESHOLD),
		}
	}
	if (device && (device.failedPinCount > 0 || device.lockedUntil)) {
		await db
			.update(kioskDevices)
			.set({ failedPinCount: 0, lockedUntil: null })
			.where(eq(kioskDevices.id, context.device.id))
	}
	const view = await kioskPersonView(db, context, match, now)
	return {
		ok: true,
		data: {
			...view,
			punchToken: createPunchToken(
				context.orgId,
				context.device.id,
				match.id,
				now.getTime(),
			),
		},
	}
}

/** Published shift for this person here that starts within 3 hours of now. */
async function nearbyPublishedShift(
	db: Writer,
	staffId: string,
	locationId: string,
	now: Date,
) {
	const window = 3 * 60 * 60_000
	const rows = await db
		.select()
		.from(shifts)
		.where(
			and(
				eq(shifts.locationId, locationId),
				isNull(shifts.deletedAt),
				sql`json_extract(${shifts.published}, '$.staffId') = ${staffId}`,
				gt(shifts.endAt, new Date(now.getTime() - window)),
			),
		)
		.limit(20)
	let best: { id: string; positionId: string | null; distance: number } | null =
		null
	for (const row of rows) {
		const published = row.published!
		const { startAt } = shiftInstants({ ...published, timeZone: row.timeZone })
		const distance = Math.abs(startAt.getTime() - now.getTime())
		if (distance <= window && (!best || distance < best.distance)) {
			best = { id: row.id, positionId: published.positionId, distance }
		}
	}
	return best
}

/** Two devices racing to clock the same person in hit the open-entry index. */
async function runPunch<T>(
	db: TenantDatabase,
	work: (tx: Transaction) => Promise<T>,
): Promise<T | ReturnType<typeof failure>> {
	try {
		return await db.transaction(work)
	} catch (error) {
		if (isUniqueViolation(error)) return failure(409, 'already_clocked_in')
		throw error
	}
}

export async function punchAtKiosk(
	context: KioskContext,
	input: {
		punchToken: string
		action: 'in' | 'out'
		positionId: string | null
		clientRequestId: string
	},
	now = new Date(),
): Promise<
	ServiceResult<{
		action: 'in' | 'out'
		entry: ReturnType<typeof entryView>
		person: Awaited<ReturnType<typeof kioskPersonView>>
	}>
> {
	const verified = verifyPunchToken(
		context.orgId,
		context.device.id,
		input.punchToken,
		now.getTime(),
	)
	if (!verified) return failure(400, 'punch_expired')
	const db = await getTenantDb(context.orgId)
	const actor = kioskActor(context.device)
	const result = await runPunch(db, async (tx) => {
		const [member] = await tx
			.select()
			.from(staffMembers)
			.where(eq(staffMembers.id, verified.staffId))
			.limit(1)
		if (!member || member.status !== 'active') {
			return failure(400, 'punch_expired')
		}

		// Retries of the same tap return the original result.
		const [replay] = await tx
			.select()
			.from(timeEntries)
			.where(
				input.action === 'in'
					? eq(timeEntries.clientRequestId, input.clientRequestId)
					: eq(timeEntries.clockOutRequestId, input.clientRequestId),
			)
			.limit(1)
		if (replay) {
			if (replay.staffId !== member.id) return failure(409, 'request_reused')
			return { ok: true as const, data: { member, entry: replay } }
		}

		const open = await openEntryFor(tx, member.id)
		if (input.action === 'in') {
			if (open) return failure(409, 'already_clocked_in')
			const positions = await staffPositionsAt(
				tx,
				member.id,
				context.device.locationId,
			)
			if (positions.length === 0) return failure(400, 'not_assigned_here')
			const shift = await nearbyPublishedShift(
				tx,
				member.id,
				context.device.locationId,
				now,
			)
			let positionId: string | null
			if (input.positionId) {
				if (!positions.some((item) => item.id === input.positionId)) {
					return failure(400, 'unknown_position')
				}
				positionId = input.positionId
			} else {
				positionId =
					(shift?.positionId &&
					positions.some((item) => item.id === shift.positionId)
						? shift.positionId
						: null) ?? positions[0]!.id
			}
			const rate = await assignmentRate(
				tx,
				member.id,
				context.device.locationId,
				positionId,
			)
			const [entry] = await tx
				.insert(timeEntries)
				.values({
					staffId: member.id,
					locationId: context.device.locationId,
					positionId,
					...rate,
					shiftId: shift?.id ?? null,
					clockInAt: now,
					timeZone: context.device.timeZone,
					localDate: localDateOf(now, context.device.timeZone),
					source: 'kiosk',
					deviceId: context.device.id,
					clientRequestId: input.clientRequestId,
				})
				.returning()
			await tx.insert(timeEntryEvents).values({
				entryId: entry!.id,
				kind: 'clock_in',
				actorType: 'kiosk',
				actorRef: actor,
				after: entryView(entry!),
			})
			return { ok: true as const, data: { member, entry: entry! } }
		}

		if (!open) return failure(409, 'not_clocked_in')
		if (open.approvedAt) return failure(409, 'entry_locked')
		const [entry] = await tx
			.update(timeEntries)
			.set({
				clockOutAt: now,
				clockOutRequestId: input.clientRequestId,
				updatedAt: now,
			})
			.where(eq(timeEntries.id, open.id))
			.returning()
		await tx.insert(timeEntryEvents).values({
			entryId: open.id,
			kind: 'clock_out',
			actorType: 'kiosk',
			actorRef: actor,
			before: entryView(open),
			after: entryView(entry!),
		})
		return { ok: true as const, data: { member, entry: entry! } }
	})
	if (!result.ok) return result
	return {
		ok: true,
		data: {
			action: input.action,
			entry: entryView(result.data.entry),
			person: await kioskPersonView(db, context, result.data.member, now),
		},
	}
}

// A terminated person's PIN is cleared so it can be reused and never punches.
onStaffTerminated(async (tx, staffId) => {
	await tx
		.update(staffMembers)
		.set({ pinHash: null, pinSetAt: null })
		.where(eq(staffMembers.id, staffId))
	return 0
})
