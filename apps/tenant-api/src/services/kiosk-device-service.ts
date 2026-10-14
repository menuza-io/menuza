import { and, asc, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import {
	formatKioskDeviceSecret,
	formatKioskPairingCode,
	KIOSK_PAIRING_CODE_TTL_MS,
	kioskPairingCodeHashMessage,
	kioskPairingFragment,
	type KioskConfig,
	type KioskDeviceUpdate,
	type KioskPairingCodeCreate,
	pinBackoffRemainingSeconds,
	randomKioskToken,
} from '@repo/staffing'
import {
	kioskAttempts,
	type KioskAttempt,
	kioskDevices,
	type KioskDevice,
	kioskPairingCodes,
	type KioskPairingCode,
	type TenantDatabase,
} from '@repo/tenant-db'
import { hashKioskSecret } from '../lib/kiosk-auth.ts'
import { getScopeFacts } from '../lib/scope-context.ts'
import { getNodeRegion } from '../lib/region.ts'
import { hmacHash } from '../lib/secrets.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { type ScopeAccess, type StaffAuth } from '../lib/staff-auth.ts'
import { resolvePolicy } from './labor-policy-service.ts'
import {
	type StaffDb,
	writeKioskAudit,
	writeStaffAudit,
} from './staff-audit.ts'

/** Most unredeemed pairing codes one scope may hold at a time. */
export const MAX_PENDING_PAIRING_CODES = 10
/** Spent and expired codes are removed after this long. */
const CODE_RETENTION_MS = 24 * 60 * 60 * 1000

export type DeviceFailure = {
	ok: false
	status: 400 | 403 | 404 | 409 | 422
	error: string
	extra?: Record<string, unknown>
}
export type DeviceResult<T> = { ok: true; value: T } | DeviceFailure

const ok = <T>(value: T): DeviceResult<T> => ({ ok: true, value })
const fail = (
	status: DeviceFailure['status'],
	error: string,
	extra?: Record<string, unknown>,
): DeviceFailure => ({ ok: false, status, error, ...(extra ? { extra } : {}) })

export type DeviceContext = {
	db: TenantDatabase
	auth: StaffAuth
	scope: ScopeAccess
	ipHash: string | null
}

function hashPairingCode(code: string): string {
	return hmacHash(kioskPairingCodeHashMessage(code))
}

/** The wire shape of a device: never the secret hash, never counters beyond state. */
export function serializeDevice(
	row: KioskDevice,
	attempts: KioskAttempt | null,
	now: number,
) {
	const hourlyFailures =
		attempts?.hourStartedAt != null && now - attempts.hourStartedAt < 3_600_000
			? attempts.hourFailures
			: 0
	return {
		id: row.id,
		scopeId: row.scopeId,
		name: row.name,
		identifyMode: row.identifyMode,
		showNextShifts: row.showNextShifts,
		pairedAt: row.pairedAt,
		lastSeenAt: row.lastSeenAt,
		revokedAt: row.revokedAt,
		status: row.revokedAt === null ? ('active' as const) : ('revoked' as const),
		backoffSeconds: attempts ? pinBackoffRemainingSeconds(attempts, now) : 0,
		failuresLastHour: hourlyFailures,
	}
}

export function serializePendingCode(row: KioskPairingCode) {
	return {
		id: row.id,
		scopeId: row.scopeId,
		deviceName: row.deviceName,
		identifyMode: row.identifyMode,
		showNextShifts: row.showNextShifts,
		expiresAt: row.expiresAt,
		createdAt: row.createdAt,
	}
}

// ---------------------------------------------------------------------------
// Manager side
// ---------------------------------------------------------------------------

/**
 * Creates a one-time pairing code (10 minutes, stored only as a keyed hash).
 * The plaintext is in the result once and nowhere else.
 */
export async function createPairingCode(
	ctx: DeviceContext,
	input: KioskPairingCodeCreate,
	now = Date.now(),
): Promise<
	DeviceResult<{
		id: string
		code: string
		expiresAt: number
		scopeId: string
		deviceName: string
		/** The fragment for the pairing URL; it never reaches a server. */
		fragment: string
	}>
> {
	if (!ctx.scope.allows(input.scopeId)) return fail(404, 'not_found')

	// Control-plane facts win; the policy or the manager's own value is the
	// fallback so pairing still works if the App is unreachable.
	const facts = await getScopeFacts(ctx.auth.orgId, input.scopeId, now)
	const policy = await resolvePolicy(ctx.db, input.scopeId)
	const timeZone = facts?.timeZone ?? policy.timeZone ?? input.timeZone ?? null
	if (!timeZone) return fail(422, 'time_zone_required')
	const scopeName = facts?.name ?? input.scopeName ?? null

	const code = formatKioskPairingCode(ctx.auth.orgId, randomKioskToken())
	const id = crypto.randomUUID()
	const expiresAt = now + KIOSK_PAIRING_CODE_TTL_MS

	const result = await retryOnSqliteBusy(() =>
		ctx.db.transaction(async (tx): Promise<DeviceResult<null>> => {
			await tx
				.delete(kioskPairingCodes)
				.where(lt(kioskPairingCodes.expiresAt, now - CODE_RETENTION_MS))
			const [pending] = await tx
				.select({ n: sql<number>`count(*)` })
				.from(kioskPairingCodes)
				.where(
					and(
						eq(kioskPairingCodes.scopeId, input.scopeId),
						isNull(kioskPairingCodes.usedAt),
						gt(kioskPairingCodes.expiresAt, now),
					),
				)
			if (Number(pending?.n ?? 0) >= MAX_PENDING_PAIRING_CODES) {
				return fail(409, 'too_many_pending_codes')
			}
			await tx.insert(kioskPairingCodes).values({
				id,
				codeHash: hashPairingCode(code),
				scopeId: input.scopeId,
				deviceName: input.deviceName,
				identifyMode: input.identifyMode,
				showNextShifts: input.showNextShifts,
				timeZone,
				scopeName,
				createdBy: ctx.auth.userId,
				expiresAt,
				createdAt: now,
			})
			await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
				action: 'kiosk.pairing_code.created',
				entityType: 'kiosk_pairing_code',
				entityId: id,
				scopeId: input.scopeId,
				changes: {
					deviceName: input.deviceName,
					identifyMode: input.identifyMode,
					expiresAt,
				},
			})
			return ok(null)
		}),
	)
	if (!result.ok) return result

	return ok({
		id,
		code,
		expiresAt,
		scopeId: input.scopeId,
		deviceName: input.deviceName,
		fragment: kioskPairingFragment(getNodeRegion(), code),
	})
}

