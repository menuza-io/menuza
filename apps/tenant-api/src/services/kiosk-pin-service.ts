import crypto from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import {
	applyPinFailure,
	applyRefusedAttempt,
	applyPinSuccess,
	EMPTY_PIN_BACKOFF_STATE,
	normalizePinDigits,
	PERSON_PIN_LOCK,
	PIN_MAX_LENGTH,
	PIN_MIN_LENGTH,
	pinBackoffRemainingSeconds,
	pinLookupMessage,
	type PinBackoffState,
} from '@repo/staffing'
import {
	kioskAttempts,
	type KioskDevice,
	staffScopeAssignments,
	type StaffScopeAssignment,
	staffMembers,
	type StaffMember,
	type TenantDatabase,
	runTenantTransaction,
} from '@repo/tenant-db'
import { hmacHash } from '../lib/secrets.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { writeKioskAudit } from './staff-audit.ts'

/**
 * PIN verification for kiosk devices. A PIN is looked up by keyed hash scoped
 * to organization and scope, so two scopes may reuse a PIN and nobody
 * can read PINs back. Failure counters live in the organization database
 * (`kiosk_attempts`, plus the assignment row for pick-name mode) because the
 * in-process rate limiter resets per isolate and is shared by nothing.
 *
 * There is no whole-device lockout: past a few typos the device backs off for
 * an escalating delay (30 seconds up to 5 minutes) and every attempt made
 * during the delay is refused without looking at the PIN. In pick-name mode a
 * person is additionally locked after five wrong PINs, and only that person.
 */

export type PinVerified = {
	ok: true
	assignment: StaffScopeAssignment
	member: StaffMember
}
export type PinRejected =
	| { ok: false; code: 'invalid_pin'; retryAfterSeconds: number }
	| { ok: false; code: 'backoff'; retryAfterSeconds: number }
	| { ok: false; code: 'person_locked'; retryAfterSeconds: number }
export type PinResult = PinVerified | PinRejected

function rowToState(
	row: typeof kioskAttempts.$inferSelect | undefined,
): PinBackoffState {
	if (!row) return EMPTY_PIN_BACKOFF_STATE
	return {
		failures: row.failures,
		lastFailureAt: row.lastFailureAt,
		blockedUntil: row.blockedUntil,
		hourStartedAt: row.hourStartedAt,
		hourFailures: row.hourFailures,
		hourAlertedAt: row.hourAlertedAt,
	}
}