export async function listPendingPairingCodes(
	ctx: DeviceContext,
	now = Date.now(),
) {
	const rows = await ctx.db
		.select()
		.from(kioskPairingCodes)
		.where(
			and(
				isNull(kioskPairingCodes.usedAt),
				gt(kioskPairingCodes.expiresAt, now),
				ctx.scope.where(kioskPairingCodes.scopeId),
			),
		)
		.orderBy(asc(kioskPairingCodes.expiresAt))
	return rows.map(serializePendingCode)
}

export async function cancelPairingCode(
	ctx: DeviceContext,
	id: string,
): Promise<DeviceResult<{ cancelled: true }>> {
	return retryOnSqliteBusy(() =>
		ctx.db.transaction(
			async (tx): Promise<DeviceResult<{ cancelled: true }>> => {
				const [row] = await tx
					.select()
					.from(kioskPairingCodes)
					.where(eq(kioskPairingCodes.id, id))
					.limit(1)
				if (!row || !ctx.scope.allows(row.scopeId))
					return fail(404, 'not_found')
				if (row.usedAt !== null) return fail(409, 'already_used')
				await tx.delete(kioskPairingCodes).where(eq(kioskPairingCodes.id, id))
				await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
					action: 'kiosk.pairing_code.cancelled',
					entityType: 'kiosk_pairing_code',
					entityId: id,
					scopeId: row.scopeId,
				})
				return ok({ cancelled: true as const })
			},
		),
	)
}

export async function listDevices(ctx: DeviceContext, now = Date.now()) {
	const rows = await ctx.db
		.select({ device: kioskDevices, attempts: kioskAttempts })
		.from(kioskDevices)
		.leftJoin(kioskAttempts, eq(kioskAttempts.deviceId, kioskDevices.id))
		.where(ctx.scope.where(kioskDevices.scopeId))
		.orderBy(asc(kioskDevices.pairedAt))
	return rows.map(({ device, attempts }) =>
		serializeDevice(device, attempts, now),
	)
}

async function loadScopedDevice(
	db: StaffDb,
	scope: ScopeAccess,
	id: string,
): Promise<KioskDevice | null> {
	const [row] = await db
		.select()
		.from(kioskDevices)
		.where(eq(kioskDevices.id, id))
		.limit(1)
	return row && scope.allows(row.scopeId) ? row : null
}

export async function updateDevice(
	ctx: DeviceContext,
	id: string,
	patch: KioskDeviceUpdate,
	now = Date.now(),
): Promise<DeviceResult<ReturnType<typeof serializeDevice>>> {
	return retryOnSqliteBusy(() =>
		ctx.db.transaction(async (tx) => {
			const row = await loadScopedDevice(tx, ctx.scope, id)
			if (!row) return fail(404, 'not_found')
			if (row.revokedAt !== null) return fail(409, 'device_revoked')

			const changes: Record<string, { before: unknown; after: unknown }> = {}
			const next: Partial<KioskDevice> = {}
			if (patch.name !== undefined && patch.name !== row.name) {
				changes.name = { before: row.name, after: patch.name }
				next.name = patch.name
			}
			if (
				patch.identifyMode !== undefined &&
				patch.identifyMode !== row.identifyMode
			) {
				changes.identifyMode = {
					before: row.identifyMode,
					after: patch.identifyMode,
				}
				next.identifyMode = patch.identifyMode
			}
			if (
				patch.showNextShifts !== undefined &&
				patch.showNextShifts !== row.showNextShifts
			) {
				changes.showNextShifts = {
					before: row.showNextShifts,
					after: patch.showNextShifts,
				}
				next.showNextShifts = patch.showNextShifts
			}
			let updated = row
			if (Object.keys(changes).length > 0) {
				const [saved] = await tx
					.update(kioskDevices)
					.set({ ...next, updatedAt: now })
					.where(eq(kioskDevices.id, id))
					.returning()
				updated = saved!
				await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
					action: 'kiosk.device.updated',
					entityType: 'kiosk_device',
					entityId: id,
					scopeId: row.scopeId,
					changes,
				})
			}
			const [attempts] = await tx
				.select()
				.from(kioskAttempts)
				.where(eq(kioskAttempts.deviceId, id))
				.limit(1)
			return ok(serializeDevice(updated, attempts ?? null, now))
		}),
	)
}

/**
 * Revokes a device immediately. Idempotent. Always allowed, even when the
 * kiosk kill switch is on: revoking is the safe direction.
 */
export async function revokeDevice(
	ctx: DeviceContext,
	id: string,
	now = Date.now(),
): Promise<DeviceResult<ReturnType<typeof serializeDevice>>> {
	return retryOnSqliteBusy(() =>
		ctx.db.transaction(async (tx) => {
			const row = await loadScopedDevice(tx, ctx.scope, id)
			if (!row) return fail(404, 'not_found')
			let updated = row
			if (row.revokedAt === null) {
				const [saved] = await tx
					.update(kioskDevices)
					.set({ revokedAt: now, revokedBy: ctx.auth.userId, updatedAt: now })
					.where(eq(kioskDevices.id, id))
					.returning()
				updated = saved!
				await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
					action: 'kiosk.device.revoked',
					entityType: 'kiosk_device',
					entityId: id,
					scopeId: row.scopeId,
				})
			}
			const [attempts] = await tx
				.select()
				.from(kioskAttempts)
				.where(eq(kioskAttempts.deviceId, id))
				.limit(1)
			return ok(serializeDevice(updated, attempts ?? null, now))
		}),
	)
}