function lookupsMatch(left: string, right: string | null): boolean {
	if (right === null) return false
	const a = Buffer.from(left, 'utf8')
	const b = Buffer.from(right, 'utf8')
	return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** Digits normalized, 4 to 6 long; anything else can never match a stored PIN. */
export function pinShapeOk(pin: string): boolean {
	return (
		/^\d+$/.test(pin) &&
		pin.length >= PIN_MIN_LENGTH &&
		pin.length <= PIN_MAX_LENGTH
	)
}

export function pinLookupFor(orgId: string, scopeId: string, pin: string) {
	return hmacHash(pinLookupMessage(orgId, scopeId, pin))
}

/**
 * Verifies a PIN for a device. In PIN-only mode the PIN alone identifies the
 * person; in pick-name mode `staffId` names the person and the PIN must be
 * theirs. Counters are updated in the same transaction.
 */
export async function verifyKioskPin(
	db: TenantDatabase,
	input: {
		orgId: string
		device: KioskDevice
		pin: string
		staffId?: string
		ipHash: string | null
	},
	now = Date.now(),
): Promise<PinResult> {
	const pin = normalizePinDigits(input.pin)
	const { device } = input

	return retryOnSqliteBusy(() =>
		runTenantTransaction(db, async (tx): Promise<PinResult> => {
			const [attemptRow] = await tx
				.select()
				.from(kioskAttempts)
				.where(eq(kioskAttempts.deviceId, device.id))
				.limit(1)
			const state = rowToState(attemptRow)

			// While backing off, refuse everything without evaluating the PIN so a
			// guess made during the delay learns nothing and does not extend it.
			const wait = pinBackoffRemainingSeconds(state, now)
			if (wait > 0) {
				const refused = applyRefusedAttempt(state, now)
				await saveState(tx, device.id, refused.state, now)
				if (refused.alertManager) {
					await writeKioskAudit(tx, device, input.ipHash, {
						action: 'kiosk.pin.failures_high',
						entityType: 'kiosk_device',
						entityId: device.id,
						scopeId: device.scopeId,
						changes: { attemptsLastHour: refused.state.hourFailures },
					})
				}
				return { ok: false, code: 'backoff', retryAfterSeconds: wait }
			}

			const pickMode = device.identifyMode === 'pick_name'
			let candidate: StaffScopeAssignment | null = null
			let member: StaffMember | null = null

			if (pickMode) {
				if (input.staffId) {
					const [row] = await tx
						.select({
							assignment: staffScopeAssignments,
							member: staffMembers,
						})
						.from(staffScopeAssignments)
						.innerJoin(
							staffMembers,
							eq(staffMembers.id, staffScopeAssignments.staffId),
						)
						.where(
							and(
								eq(staffScopeAssignments.staffId, input.staffId),
								eq(staffScopeAssignments.scopeId, device.scopeId),
								eq(staffScopeAssignments.active, true),
								eq(staffMembers.status, 'active'),
							),
						)
						.limit(1)
					candidate = row?.assignment ?? null
					member = row?.member ?? null
				}
				if (
					candidate?.pinLockedUntil != null &&
					candidate.pinLockedUntil > now
				) {
					return {
						ok: false,
						code: 'person_locked',
						retryAfterSeconds: Math.ceil(
							(candidate.pinLockedUntil - now) / 1000,
						),
					}
				}
			}

			let matched = false
			if (pinShapeOk(pin)) {
				const lookup = pinLookupFor(input.orgId, device.scopeId, pin)
				if (pickMode) {
					matched = Boolean(
						candidate && lookupsMatch(lookup, candidate.pinLookup),
					)
				} else {
					const [row] = await tx
						.select({
							assignment: staffScopeAssignments,
							member: staffMembers,
						})
						.from(staffScopeAssignments)
						.innerJoin(
							staffMembers,
							eq(staffMembers.id, staffScopeAssignments.staffId),
						)
						.where(
							and(
								eq(staffScopeAssignments.scopeId, device.scopeId),
								eq(staffScopeAssignments.pinLookup, lookup),
								eq(staffScopeAssignments.active, true),
								eq(staffMembers.status, 'active'),
							),
						)
						.limit(1)
					if (row) {
						candidate = row.assignment
						member = row.member
						matched = true
					}
				}
			}

			if (matched && candidate && member) {
				const next = applyPinSuccess(state, now)
				await saveState(tx, device.id, next, now)
				if (
					pickMode &&
					(candidate.pinFailedCount > 0 || candidate.pinLockedUntil !== null)
				) {
					await tx
						.update(staffScopeAssignments)
						.set({ pinFailedCount: 0, pinLockedUntil: null })
						.where(eq(staffScopeAssignments.id, candidate.id))
				}
				return { ok: true, assignment: candidate, member }
			}

			const failure = applyPinFailure(state, now)
			await saveState(tx, device.id, failure.state, now)

			if (failure.delaySeconds > 0) {
				await writeKioskAudit(tx, device, input.ipHash, {
					action: 'kiosk.pin.backoff',
					entityType: 'kiosk_device',
					entityId: device.id,
					scopeId: device.scopeId,
					changes: {
						delaySeconds: failure.delaySeconds,
						failures: failure.state.failures,
					},
				})
			}
			if (failure.alertManager) {
				await writeKioskAudit(tx, device, input.ipHash, {
					action: 'kiosk.pin.failures_high',
					entityType: 'kiosk_device',
					entityId: device.id,
					scopeId: device.scopeId,
					changes: { failuresLastHour: failure.state.hourFailures },
				})
			}

			if (pickMode && candidate) {
				const failed = candidate.pinFailedCount + 1
				const lock = failed >= PERSON_PIN_LOCK.maxFailures
				await tx
					.update(staffScopeAssignments)
					.set({
						pinFailedCount: lock ? 0 : failed,
						pinLockedUntil: lock
							? now + PERSON_PIN_LOCK.lockSeconds * 1000
							: candidate.pinLockedUntil,
					})
					.where(eq(staffScopeAssignments.id, candidate.id))
				if (lock) {
					await writeKioskAudit(tx, device, input.ipHash, {
						action: 'kiosk.person.locked',
						entityType: 'staff_scope_assignment',
						entityId: candidate.id,
						staffId: candidate.staffId,
						scopeId: device.scopeId,
						changes: { lockSeconds: PERSON_PIN_LOCK.lockSeconds },
					})
					return {
						ok: false,
						code: 'person_locked',
						retryAfterSeconds: PERSON_PIN_LOCK.lockSeconds,
					}
				}
			}

			return {
				ok: false,
				code: 'invalid_pin',
				retryAfterSeconds: failure.delaySeconds,
			}
		}),
	)
}

async function saveState(
	tx: Parameters<Parameters<TenantDatabase['transaction']>[0]>[0],
	deviceId: string,
	state: PinBackoffState,
	now: number,
) {
	await tx
		.insert(kioskAttempts)
		.values({ deviceId, ...state, updatedAt: now })
		.onConflictDoUpdate({
			target: kioskAttempts.deviceId,
			set: { ...state, updatedAt: now },
		})
}