// ---------------------------------------------------------------------------
// Device side
// ---------------------------------------------------------------------------

const REDEEM_FAILED = Symbol('redeem_failed')

/**
 * Exchanges a pairing code for a device secret. The code is spent in the same
 * transaction that creates the device, using a conditional update, so two
 * simultaneous redemptions cannot both succeed. Unknown, spent and expired
 * codes are indistinguishable to the caller.
 */
export async function redeemPairingCode(
	db: TenantDatabase,
	orgId: string,
	code: string,
	ipHash: string | null,
	now = Date.now(),
): Promise<{ secret: string; config: KioskConfig } | null> {
	const codeHash = hashPairingCode(code)
	const deviceId = crypto.randomUUID()
	const secret = formatKioskDeviceSecret(orgId, deviceId, randomKioskToken())

	try {
		return await retryOnSqliteBusy(() =>
			db.transaction(async (tx) => {
				const [row] = await tx
					.select()
					.from(kioskPairingCodes)
					.where(eq(kioskPairingCodes.codeHash, codeHash))
					.limit(1)
				if (!row || row.usedAt !== null || row.expiresAt <= now) {
					throw REDEEM_FAILED
				}

				// Claim the code first. On runtimes where an async transaction is not
				// rolled back as a whole, a lost race then leaves nothing behind.
				const spent = await tx
					.update(kioskPairingCodes)
					.set({ usedAt: now, deviceId })
					.where(
						and(
							eq(kioskPairingCodes.id, row.id),
							isNull(kioskPairingCodes.usedAt),
							gt(kioskPairingCodes.expiresAt, now),
						),
					)
					.returning({ id: kioskPairingCodes.id })
				if (spent.length !== 1) throw REDEEM_FAILED

				await tx.insert(kioskDevices).values({
					id: deviceId,
					scopeId: row.scopeId,
					name: row.deviceName,
					secretHash: hashKioskSecret(secret),
					identifyMode: row.identifyMode,
					showNextShifts: row.showNextShifts,
					timeZone: row.timeZone,
					scopeName: row.scopeName,
					pairedBy: row.createdBy,
					pairedAt: now,
					lastSeenAt: now,
					lastSeenIpHash: ipHash,
					createdAt: now,
					updatedAt: now,
				})

				await writeKioskAudit(tx, { id: deviceId }, ipHash, {
					action: 'kiosk.device.paired',
					entityType: 'kiosk_device',
					entityId: deviceId,
					scopeId: row.scopeId,
					changes: { deviceName: row.deviceName, pairedBy: row.createdBy },
				})

				return {
					secret,
					config: {
						device: {
							id: deviceId,
							name: row.deviceName,
							scopeId: row.scopeId,
							identifyMode: row.identifyMode,
							showNextShifts: row.showNextShifts,
						},
						scope: { name: row.scopeName, timeZone: row.timeZone },
						serverNow: now,
					},
				}
			}),
		)
	} catch (error) {
		if (error === REDEEM_FAILED) return null
		throw error
	}
}

/** Records that the device was seen, at most once a minute, to bound write load. */
export async function touchDevice(
	db: StaffDb,
	device: KioskDevice,
	ipHash: string | null,
	now = Date.now(),
) {
	if (device.lastSeenAt !== null && now - device.lastSeenAt < 60_000) return
	await db
		.update(kioskDevices)
		.set({ lastSeenAt: now, lastSeenIpHash: ipHash })
		.where(eq(kioskDevices.id, device.id))
}
