import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	ne,
	or,
	sql,
} from 'drizzle-orm'
import {
	applyPinFailure,
	applyPinSuccess,
	applyRefusedAttempt,
	DEFAULT_SCOPE_ID,
	EMPTY_PIN_BACKOFF_STATE,
	normalizePinDigits,
	pinBackoffRemainingSeconds,
	type PinBackoffState,
} from '@repo/staffing'
import { POS_FISCAL_GENESIS_HASH, posFiscalHash } from '@repo/common/pos-fiscal'
import {
	formatPosDeviceSecret,
	formatPosPairingCode,
	posLineTotalCents,
	posStaffDisplayName,
	type PosStaff,
	POS_PAIRING_CODE_TTL_MS,
	posPairingCodeHashMessage,
	randomPosToken,
	type PosOrderRequest,
} from '@repo/common/pos-orders'
import {
	priceRestaurantOrder,
	restaurantOrderRequestSchema,
	type RestaurantOrderContext,
} from '@repo/common/restaurant-orders'
import {
	POS_DEFAULT_DAY_START_MINUTES,
	posCashMovements,
	posDevices,
	posFiscalDocuments,
	posHeldUploads,
	posHosts,
	posManagers,
	posOrderLines,
	posOrderRevisions,
	posOrders,
	posOrderTransfers,
	posPairingCodes,
	posPayments,
	posPinAttempts,
	posShifts,
	runTenantTransaction,
	staffMembers,
	staffScopeAssignments,
	type PosDevice,
	type PosOrderRow,
	type PosPaymentRow,
	type StaffMember,
	type StaffScopeAssignment,
	type TenantDatabase,
} from '@repo/tenant-db'
import { chunkIds, inJsonList } from '../lib/chunked-in.ts'
import { pinLookupFor, pinShapeOk } from './kiosk-pin-service.ts'
import { fetchOrderContext } from './order-service.ts'
import { hashPosSecret } from '../lib/pos-auth.ts'
import { hmacHash } from '../lib/secrets.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import {
	diffFields,
	writeDeviceAudit,
	writeOperatorAudit,
} from './staff-audit.ts'
import { revokeZatcaUnitsForDevice } from './zatca-service.ts'

/** Drizzle wraps driver errors; the SQLite message lives down the `cause` chain. */
function errorChain(error: unknown): string {
	const parts: string[] = []
	let current: unknown = error
	for (let depth = 0; depth < 5 && current; depth++) {
		parts.push(current instanceof Error ? current.message : String(current))
		current = (current as { cause?: unknown }).cause
	}
	return parts.join(' | ')
}

export const POS_TERMINAL_CODE = /^[A-Z0-9]{1,6}$/
/** Most unredeemed pairing codes an organization may hold at once. */
export const MAX_PENDING_POS_CODES = 10
const CODE_RETENTION_MS = 24 * 60 * 60 * 1000

export type PosFailure = {
	ok: false
	status: 400 | 403 | 404 | 409 | 422
	error: string
	message?: string
	/** Extra fields the terminal can act on (e.g. `nextNumber`). */
	extra?: Record<string, unknown>
}
export type PosResult<T> = { ok: true; value: T } | PosFailure
const ok = <T>(value: T): PosResult<T> => ({ ok: true, value })
const fail = (
	status: PosFailure['status'],
	error: string,
	message?: string,
	extra?: Record<string, unknown>,
): PosFailure => ({
	ok: false,
	status,
	error,
	...(message ? { message } : {}),
	...(extra ? { extra } : {}),
})

/**
 * The next free number for a terminal on a business day, in the shape the
 * terminal uses (`<prefix>-<zero padded counter>`). Offered when a terminal
 * whose counter was lost (site data cleared) collides with its own history.
 */
export async function nextFreeNumber(
	db: TenantDatabase,
	deviceId: string,
	businessDate: string,
	attempted: string,
): Promise<string> {
	const rows = await db
		.select({ number: posOrders.number })
		.from(posOrders)
		.where(
			and(
				eq(posOrders.deviceId, deviceId),
				eq(posOrders.businessDate, businessDate),
			),
		)
	const shape = /^(.*?)(\d+)$/.exec(attempted)
	const prefix = shape?.[1] ?? `${attempted}-`
	const width = shape?.[2]?.length ?? 4
	let highest = 0
	for (const { number } of rows) {
		const match = /(\d+)$/.exec(number)
		if (match && number.startsWith(prefix))
			highest = Math.max(highest, Number(match[1]))
	}
	return `${prefix}${String(highest + 1).padStart(width, '0')}`
}

const hashPairingCode = (code: string) =>
	hmacHash(posPairingCodeHashMessage(code))

/**
 * The organization's locations, from the same App catalog the menu check uses.
 * Null when it cannot be asked (App unreachable, or a site that is not
 * published yet): pairing then trusts the manager rather than failing.
 */
async function knownLocationIds(
	orgId: string,
	locationId: string,
): Promise<string[] | null> {
	const context = await fetchOrderContext(orgId, locationId, null)
	if (!context.ok) return null
	return context.data.menu.locations.map((l) => l.id)
}

/** True when App's menu says the location does not exist (unknown when App cannot answer). */
export async function isUnknownLocation(orgId: string, locationId: string) {
	const known = await knownLocationIds(orgId, locationId)
	return known !== null && !known.includes(locationId)
}

/**
 * Whether App's menu has the location, or `unavailable` when App cannot answer.
 * Binding a terminal is permanent, so it waits for an answer instead of trusting.
 */
export async function checkLocation(
	orgId: string,
	locationId: string,
): Promise<'known' | 'unknown' | 'unavailable'> {
	const known = await knownLocationIds(orgId, locationId)
	if (known === null) return 'unavailable'
	return known.includes(locationId) ? 'known' : 'unknown'
}

// ---------------------------------------------------------------------------
// Pairing and terminals
// ---------------------------------------------------------------------------

export async function createPairingCode(
	db: TenantDatabase,
	orgId: string,
	input: {
		label: string
		terminalCode: string
		locationId: string | null
		createdBy: string
		/** The workplace whose staff PINs sign in on this terminal. Default `main`. */
		scopeId?: string
		/** Lock the till until a staff member enters their PIN. Default on. */
		signInRequired?: boolean
		/** Minutes after midnight when the business day turns over. Default 04:00. */
		dayStartMinutes?: number
		/** Sell only inside a cash drawer shift. Default off. */
		shiftsRequired?: boolean
		/** Offer the time clock on this terminal. Default off. */
		timeclockEnabled?: boolean
		/** Offer the host stand on this terminal. Default off. */
		reservationsEnabled?: boolean
	},
	now = Date.now(),
): Promise<
	PosResult<{
		id: string
		code: string
		expiresAt: number
		terminalCode: string
	}>
> {
	const terminalCode = input.terminalCode.trim().toUpperCase()
	if (!POS_TERMINAL_CODE.test(terminalCode)) {
		return fail(422, 'invalid_terminal_code', 'Use 1 to 6 letters or digits.')
	}
	const scopeId = input.scopeId?.trim() || DEFAULT_SCOPE_ID
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(scopeId))
		return fail(422, 'invalid_scope', 'That workplace is not valid.')
	const reservationsProblem = stationReservationsProblem({
		reservationsEnabled: input.reservationsEnabled ?? false,
		locationId: input.locationId,
		signInRequired: input.signInRequired ?? true,
	})
	if (reservationsProblem)
		return fail(422, reservationsProblem.code, reservationsProblem.message)
	const dayStartMinutes = input.dayStartMinutes ?? POS_DEFAULT_DAY_START_MINUTES
	if (!isValidDayStart(dayStartMinutes)) {
		return fail(
			422,
			'invalid_day_start',
			'The business day must start between midnight and noon.',
		)
	}
	// Workplaces are opaque scopes with no registry of their own: one is real
	// when it is the default or someone is assigned to it. A typo would give a
	// terminal on which nobody can ever sign in.
	if (scopeId !== DEFAULT_SCOPE_ID) {
		const [assigned] = await db
			.select({ id: staffScopeAssignments.staffId })
			.from(staffScopeAssignments)
			.where(eq(staffScopeAssignments.scopeId, scopeId))
			.limit(1)
		if (!assigned)
			return fail(422, 'invalid_scope', 'That workplace is not valid.')
	}
	if (input.locationId !== null) {
		const known = await knownLocationIds(orgId, input.locationId)
		if (known && !known.includes(input.locationId)) {
			return fail(422, 'invalid_location', 'That location does not exist.')
		}
	}
	return runTenantTransaction(db, async (tx) => {
		// Spent and expired codes are noise: sweep them as we go.
		await tx
			.delete(posPairingCodes)
			.where(sql`${posPairingCodes.createdAt} < ${now - CODE_RETENTION_MS}`)

		const pending = await tx
			.select({
				id: posPairingCodes.id,
				terminalCode: posPairingCodes.terminalCode,
			})
			.from(posPairingCodes)
			.where(
				and(isNull(posPairingCodes.usedAt), gt(posPairingCodes.expiresAt, now)),
			)
		if (pending.length >= MAX_PENDING_POS_CODES) {
			return fail(
				409,
				'too_many_pending_codes',
				'Remove an unused pairing code first.',
			)
		}
		const [active] = await tx
			.select({ id: posDevices.id })
			.from(posDevices)
			.where(
				and(
					eq(posDevices.terminalCode, terminalCode),
					isNull(posDevices.revokedAt),
				),
			)
			.limit(1)
		if (active || pending.some((p) => p.terminalCode === terminalCode)) {
			return fail(
				409,
				'terminal_code_taken',
				`Terminal code ${terminalCode} is already in use.`,
			)
		}

		const code = formatPosPairingCode(orgId, randomPosToken())
		const id = crypto.randomUUID()
		const expiresAt = now + POS_PAIRING_CODE_TTL_MS
		await tx.insert(posPairingCodes).values({
			id,
			codeHash: hashPairingCode(code),
			label: input.label.trim() || terminalCode,
			terminalCode,
			locationId: input.locationId,
			scopeId,
			signInRequired: input.signInRequired ?? true,
			dayStartMinutes,
			shiftsRequired: input.shiftsRequired ?? false,
			timeclockEnabled: input.timeclockEnabled ?? false,
			reservationsEnabled: input.reservationsEnabled ?? false,
			createdBy: input.createdBy,
			expiresAt,
			createdAt: now,
		})
		return ok({ id, code, expiresAt, terminalCode })
	})
}

const REDEEM_FAILED = new Error('pairing code invalid')

export type RedeemedTerminal = {
	secret: string
	device: {
		id: string
		label: string
		terminalCode: string
		locationId: string | null
		scopeId: string
		signInRequired: boolean
		dayStartMinutes: number
		shiftsRequired: boolean
		timeclockEnabled: boolean
		reservationsEnabled: boolean
	}
}

/**
 * One-time redemption. Every failure (unknown, spent, expired, raced) is the
 * same `null`, so a code cannot be probed. The code is claimed first, so a lost
 * race leaves nothing behind.
 */
export async function redeemPairingCode(
	db: TenantDatabase,
	orgId: string,
	code: string,
	now = Date.now(),
): Promise<RedeemedTerminal | null> {
	const codeHash = hashPairingCode(code)
	const deviceId = crypto.randomUUID()
	const secret = formatPosDeviceSecret(orgId, deviceId, randomPosToken())
	try {
		return await retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const [row] = await tx
					.select()
					.from(posPairingCodes)
					.where(eq(posPairingCodes.codeHash, codeHash))
					.limit(1)
				if (!row || row.usedAt !== null || row.expiresAt <= now)
					throw REDEEM_FAILED
				const spent = await tx
					.update(posPairingCodes)
					.set({ usedAt: now, deviceId })
					.where(
						and(
							eq(posPairingCodes.id, row.id),
							isNull(posPairingCodes.usedAt),
							gt(posPairingCodes.expiresAt, now),
						),
					)
					.returning({ id: posPairingCodes.id })
				if (spent.length !== 1) throw REDEEM_FAILED
				await tx.insert(posDevices).values({
					id: deviceId,
					label: row.label,
					terminalCode: row.terminalCode,
					locationId: row.locationId,
					scopeId: row.scopeId,
					signInRequired: row.signInRequired,
					signInRequiredSince: row.signInRequired ? now : null,
					dayStartMinutes: row.dayStartMinutes,
					shiftsRequired: row.shiftsRequired,
					timeclockEnabled: row.timeclockEnabled,
					reservationsEnabled: row.reservationsEnabled,
					secretHash: hashPosSecret(secret),
					pairedBy: row.createdBy,
					pairedAt: now,
					lastSeenAt: now,
					createdAt: now,
				})
				return {
					secret,
					device: {
						id: deviceId,
						label: row.label,
						terminalCode: row.terminalCode,
						locationId: row.locationId,
						scopeId: row.scopeId,
						signInRequired: row.signInRequired,
						dayStartMinutes: row.dayStartMinutes,
						shiftsRequired: row.shiftsRequired,
						timeclockEnabled: row.timeclockEnabled,
						reservationsEnabled: row.reservationsEnabled,
					},
				}
			}),
		)
	} catch (error) {
		if (error === REDEEM_FAILED) return null
		// A terminal code claimed by another tablet between code and pairing.
		if (/UNIQUE/i.test(errorChain(error))) return null
		throw error
	}
}

export const serializeDevice = (row: PosDevice) => ({
	id: row.id,
	label: row.label,
	terminalCode: row.terminalCode,
	locationId: row.locationId,
	scopeId: row.scopeId,
	signInRequired: row.signInRequired,
	dayStartMinutes: row.dayStartMinutes,
	shiftsRequired: row.shiftsRequired,
	timeclockEnabled: row.timeclockEnabled,
	reservationsEnabled: row.reservationsEnabled,
	pairedAt: row.pairedAt,
	lastSeenAt: row.lastSeenAt,
	revokedAt: row.revokedAt,
})

export async function listDevices(db: TenantDatabase) {
	const rows = await db
		.select()
		.from(posDevices)
		.orderBy(asc(posDevices.createdAt))
	return rows.map(serializeDevice)
}

export async function listPendingCodes(db: TenantDatabase, now = Date.now()) {
	const rows = await db
		.select({
			id: posPairingCodes.id,
			label: posPairingCodes.label,
			terminalCode: posPairingCodes.terminalCode,
			expiresAt: posPairingCodes.expiresAt,
			timeclockEnabled: posPairingCodes.timeclockEnabled,
			reservationsEnabled: posPairingCodes.reservationsEnabled,
		})
		.from(posPairingCodes)
		.where(
			and(isNull(posPairingCodes.usedAt), gt(posPairingCodes.expiresAt, now)),
		)
		.orderBy(asc(posPairingCodes.createdAt))
	return rows
}

export async function revokePendingCode(
	db: TenantDatabase,
	id: string,
	now = Date.now(),
) {
	const result = await db
		.update(posPairingCodes)
		.set({ expiresAt: now })
		.where(and(eq(posPairingCodes.id, id), isNull(posPairingCodes.usedAt)))
		.returning({ id: posPairingCodes.id })
	return result.length === 1
}

/**
 * Removes a terminal. Its ZATCA unit is revoked in the same transaction, so a
 * removed till's signing key and certificate are never served or used again.
 */
export async function revokeDevice(
	db: TenantDatabase,
	id: string,
	revokedBy: string,
	now = Date.now(),
) {
	return retryOnSqliteBusy(() =>
		runTenantTransaction(db, async (tx) => {
			const result = await tx
				.update(posDevices)
				.set({ revokedAt: now, revokedBy })
				.where(and(eq(posDevices.id, id), isNull(posDevices.revokedAt)))
				.returning({ id: posDevices.id })
			if (result.length !== 1) return false
			await revokeZatcaUnitsForDevice(tx, id, now)
			return true
		}),
	)
}

// ---------------------------------------------------------------------------
// Staff sign-in
// ---------------------------------------------------------------------------

export type SignInResult =
	| {
			ok: true
			staff: PosStaff
			role: 'cashier' | 'manager'
			/** The person and their workplace assignment, for the time clock. */
			member: StaffMember
			assignment: StaffScopeAssignment
	  }
	| { ok: false; code: 'invalid_pin' | 'backoff'; retryAfterSeconds: number }

const toState = (
	row: typeof posPinAttempts.$inferSelect | undefined,
): PinBackoffState =>
	row
		? {
				failures: row.failures,
				lastFailureAt: row.lastFailureAt,
				blockedUntil: row.blockedUntil,
				hourStartedAt: row.hourStartedAt,
				hourFailures: row.hourFailures,
				hourAlertedAt: row.hourAlertedAt,
			}
		: EMPTY_PIN_BACKOFF_STATE

/**
 * Checks a staff PIN for a terminal, with the same rules as the kiosk: the PIN
 * alone names the person (it is looked up by keyed hash within the terminal's
 * workplace), wrong guesses slow the terminal down on an escalating delay
 * persisted in the organization database, and anything tried during the delay is
 * refused without being looked at. A terminal is never locked out outright.
 */
export async function verifyPosPin(
	db: TenantDatabase,
	input: { orgId: string; device: PosDevice; pin: string },
	now = Date.now(),
): Promise<SignInResult> {
	const pin = normalizePinDigits(input.pin)
	const { device } = input
	// Someone keeps guessing PINs at this terminal (its lock screen and its time
	// clock both take one): tell managers, as a kiosk does.
	const alertPinFailures = (
		tx: Parameters<Parameters<TenantDatabase['transaction']>[0]>[0],
		state: PinBackoffState,
	) =>
		writeDeviceAudit(tx, 'pos', device, null, {
			action: 'pos.pin.failures_high',
			entityType: 'pos_device',
			entityId: device.id,
			scopeId: device.scopeId,
			changes: { attemptsLastHour: state.hourFailures },
		})
	const save = async (
		tx: Parameters<Parameters<TenantDatabase['transaction']>[0]>[0],
		state: PinBackoffState,
	) => {
		await tx
			.insert(posPinAttempts)
			.values({ deviceId: device.id, ...state, updatedAt: now })
			.onConflictDoUpdate({
				target: posPinAttempts.deviceId,
				set: { ...state, updatedAt: now },
			})
	}
	return retryOnSqliteBusy(() =>
		runTenantTransaction(db, async (tx): Promise<SignInResult> => {
			const [attempt] = await tx
				.select()
				.from(posPinAttempts)
				.where(eq(posPinAttempts.deviceId, device.id))
				.limit(1)
			const state = toState(attempt)
			const wait = pinBackoffRemainingSeconds(state, now)
			if (wait > 0) {
				const refused = applyRefusedAttempt(state, now)
				await save(tx, refused.state)
				if (refused.alertManager) await alertPinFailures(tx, refused.state)
				return { ok: false, code: 'backoff', retryAfterSeconds: wait }
			}
			if (pinShapeOk(pin)) {
				const lookup = pinLookupFor(input.orgId, device.scopeId, pin)
				const [row] = await tx
					.select({
						member: staffMembers,
						assignment: staffScopeAssignments,
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
					await save(tx, applyPinSuccess(state, now))
					const [manager] = await tx
						.select({ id: posManagers.staffId })
						.from(posManagers)
						.where(eq(posManagers.staffId, row.member.id))
						.limit(1)
					return {
						ok: true,
						staff: {
							id: row.member.id,
							name: posStaffDisplayName(
								row.member.firstName,
								row.member.lastName,
							),
						},
						role: manager ? 'manager' : 'cashier',
						member: row.member,
						assignment: row.assignment,
					}
				}
			}
			const failure = applyPinFailure(state, now)
			await save(tx, failure.state)
			if (failure.alertManager) await alertPinFailures(tx, failure.state)
			return {
				ok: false,
				code: 'invalid_pin',
				retryAfterSeconds: failure.delaySeconds,
			}
		}),
	)
}

/** Everyone assigned to a workplace, whether they have a PIN yet, and who may manage a till. */
export async function listStaffRoster(db: TenantDatabase, scopeId: string) {
	const rows = await db
		.select({
			id: staffMembers.id,
			firstName: staffMembers.firstName,
			lastName: staffMembers.lastName,
			pinLookup: staffScopeAssignments.pinLookup,
		})
		.from(staffScopeAssignments)
		.innerJoin(staffMembers, eq(staffMembers.id, staffScopeAssignments.staffId))
		.where(
			and(
				eq(staffScopeAssignments.scopeId, scopeId),
				eq(staffScopeAssignments.active, true),
				eq(staffMembers.status, 'active'),
			),
		)
		.orderBy(asc(staffMembers.lastName), asc(staffMembers.firstName))
	const [managerRows, hostRows] = await Promise.all([
		db.select({ id: posManagers.staffId }).from(posManagers),
		db
			.select({ id: posHosts.staffId, guestDetails: posHosts.guestDetails })
			.from(posHosts),
	])
	const managers = new Set(managerRows.map((m) => m.id))
	const hosts = new Map(hostRows.map((m) => [m.id, m.guestDetails]))
	return rows.map((r) => ({
		id: r.id,
		name: posStaffDisplayName(r.firstName, r.lastName),
		hasPin: r.pinLookup !== null,
		isManager: managers.has(r.id),
		isHost: hosts.has(r.id),
		hostGuestDetails: hosts.get(r.id) === true,
	}))
}

export async function setManager(
	db: TenantDatabase,
	staffId: string,
	addedBy: string,
	now = Date.now(),
) {
	const [member] = await db
		.select({ id: staffMembers.id })
		.from(staffMembers)
		.where(and(eq(staffMembers.id, staffId), eq(staffMembers.status, 'active')))
		.limit(1)
	if (!member) return false
	await db
		.insert(posManagers)
		.values({ staffId, addedBy, addedAt: now })
		.onConflictDoNothing()
	return true
}

/** Puts a person on the host roster: they may run the host stand at a till. */
export async function setHost(
	db: TenantDatabase,
	staffId: string,
	addedBy: string,
	options: { guestDetails: boolean },
	now = Date.now(),
) {
	const [member] = await db
		.select({ id: staffMembers.id })
		.from(staffMembers)
		.where(and(eq(staffMembers.id, staffId), eq(staffMembers.status, 'active')))
		.limit(1)
	if (!member) return false
	const [before] = await db
		.select({ guestDetails: posHosts.guestDetails })
		.from(posHosts)
		.where(eq(posHosts.staffId, staffId))
		.limit(1)
	await db
		.insert(posHosts)
		.values({
			staffId,
			addedBy,
			addedAt: now,
			guestDetails: options.guestDetails,
		})
		.onConflictDoUpdate({
			target: posHosts.staffId,
			// Whoever changed the grant last answers for it.
			set: { guestDetails: options.guestDetails, addedBy, addedAt: now },
		})
	await writeOperatorAudit(db, addedBy, null, {
		action: before ? 'pos.host.changed' : 'pos.host.added',
		entityType: 'pos_host',
		entityId: staffId,
		staffId,
		changes: {
			guestDetails: {
				before: before?.guestDetails ?? null,
				after: options.guestDetails,
			},
		},
	})
	return true
}

export async function removeHost(
	db: TenantDatabase,
	staffId: string,
	removedBy: string,
) {
	const removed = await db
		.delete(posHosts)
		.where(eq(posHosts.staffId, staffId))
		.returning({ id: posHosts.staffId, guestDetails: posHosts.guestDetails })
	if (removed.length !== 1) return false
	await writeOperatorAudit(db, removedBy, null, {
		action: 'pos.host.removed',
		entityType: 'pos_host',
		entityId: staffId,
		staffId,
		changes: {
			guestDetails: { before: removed[0]!.guestDetails, after: null },
		},
	})
	return true
}

export async function removeManager(db: TenantDatabase, staffId: string) {
	const removed = await db
		.delete(posManagers)
		.where(eq(posManagers.staffId, staffId))
		.returning({ id: posManagers.staffId })
	return removed.length === 1
}

/** A business day turns over between midnight and noon, on any minute. */
export const isValidDayStart = (minutes: number) =>
	Number.isInteger(minutes) && minutes >= 0 && minutes <= 720

/**
 * The host stand shows guests to whoever holds the tablet, so it needs a
 * signed-in person, and it serves one location, so it needs the terminal's.
 */
export function stationReservationsProblem(settings: {
	reservationsEnabled: boolean
	locationId: string | null
	signInRequired: boolean
}): { code: string; message: string } | null {
	if (!settings.reservationsEnabled) return null
	if (!settings.locationId) {
		return {
			code: 'reservations_needs_location',
			message: 'Choose a location for this terminal to use reservations.',
		}
	}
	if (!settings.signInRequired) {
		return {
			code: 'reservations_needs_sign_in',
			message: 'Turn on staff sign-in to use reservations on this terminal.',
		}
	}
	return null
}

/** A terminal's location and host stand switch, for permission checks before a change. */
export async function deviceStationState(db: TenantDatabase, id: string) {
	const [device] = await db
		.select({
			locationId: posDevices.locationId,
			reservationsEnabled: posDevices.reservationsEnabled,
		})
		.from(posDevices)
		.where(and(eq(posDevices.id, id), isNull(posDevices.revokedAt)))
		.limit(1)
	return device ?? null
}

export type DeviceSettingsPatch = {
	signInRequired?: boolean
	dayStartMinutes?: number
	shiftsRequired?: boolean
	timeclockEnabled?: boolean
	reservationsEnabled?: boolean
	/**
	 * Binds a terminal that was paired without a location (so it can run that
	 * location's host stand). A bound terminal keeps its location: moving one
	 * would move its tabs, taxes and numbers, so it is paired again instead.
	 */
	locationId?: string
}

/** A manager changes how an existing terminal behaves; the till learns on its next check-in. */
export async function updateDeviceSettings(
	db: TenantDatabase,
	id: string,
	patch: DeviceSettingsPatch,
	now = Date.now(),
	/** The operator making the change, for the audit trail. */
	changedBy = 'unknown',
): Promise<PosResult<true>> {
	if (Object.values(patch).every((value) => value === undefined)) {
		return fail(400, 'invalid_request')
	}
	if (
		patch.dayStartMinutes !== undefined &&
		!isValidDayStart(patch.dayStartMinutes)
	)
		return fail(422, 'invalid_day_start')
	const [device] = await db
		.select({
			signInRequired: posDevices.signInRequired,
			locationId: posDevices.locationId,
			reservationsEnabled: posDevices.reservationsEnabled,
			timeclockEnabled: posDevices.timeclockEnabled,
		})
		.from(posDevices)
		.where(and(eq(posDevices.id, id), isNull(posDevices.revokedAt)))
		.limit(1)
	if (!device) return fail(404, 'not_found')
	if (patch.locationId !== undefined) {
		if (device.locationId !== null && device.locationId !== patch.locationId)
			return fail(
				409,
				'location_already_set',
				'Pair the terminal again to move it.',
			)
		if (!/^[A-Za-z0-9_-]{1,100}$/.test(patch.locationId))
			return fail(422, 'invalid_location')
	}
	const problem = stationReservationsProblem({
		reservationsEnabled:
			patch.reservationsEnabled ?? device.reservationsEnabled,
		locationId: patch.locationId ?? device.locationId,
		signInRequired: patch.signInRequired ?? device.signInRequired,
	})
	if (problem) return fail(422, problem.code, problem.message)
	const set: Partial<typeof posDevices.$inferInsert> = {}
	if (patch.signInRequired !== undefined) {
		set.signInRequired = patch.signInRequired
		// Orders rung up before sign-in was on are not expected to name anyone.
		if (patch.signInRequired && !device.signInRequired)
			set.signInRequiredSince = now
	}
	if (patch.dayStartMinutes !== undefined)
		set.dayStartMinutes = patch.dayStartMinutes
	if (patch.shiftsRequired !== undefined)
		set.shiftsRequired = patch.shiftsRequired
	if (patch.timeclockEnabled !== undefined) {
		set.timeclockEnabled = patch.timeclockEnabled
		// Punches the till saved offline before this still count; later ones do not.
		if (!patch.timeclockEnabled && device.timeclockEnabled)
			set.timeclockDisabledAt = now
	}
	if (patch.reservationsEnabled !== undefined)
		set.reservationsEnabled = patch.reservationsEnabled
	if (patch.locationId !== undefined && device.locationId === null) {
		set.locationId = patch.locationId
		set.locationBoundAt = now
	}
	await db.update(posDevices).set(set).where(eq(posDevices.id, id))
	const changes = diffFields(
		{
			signInRequired: device.signInRequired,
			timeclockEnabled: device.timeclockEnabled,
			reservationsEnabled: device.reservationsEnabled,
			locationId: device.locationId,
		} as Record<string, unknown>,
		{
			signInRequired: set.signInRequired,
			timeclockEnabled: set.timeclockEnabled,
			reservationsEnabled: set.reservationsEnabled,
			locationId: set.locationId,
		},
	)
	if (Object.keys(changes).length > 0)
		await writeOperatorAudit(db, changedBy, null, {
			action: 'pos.terminal.changed',
			entityType: 'pos_device',
			entityId: id,
			changes,
		})
	return ok(true)
}

const LAST_SEEN_THROTTLE_MS = 60_000
/** Guest first names and table notes typed at the till are cleared this long after the order closes. */
export const POS_GUEST_NAME_RETENTION_DAYS = 30
/** An open tab untouched this long is abandoned: its guest name and number are cleared. */
export const POS_ABANDONED_TAB_RETENTION_DAYS = 90

/**
 * Notes that a terminal is alive, at most once a minute, and uses that moment
 * for housekeeping that must happen even where no staff tick runs: guest names
 * past their retention period are cleared.
 */
export async function touchDevice(
	db: TenantDatabase,
	device: PosDevice,
	now = Date.now(),
) {
	if (
		device.lastSeenAt !== null &&
		now - device.lastSeenAt < LAST_SEEN_THROTTLE_MS
	)
		return
	await db
		.update(posDevices)
		.set({ lastSeenAt: now })
		.where(eq(posDevices.id, device.id))
	await purgePosGuestNames(db, now)
}

/**
 * Clears guest names and callback numbers past retention: on closed orders
 * `POS_GUEST_NAME_RETENTION_DAYS` after their last change, and on open tabs
 * nobody has touched for `POS_ABANDONED_TAB_RETENTION_DAYS` (a tab left open
 * on a lost or retired till). Never before a scheduled pickup. Runs on terminal
 * check-in and on the regional tick, so it also happens when POS is switched
 * off or every terminal was removed. Held uploads are tidied at the same time.
 */
export async function purgePosGuestNames(
	db: TenantDatabase,
	now = Date.now(),
): Promise<number> {
	const day = 24 * 60 * 60 * 1000
	const cutoff = now - POS_GUEST_NAME_RETENTION_DAYS * day
	const abandoned = now - POS_ABANDONED_TAB_RETENTION_DAYS * day
	const cleared = await db
		.update(posOrders)
		.set({ guestName: null, customerPhone: null })
		.where(
			and(
				or(isNotNull(posOrders.guestName), isNotNull(posOrders.customerPhone)),
				or(isNull(posOrders.pickupAt), lt(posOrders.pickupAt, cutoff)),
				or(
					and(ne(posOrders.status, 'open'), lt(posOrders.updatedAt, cutoff)),
					and(eq(posOrders.status, 'open'), lt(posOrders.updatedAt, abandoned)),
				),
			),
		)
		.returning({ id: posOrders.id })
	await purgePosHeldUploads(db, now)
	return cleared.length
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type PosReview = {
	reviewReason: string | null
	serverTotalCents: number | null
	locationName: string | null
}

/**
 * A till's menu older than this when it rang the sale up, or an upload that
 * arrives this long after the sale, may simply predate a menu change.
 */
const FRESH_MENU_MS = 10 * 60 * 1000

/**
 * Was a price difference likely a menu change the till had not seen yet (the
 * menu it sold from was old, or the sale reached us long after it was rung up),
 * rather than a till charging what the menu never said?
 */
export function driftMayBeMenuChange(
	order: PosOrderRequest,
	now: number,
): boolean {
	const rungUp = Date.parse(order.createdAt)
	if (now - rungUp > FRESH_MENU_MS) return true
	if (order.catalogFetchedAt === null) return true
	return rungUp - Date.parse(order.catalogFetchedAt) > FRESH_MENU_MS
}

/**
 * Reprices the sale against the live menu with the same engine online orders
 * use. The result never decides whether the sale is kept (the money has
 * already changed hands); it decides whether a person should look at it, and
 * says whether a difference is probably just a menu change (`stale_*`).
 */
export function reviewAgainstMenu(
	context: RestaurantOrderContext,
	order: PosOrderRequest,
	now: Date,
): PosReview {
	const location = context.menu.locations.find((l) => l.id === order.locationId)
	const locationName = location?.name ?? null
	const stale = driftMayBeMenuChange(order, now.getTime())
	const request = restaurantOrderRequestSchema.safeParse({
		idempotencyKey: order.id,
		locale: 'en',
		locationId: order.locationId,
		fulfillment: 'pickup',
		paymentMethod: 'handoff',
		contact: { name: 'Walk-in', phone: '+10000000000' },
		tipPercent: 0,
		lines: order.lines.map((line) => ({
			itemId: line.itemId,
			...(line.variantId ? { variantId: line.variantId } : {}),
			quantity: line.quantity,
			...(line.instructions ? { instructions: line.instructions } : {}),
			options: line.options.map((o) => ({
				groupId: o.groupId,
				optionId: o.optionId,
				...(o.quantity > 1 ? { quantity: o.quantity } : {}),
			})),
		})),
	})
	if (!request.success)
		return {
			reviewReason: 'unverifiable',
			serverTotalCents: null,
			locationName,
		}
	const priced = priceRestaurantOrder(context, request.data, {
		now,
		walkIn: true,
	})
	if (!priced.ok) {
		return {
			reviewReason: `${stale ? 'stale_catalog' : 'catalog'}:${priced.error.code}`,
			serverTotalCents: null,
			locationName,
		}
	}
	const server = priced.result
	// With adjustments (discounts) the server's tax is not comparable, so no total.
	const serverTotalCents =
		order.adjustments.length > 0 ? null : server.totalCents - server.tipCents
	const reasons: string[] = []
	if (server.subtotalCents !== order.totals.subtotalCents) {
		reasons.push(stale ? 'stale_price' : 'price_mismatch')
	} else if (
		order.adjustments.length === 0 &&
		server.taxCents !== order.totals.taxCents
	) {
		reasons.push(stale ? 'stale_tax' : 'tax_mismatch')
	}
	return { reviewReason: reasons[0] ?? null, serverTotalCents, locationName }
}

/** What is already stored for an order id, without taking a lock. */
export async function peekOrder(db: TenantDatabase, id: string) {
	const [row] = await db
		.select({
			revision: posOrders.revision,
			deviceId: posOrders.deviceId,
			status: posOrders.status,
			reviewReason: posOrders.reviewReason,
			serverTotalCents: posOrders.serverTotalCents,
			locationName: posOrders.locationName,
			lines: posOrders.lines,
			adjustments: posOrders.adjustments,
			subtotalCents: posOrders.subtotalCents,
			adjustmentCents: posOrders.adjustmentCents,
			taxCents: posOrders.taxCents,
			tipCents: posOrders.tipCents,
			totalCents: posOrders.totalCents,
		})
		.from(posOrders)
		.where(eq(posOrders.id, id))
		.limit(1)
	return row ?? null
}

/**
 * Whether a stored order's earlier menu check still holds for this upload: only
 * when the bill is exactly the one that was checked (lines, discounts and every
 * total). A later revision that keeps the lines but changes the tax, adds a
 * discount or lowers the total is checked again.
 */
export function billUnchanged(
	prior: NonNullable<Awaited<ReturnType<typeof peekOrder>>>,
	order: PosOrderRequest,
): boolean {
	return (
		canonicalJson(prior.lines) === canonicalJson(order.lines) &&
		canonicalJson(prior.adjustments) === canonicalJson(order.adjustments) &&
		prior.subtotalCents === order.totals.subtotalCents &&
		prior.adjustmentCents === order.totals.adjustmentCents &&
		prior.taxCents === order.totals.taxCents &&
		prior.tipCents === order.totals.tipCents &&
		prior.totalCents === order.totals.totalCents
	)
}

/** A discount above this share of the subtotal is shown to a manager. */
export const POS_LARGE_DISCOUNT_SHARE = 0.5

/**
 * Discounts carry no approver on the wire, so a large one (more than half the
 * bill) is flagged `large_discount` for a person to look at. The sale is kept.
 */
export function withDiscountCheck(
	review: PosReview,
	order: PosOrderRequest,
): PosReview {
	if (review.reviewReason) return review
	const { subtotalCents, adjustmentCents } = order.totals
	if (
		adjustmentCents > 0 &&
		adjustmentCents > subtotalCents * POS_LARGE_DISCOUNT_SHARE
	) {
		return { ...review, reviewReason: 'large_discount' }
	}
	return review
}

/** The sale is kept; nobody could check it against the menu yet, so a person is asked to look. */
export const unverifiedReview = (): PosReview => ({
	reviewReason: 'unverified',
	serverTotalCents: null,
	locationName: null,
})

const SKEW_FUTURE_MS = 5 * 60 * 1000
const SKEW_PAST_MS = 30 * 24 * 60 * 60 * 1000

/** A till clock that is wrong makes dates, ordering and reports wrong: say so rather than guess. */
export function withClockCheck(
	review: PosReview,
	order: PosOrderRequest,
	now = Date.now(),
): PosReview {
	if (review.reviewReason) return review
	const rungUp = Date.parse(order.createdAt)
	if (rungUp > now + SKEW_FUTURE_MS || rungUp < now - SKEW_PAST_MS) {
		return { ...review, reviewReason: 'clock_skew' }
	}
	return review
}

/** Everyone an order names: who rang it up, took or gave back money, removed items, cancelled or approved. */
function namedStaff(order: PosOrderRequest) {
	const people: Array<{ who: PosStaff; approver: boolean }> = []
	const add = (who: PosStaff | null, approver = false) => {
		if (who) people.push({ who, approver })
	}
	add(order.staff)
	add(order.voidedBy)
	add(order.voidApprovedBy, true)
	for (const p of order.payments) add(p.staff)
	for (const r of order.refunds) {
		add(r.by)
		add(r.approvedBy, true)
	}
	for (const v of order.lineVoids) {
		add(v.by)
		add(v.approvedBy, true)
	}
	return people
}

/**
 * The sale is kept either way; an order is flagged so a manager can see it when
 * it names someone this restaurant never had (a tampered till, a wrong roster),
 * someone no longer working at this terminal's workplace (an offline sign-in
 * after they left), an approval by someone who is not a till manager, or nobody
 * at all on a terminal that requires sign-in.
 */
export async function withStaffCheck(
	db: TenantDatabase,
	device: PosDevice,
	order: PosOrderRequest,
	review: PosReview,
): Promise<PosReview> {
	if (review.reviewReason) return review
	const flag = (reviewReason: string) => ({ ...review, reviewReason })
	if (
		device.signInRequired &&
		device.signInRequiredSince !== null &&
		Date.parse(order.createdAt) >= device.signInRequiredSince &&
		order.staff === null
	) {
		return flag('missing_staff')
	}
	const people = namedStaff(order)
	if (people.length === 0) return review
	const ids = [...new Set(people.map((p) => p.who.id))]
	const known = new Set<string>()
	const working = new Set<string>()
	for (const chunk of chunkIds(ids)) {
		const rows = await db
			.select({
				id: staffMembers.id,
				status: staffMembers.status,
				assignment: staffScopeAssignments.active,
			})
			.from(staffMembers)
			.leftJoin(
				staffScopeAssignments,
				and(
					eq(staffScopeAssignments.staffId, staffMembers.id),
					eq(staffScopeAssignments.scopeId, device.scopeId),
				),
			)
			.where(inArray(staffMembers.id, chunk))
		for (const row of rows) {
			known.add(row.id)
			if (row.status === 'active' && row.assignment === true)
				working.add(row.id)
		}
	}
	if (known.size !== ids.length) return flag('unknown_staff')
	if (working.size !== ids.length) return flag('inactive_staff')
	const approvers = [
		...new Set(people.filter((p) => p.approver).map((p) => p.who.id)),
	]
	if (approvers.length > 0) {
		const managers = await db
			.select({ id: posManagers.staffId })
			.from(posManagers)
			.where(inJsonList(posManagers.staffId, approvers))
		if (managers.length !== approvers.length)
			return flag('approver_not_manager')
	}
	return review
}

export type UpsertOutcome = {
	kind: 'created' | 'updated' | 'replay'
	order: PosOrderRow
	payments: PosPaymentRow[]
}

type Tx = Parameters<Parameters<TenantDatabase['transaction']>[0]>[0]

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** JSON with object keys sorted, so two copies of the same data compare equal. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.fromEntries(
					Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0,
					),
				)
			: v,
	)
}

/** Ids only for people, and no guest name: revision history is kept forever and holds no personal data. */
export function revisionSnapshot(order: PosOrderRequest) {
	const ref = (who: PosStaff | null) => (who ? { id: who.id } : null)
	return {
		...order,
		customerName: null,
		customerPhone: null,
		staff: ref(order.staff),
		voidedBy: ref(order.voidedBy),
		voidApprovedBy: ref(order.voidApprovedBy),
		payments: order.payments.map((p) => ({ ...p, staff: ref(p.staff) })),
		refunds: order.refunds.map((r) => ({
			...r,
			by: ref(r.by),
			approvedBy: ref(r.approvedBy),
		})),
		lineVoids: order.lineVoids.map((v) => ({
			...v,
			by: ref(v.by),
			approvedBy: ref(v.approvedBy),
		})),
	}
}

/** Append-only lists: everything stored must come back unchanged. */
function keepsEverything<T extends { id: string }>(stored: T[], incoming: T[]) {
	const byId = new Map(incoming.map((x) => [x.id, x]))
	return stored.every((x) => {
		const next = byId.get(x.id)
		return next !== undefined && same(next, x)
	})
}

const storedRefunds = (rows: PosPaymentRow[]) =>
	rows.filter((r) => r.kind === 'refund')
const storedPaymentsOnly = (rows: PosPaymentRow[]) =>
	rows.filter((r) => r.kind === 'payment')

/**
 * The devices that may write one terminal's fiscal chains: the terminal itself,
 * and the removed terminals it replaced (same terminal code and location). A
 * tablet removed and paired again gets a new device id but keeps its chain.
 */
async function fiscalLineage(tx: Tx, device: PosDevice): Promise<string[]> {
	const predecessors = await tx
		.select({ id: posDevices.id })
		.from(posDevices)
		.where(
			and(
				eq(posDevices.terminalCode, device.terminalCode),
				device.locationId === null
					? isNull(posDevices.locationId)
					: device.locationBoundAt !== null
						? // A till bound later chained on from its unbound predecessors.
							or(
								eq(posDevices.locationId, device.locationId),
								isNull(posDevices.locationId),
							)
						: eq(posDevices.locationId, device.locationId),
				isNotNull(posDevices.revokedAt),
			),
		)
		.orderBy(desc(posDevices.revokedAt))
		.limit(50)
	return [device.id, ...predecessors.map((p) => p.id)]
}

/**
 * Checks and stores the fiscal documents an upload carries. Nothing is refused:
 * a document that does not check out is kept with its problem, and the order is
 * flagged, because the sale and the till's record of it already exist.
 *
 * A chain belongs to the terminal that stored its first document (or one it
 * replaced). A document another terminal files under that chain is kept with
 * `chain_owner_mismatch` and never takes part in the owner's checks: the
 * previous, twin and successor lookups only see the owner's documents, and only
 * the owner's orders are ever flagged from here.
 */
async function storeFiscalDocuments(
	tx: Tx,
	device: PosDevice,
	order: PosOrderRequest,
	now: number,
): Promise<string | null> {
	let problem: string | null = null
	if (order.fiscal.length === 0) return problem
	const lineage = await fiscalLineage(tx, device)
	const ours = new Set(lineage)
	const owners = new Map<string, string | null>()
	const chainOwner = async (chainId: string) => {
		if (!owners.has(chainId)) {
			const [first] = await tx
				.select({ deviceId: posFiscalDocuments.deviceId })
				.from(posFiscalDocuments)
				.where(eq(posFiscalDocuments.chainId, chainId))
				.orderBy(
					asc(posFiscalDocuments.receivedAt),
					asc(posFiscalDocuments.counter),
				)
				.limit(1)
			owners.set(chainId, first?.deviceId ?? null)
		}
		return owners.get(chainId) ?? null
	}
	const inChain = (chainId: string, counter: number) =>
		and(
			eq(posFiscalDocuments.chainId, chainId),
			eq(posFiscalDocuments.counter, counter),
			// bounded: fiscalLineage returns at most 51 ids
			inArray(posFiscalDocuments.deviceId, lineage),
		)
	for (const doc of order.fiscal) {
		const { hash, ...unsigned } = doc
		const [stored] = await tx
			.select({
				hash: posFiscalDocuments.hash,
				deviceId: posFiscalDocuments.deviceId,
			})
			.from(posFiscalDocuments)
			.where(eq(posFiscalDocuments.docId, doc.docId))
			.limit(1)
		if (stored) {
			if (!ours.has(stored.deviceId)) problem ??= 'fiscal:chain_owner_mismatch'
			else if (stored.hash !== hash) problem ??= 'fiscal:document_changed'
			continue
		}
		let docProblem: string | null = null
		if (posFiscalHash(unsigned) !== hash) docProblem = 'hash_mismatch'
		const owner = await chainOwner(doc.chainId)
		const owned = owner === null || ours.has(owner)
		if (!owned) docProblem = 'chain_owner_mismatch'
		const [previous] =
			owned && doc.counter > 1
				? await tx
						.select({ hash: posFiscalDocuments.hash })
						.from(posFiscalDocuments)
						.where(inChain(doc.chainId, doc.counter - 1))
						.limit(1)
				: []
		// The first document starts from the genesis value; a later one must link to
		// its predecessor when the server already has it. (A predecessor that has not
		// arrived yet is not a break: offline tills upload out of order. It is checked
		// from the other side when it arrives, and gaps are listed by fiscalChainGaps.)
		if (
			!docProblem &&
			doc.counter === 1 &&
			doc.previousHash !== POS_FISCAL_GENESIS_HASH
		)
			docProblem = 'chain_break'
		if (!docProblem && previous && previous.hash !== doc.previousHash)
			docProblem = 'chain_break'
		if (!docProblem) {
			const [twin] = await tx
				.select({ docId: posFiscalDocuments.docId })
				.from(posFiscalDocuments)
				.where(inChain(doc.chainId, doc.counter))
				.limit(1)
			if (twin) docProblem = 'counter_reused'
		}
		await tx.insert(posFiscalDocuments).values({
			docId: doc.docId,
			chainId: doc.chainId,
			counter: doc.counter,
			kind: doc.kind,
			orderId: order.id,
			deviceId: device.id,
			issuedAt: Date.parse(doc.at),
			currency: doc.currency,
			totalCents: doc.totalCents,
			taxCents: doc.taxCents,
			previousHash: doc.previousHash,
			hash,
			problem: docProblem,
			receivedAt: now,
		})
		if (owner === null) owners.set(doc.chainId, device.id)
		if (docProblem) problem ??= `fiscal:${docProblem}`
		if (!owned) continue
		// A successor that arrived first and does not link to this document is a break too.
		const [successor] = await tx
			.select({
				previousHash: posFiscalDocuments.previousHash,
				orderId: posFiscalDocuments.orderId,
			})
			.from(posFiscalDocuments)
			.where(inChain(doc.chainId, doc.counter + 1))
			.limit(1)
		if (successor && successor.previousHash !== hash) {
			await tx
				.update(posOrders)
				.set({ reviewReason: 'fiscal:chain_break' })
				.where(
					and(
						eq(posOrders.id, successor.orderId),
						// bounded: fiscalLineage returns at most 51 ids
						inArray(posOrders.deviceId, lineage),
						isNull(posOrders.reviewReason),
					),
				)
		}
	}
	return problem
}

/**
 * Counters missing from each fiscal chain: documents a till numbered but the
 * server has never received. Only gaps older than `graceMs` are listed, since
 * an offline till may still be catching up.
 */
export async function fiscalChainGaps(
	db: TenantDatabase,
	now = Date.now(),
	graceMs = 24 * 60 * 60 * 1000,
) {
	const rows = await db
		.select({
			chainId: posFiscalDocuments.chainId,
			deviceId: posFiscalDocuments.deviceId,
			counter: posFiscalDocuments.counter,
			receivedAt: posFiscalDocuments.receivedAt,
		})
		.from(posFiscalDocuments)
		// A document filed under another terminal's chain is not part of it.
		.where(
			sql`coalesce(${posFiscalDocuments.problem}, '') != 'chain_owner_mismatch'`,
		)
		.orderBy(asc(posFiscalDocuments.chainId), asc(posFiscalDocuments.counter))
	const gaps: Array<{
		chainId: string
		deviceId: string
		missingFrom: number
		missingTo: number
	}> = []
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]!
		const previous = rows[i - 1]
		const expected =
			previous && previous.chainId === row.chainId ? previous.counter + 1 : 1
		if (row.counter > expected && now - row.receivedAt > graceMs) {
			gaps.push({
				chainId: row.chainId,
				deviceId: row.deviceId,
				missingFrom: expected,
				missingTo: row.counter - 1,
			})
		}
	}
	return gaps
}

/** Replaces the one-row-per-line copy of an order's current lines. */
async function writeOrderLines(tx: Tx, order: PosOrderRequest) {
	await tx.delete(posOrderLines).where(eq(posOrderLines.orderId, order.id))
	const rows = order.lines.map((line, lineIndex) => ({
		orderId: order.id,
		lineIndex,
		itemId: line.itemId,
		name: line.name,
		variantId: line.variantId,
		quantity: line.quantity,
		unitCents: posLineTotalCents(line) / line.quantity,
		totalCents: posLineTotalCents(line),
	}))
	// 8 columns a row against Durable Object SQLite's 100 bound parameters.
	for (const chunk of chunkIds(rows, 12))
		await tx.insert(posOrderLines).values(chunk)
}

/**
 * Stores one revision of a terminal's order. Idempotent and order-tolerant: a
 * replay or an older revision changes nothing and answers with what is stored.
 *
 * Money and history are append-only: payments, refunds and removed items can be
 * added but never altered or dropped; once a payment exists the bill is frozen;
 * a closed sale can only gain refunds. Every accepted revision is kept on
 * `pos_order_revisions`, so anything taken off a tab after it reached the server
 * stays visible. The first review reason found sticks.
 */
/**
 * An order the till started at a location it chose itself, before a manager
 * bound it to another one: its sale happened there, so it still uploads.
 */
function startedBeforeBinding(
	device: Pick<PosDevice, 'locationBoundAt' | 'pairedAt'>,
	order: Pick<PosOrderRequest, 'createdAt'>,
) {
	if (device.locationBoundAt === null) return false
	const startedAt = Date.parse(order.createdAt)
	// Between pairing and binding: a till cannot claim an earlier sale than it could have made.
	return (
		Number.isFinite(startedAt) &&
		startedAt >= device.pairedAt &&
		startedAt < device.locationBoundAt
	)
}

export async function upsertPosOrder(
	db: TenantDatabase,
	device: PosDevice,
	order: PosOrderRequest,
	review: PosReview,
	now = Date.now(),
): Promise<PosResult<UpsertOutcome>> {
	if (
		device.locationId &&
		device.locationId !== order.locationId &&
		!startedBeforeBinding(device, order)
	) {
		return fail(
			403,
			'wrong_location',
			'This terminal is paired to a different location.',
		)
	}
	try {
		return await retryOnSqliteBusy(() =>
			runTenantTransaction(
				db,
				async (tx): Promise<PosResult<UpsertOutcome>> => {
					const [existing] = await tx
						.select()
						.from(posOrders)
						.where(eq(posOrders.id, order.id))
						.limit(1)
					let continuesFrom: string | null = null
					const storedMoney = existing
						? await tx
								.select()
								.from(posPayments)
								.where(eq(posPayments.orderId, order.id))
						: []

					if (existing) {
						if (existing.deviceId !== device.id) {
							// A tab another terminal took over answers so, with where it went.
							const [moved] = await tx
								.select({ toDeviceId: posOrderTransfers.toDeviceId })
								.from(posOrderTransfers)
								.where(
									and(
										eq(posOrderTransfers.orderId, order.id),
										eq(posOrderTransfers.fromDeviceId, device.id),
									),
								)
								.orderBy(desc(posOrderTransfers.at))
								.limit(1)
							if (moved) {
								const [to] = await tx
									.select({
										terminalCode: posDevices.terminalCode,
										label: posDevices.label,
									})
									.from(posDevices)
									.where(eq(posDevices.id, moved.toDeviceId))
									.limit(1)
								return fail(
									409,
									'order_transferred',
									'Another terminal took this tab over.',
									{
										toTerminal: to ? `${to.label} (${to.terminalCode})` : null,
									},
								)
							}
							// A terminal that was removed and paired again (same terminal code
							// and location) continues its own tabs. Any other terminal takes a
							// tab over only through claimTab, which records the transfer.
							const [owner] = await tx
								.select({
									revokedAt: posDevices.revokedAt,
									terminalCode: posDevices.terminalCode,
									locationId: posDevices.locationId,
								})
								.from(posDevices)
								.where(eq(posDevices.id, existing.deviceId))
								.limit(1)
							if (!owner || owner.revokedAt === null) {
								return fail(
									409,
									'order_id_conflict',
									'This order id belongs to another terminal.',
								)
							}
							if (
								owner.terminalCode !== device.terminalCode ||
								owner.locationId !== device.locationId
							) {
								return fail(
									409,
									'order_owned_by_removed_terminal',
									'This tab belongs to a removed terminal. Take it over from the open tabs first.',
								)
							}
							continuesFrom = existing.deviceId
						}
						if (existing.revision >= order.revision) {
							// The current revision sent again must say the same thing. One
							// that differs is held for a person, not acknowledged as a replay
							// (the till would drop its copy of what it really sold). An older
							// revision arriving late is a plain replay.
							const [stored] =
								existing.revision !== order.revision
									? []
									: await tx
											.select({ snapshot: posOrderRevisions.snapshot })
											.from(posOrderRevisions)
											.where(
												and(
													eq(posOrderRevisions.orderId, order.id),
													eq(posOrderRevisions.revision, order.revision),
												),
											)
											.limit(1)
							if (
								existing.revision === order.revision &&
								stored &&
								canonicalJson(stored.snapshot) !==
									canonicalJson(revisionSnapshot(order))
							) {
								return fail(
									409,
									'revision_conflict',
									'This revision was already received with different contents.',
								)
							}
							return ok({
								kind: 'replay',
								order: existing,
								payments: storedMoney,
							})
						}
						if (
							existing.number !== order.number ||
							existing.businessDate !== order.businessDate
						) {
							return fail(
								409,
								'order_identity_changed',
								'An order keeps its number and day.',
							)
						}
						const payments = storedPaymentsOnly(storedMoney)
						const refunds = storedRefunds(storedMoney)
						const incomingPayments = new Map(
							order.payments.map((p) => [p.id, p]),
						)
						for (const stored of payments) {
							const p = incomingPayments.get(stored.id)
							if (
								!p ||
								p.amountCents !== stored.amountCents ||
								p.method !== stored.method ||
								p.tenderedCents !== stored.tenderedCents ||
								(p.reference ?? null) !== stored.reference
							) {
								return fail(
									409,
									'payments_changed',
									'Reported payments cannot be changed.',
								)
							}
						}
						const incomingRefunds = new Map(order.refunds.map((r) => [r.id, r]))
						for (const stored of refunds) {
							const r = incomingRefunds.get(stored.id)
							if (
								!r ||
								r.amountCents !== stored.amountCents ||
								r.paymentId !== stored.refundOf
							) {
								return fail(
									409,
									'refunds_changed',
									'Reported refunds cannot be changed.',
								)
							}
						}
						if (
							!keepsEverything(
								existing.lineVoids as PosOrderRequest['lineVoids'],
								order.lineVoids,
							)
						) {
							return fail(
								409,
								'line_voids_changed',
								'Items recorded as removed cannot be changed.',
							)
						}
						if (existing.status === 'void') {
							return fail(409, 'order_closed', 'This order is already closed.')
						}
						// Everything that defines the bill, not just its total.
						const billSame =
							same(existing.lines, order.lines) &&
							existing.subtotalCents === order.totals.subtotalCents &&
							existing.adjustmentCents === order.totals.adjustmentCents &&
							existing.taxCents === order.totals.taxCents &&
							existing.tipCents === order.totals.tipCents &&
							existing.totalCents === order.totals.totalCents &&
							existing.orderType === order.orderType &&
							existing.orderSource === order.orderSource &&
							existing.pickupAt ===
								(order.pickupAt ? Date.parse(order.pickupAt) : null) &&
							existing.pickupTimeZone === order.pickupTimeZone &&
							same(existing.adjustments, order.adjustments)
						if (existing.status === 'paid' || existing.status === 'refunded') {
							// A closed sale only ever gains refunds.
							const onlyRefunds =
								billSame &&
								(order.status === 'paid' || order.status === 'refunded') &&
								order.payments.length === payments.length &&
								order.lineVoids.length ===
									(existing.lineVoids as unknown[]).length
							if (!onlyRefunds)
								return fail(
									409,
									'order_closed',
									'This order is already closed.',
								)
						} else if (payments.length > 0 && !billSame) {
							return fail(
								409,
								'paid_order_changed',
								'A bill that has taken a payment cannot be edited.',
							)
						}
					}

					const rungUpAt = Date.parse(order.createdAt)
					const lastPayment = order.payments.reduce<number | null>(
						(latest, p) => Math.max(latest ?? 0, Date.parse(p.at)),
						null,
					)
					const lastRefund = order.refunds.reduce<number | null>(
						(latest, r) => Math.max(latest ?? 0, Date.parse(r.at)),
						null,
					)
					const fiscalProblem = await storeFiscalDocuments(
						tx,
						device,
						order,
						now,
					)
					const reviewReason =
						existing?.reviewReason ?? review.reviewReason ?? fiscalProblem
					// Once a phone contact has been erased or expired, a stale till
					// must not restore it when taking a payment or recording a refund.
					const contactRedacted =
						existing?.orderSource === 'phone' && existing.customerPhone === null
					const values = {
						deviceId: device.id,
						number: order.number,
						businessDate: order.businessDate,
						revision: order.revision,
						status: order.status,
						orderType: order.orderType,
						orderSource: order.orderSource,
						customerPhone: contactRedacted ? null : order.customerPhone,
						pickupAt: order.pickupAt ? Date.parse(order.pickupAt) : null,
						pickupTimeZone: order.pickupTimeZone,
						guestName: contactRedacted ? null : order.customerName || null,
						tableLabel: order.tableLabel || null,
						staffId: order.staff?.id ?? null,
						staffName: order.staff?.name ?? null,
						signIn: order.signIn,
						voidedByStaffId: order.voidedBy?.id ?? null,
						voidedByStaffName: order.voidedBy?.name ?? null,
						voidReason: order.voidReason,
						voidApprovedByStaffId: order.voidApprovedBy?.id ?? null,
						voidApprovedByStaffName: order.voidApprovedBy?.name ?? null,
						locationId: order.locationId,
						locationName: review.locationName ?? existing?.locationName ?? null,
						currency: order.currency,
						taxRatePercent: order.taxRatePercent,
						taxInclusive: order.taxInclusive,
						subtotalCents: order.totals.subtotalCents,
						adjustmentCents: order.totals.adjustmentCents,
						taxCents: order.totals.taxCents,
						tipCents: order.totals.tipCents,
						totalCents: order.totals.totalCents,
						refundedCents: order.refunds.reduce((s, r) => s + r.amountCents, 0),
						serverTotalCents:
							review.serverTotalCents ?? existing?.serverTotalCents ?? null,
						reviewReason,
						lines: order.lines,
						lineVoids: order.lineVoids,
						adjustments: order.adjustments,
						catalogFetchedAt: order.catalogFetchedAt
							? Date.parse(order.catalogFetchedAt)
							: null,
						shiftId: order.shiftId,
						updatedAt: now,
						paidAt:
							order.status === 'paid' || order.status === 'refunded'
								? (lastPayment ?? now)
								: null,
						voidedAt:
							order.status === 'void'
								? order.voidedAt
									? Date.parse(order.voidedAt)
									: now
								: null,
						refundedAt:
							order.status === 'refunded' ? (lastRefund ?? now) : null,
					}

					if (existing) {
						if (continuesFrom) {
							// The removed terminal's tab carries on here: say so in the
							// transfer history, as a claim would.
							await tx.insert(posOrderTransfers).values({
								orderId: order.id,
								fromDeviceId: continuesFrom,
								toDeviceId: device.id,
								revision: existing.revision,
								staffId: order.staff?.id ?? null,
								at: now,
							})
						}
						await tx
							.update(posOrders)
							.set(values)
							.where(eq(posOrders.id, order.id))
					} else {
						await tx
							.insert(posOrders)
							.values({ id: order.id, rungUpAt, receivedAt: now, ...values })
					}

					const known = new Set(storedMoney.map((p) => p.id))
					const freshRows = [
						...order.payments
							.filter((p) => !known.has(p.id))
							.map((p) => ({
								id: p.id,
								orderId: order.id,
								deviceId: device.id,
								kind: 'payment' as const,
								refundOf: null,
								staffId: p.staff?.id ?? null,
								staffName: p.staff?.name ?? null,
								approvedByStaffId: null,
								approvedByStaffName: null,
								reason: null,
								method: p.method,
								amountCents: p.amountCents,
								tenderedCents: p.tenderedCents,
								reference: p.reference ?? null,
								shiftId: p.shiftId ?? null,
								paidAt: Date.parse(p.at),
								receivedAt: now,
							})),
						...order.refunds
							.filter((r) => !known.has(r.id))
							.map((r) => ({
								id: r.id,
								orderId: order.id,
								deviceId: device.id,
								kind: 'refund' as const,
								refundOf: r.paymentId,
								staffId: r.by?.id ?? null,
								staffName: r.by?.name ?? null,
								approvedByStaffId: r.approvedBy?.id ?? null,
								approvedByStaffName: r.approvedBy?.name ?? null,
								reason: r.reason,
								method: r.method,
								amountCents: r.amountCents,
								tenderedCents: r.amountCents,
								reference: r.reference ?? null,
								shiftId: r.shiftId ?? null,
								paidAt: Date.parse(r.at),
								receivedAt: now,
							})),
					]
					// 17 columns a row against Durable Object SQLite's 100 bound parameters.
					for (const chunk of chunkIds(freshRows, 5))
						await tx.insert(posPayments).values(chunk)
					await writeOrderLines(tx, order)
					await tx.insert(posOrderRevisions).values({
						orderId: order.id,
						revision: order.revision,
						deviceId: device.id,
						reviewReason: review.reviewReason ?? fiscalProblem,
						snapshot: revisionSnapshot(order),
						receivedAt: now,
					})

					const [saved] = await tx
						.select()
						.from(posOrders)
						.where(eq(posOrders.id, order.id))
						.limit(1)
					const money = await tx
						.select()
						.from(posPayments)
						.where(eq(posPayments.orderId, order.id))
					return ok({
						kind: existing ? 'updated' : 'created',
						order: saved!,
						payments: money,
					})
				},
			),
		)
	} catch (error) {
		const message = errorChain(error)
		if (/UNIQUE/i.test(message) && message.includes('pos_orders.device_id')) {
			const nextNumber = await nextFreeNumber(
				db,
				device.id,
				order.businessDate,
				order.number,
			)
			return fail(
				409,
				'number_conflict',
				'This terminal already used that order number.',
				{ nextNumber },
			)
		}
		if (/UNIQUE/i.test(message) && message.includes('pos_payments.id')) {
			return fail(
				409,
				'payment_id_conflict',
				'A payment id was already used on another order.',
			)
		}
		throw error
	}
}

const staffRef = (id: string | null, name: string | null) =>
	id ? { id, name: name ?? '' } : null

export const serializePosOrder = (
	row: PosOrderRow,
	money: PosPaymentRow[],
) => ({
	id: row.id,
	number: row.number,
	businessDate: row.businessDate,
	revision: row.revision,
	status: row.status,
	orderType: row.orderType,
	orderSource: row.orderSource,
	customerPhone: row.customerPhone,
	pickupAt: row.pickupAt,
	pickupTimeZone: row.pickupTimeZone,
	guestName: row.guestName,
	tableLabel: row.tableLabel,
	staff: staffRef(row.staffId, row.staffName),
	signIn: row.signIn,
	voidedBy: staffRef(row.voidedByStaffId, row.voidedByStaffName),
	voidReason: row.voidReason,
	voidApprovedBy: staffRef(
		row.voidApprovedByStaffId,
		row.voidApprovedByStaffName,
	),
	locationId: row.locationId,
	locationName: row.locationName,
	currency: row.currency,
	taxInclusive: row.taxInclusive,
	subtotalCents: row.subtotalCents,
	adjustmentCents: row.adjustmentCents,
	taxCents: row.taxCents,
	tipCents: row.tipCents,
	totalCents: row.totalCents,
	refundedCents: row.refundedCents,
	serverTotalCents: row.serverTotalCents,
	reviewReason: row.reviewReason,
	lines: row.lines,
	lineVoids: row.lineVoids,
	rungUpAt: row.rungUpAt,
	receivedAt: row.receivedAt,
	paidAt: row.paidAt,
	voidedAt: row.voidedAt,
	refundedAt: row.refundedAt,
	deviceId: row.deviceId,
	payments: storedPaymentsOnly(money).map((p) => ({
		id: p.id,
		method: p.method,
		amountCents: p.amountCents,
		tenderedCents: p.tenderedCents,
		reference: p.reference,
		paidAt: p.paidAt,
		staff: staffRef(p.staffId, p.staffName),
	})),
	refunds: storedRefunds(money).map((r) => ({
		id: r.id,
		paymentId: r.refundOf,
		method: r.method,
		amountCents: r.amountCents,
		reason: r.reason,
		reference: r.reference,
		at: r.paidAt,
		by: staffRef(r.staffId, r.staffName),
		approvedBy: staffRef(r.approvedByStaffId, r.approvedByStaffName),
	})),
})

async function moneyFor(db: TenantDatabase, ids: string[]) {
	// Durable Object SQLite allows 100 bound parameters per statement.
	const rows: PosPaymentRow[] = []
	for (const chunk of chunkIds(ids)) {
		rows.push(
			...(await db
				.select()
				.from(posPayments)
				.where(inArray(posPayments.orderId, chunk))),
		)
	}
	return rows
}

export async function listPosOrders(
	db: TenantDatabase,
	options: {
		limit: number
		status?: PosOrderRow['status']
		needsReview?: boolean
		businessDate?: string
	},
) {
	const conditions = [] as ReturnType<typeof eq>[]
	if (options.status) conditions.push(eq(posOrders.status, options.status))
	if (options.businessDate)
		conditions.push(eq(posOrders.businessDate, options.businessDate))
	if (options.needsReview)
		conditions.push(sql`${posOrders.reviewReason} is not null`)
	const rows = await db
		.select()
		.from(posOrders)
		.where(conditions.length ? and(...conditions) : undefined)
		.orderBy(desc(posOrders.rungUpAt))
		.limit(options.limit)
	const money = await moneyFor(
		db,
		rows.map((r) => r.id),
	)
	return rows.map((row) =>
		serializePosOrder(
			row,
			money.filter((p) => p.orderId === row.id),
		),
	)
}

/** Every accepted revision of one order, oldest first (staff as ids only, no guest name). */
export async function listOrderRevisions(db: TenantDatabase, orderId: string) {
	return db
		.select()
		.from(posOrderRevisions)
		.where(eq(posOrderRevisions.orderId, orderId))
		.orderBy(asc(posOrderRevisions.revision))
}

// ---------------------------------------------------------------------------
// Taking a tab over from another terminal
// ---------------------------------------------------------------------------

/** The order as a terminal stores it, rebuilt from the server's copy (for a tab taken over). */
export function toTerminalOrder(row: PosOrderRow, money: PosPaymentRow[]) {
	return {
		id: row.id,
		revision: row.revision,
		status: row.status,
		number: row.number,
		businessDate: row.businessDate,
		createdAt: new Date(row.rungUpAt).toISOString(),
		locationId: row.locationId,
		currency: row.currency,
		taxRatePercent: row.taxRatePercent,
		taxInclusive: row.taxInclusive,
		orderType: row.orderType,
		orderSource: row.orderSource,
		customerPhone: row.customerPhone,
		pickupAt:
			row.pickupAt !== null ? new Date(row.pickupAt).toISOString() : null,
		pickupTimeZone: row.pickupTimeZone,
		customerName: row.guestName,
		tableLabel: row.tableLabel,
		staff: staffRef(row.staffId, row.staffName),
		signIn: row.signIn,
		lines: row.lines as PosOrderRequest['lines'],
		lineVoids: row.lineVoids as PosOrderRequest['lineVoids'],
		adjustments: row.adjustments as PosOrderRequest['adjustments'],
		totals: {
			subtotalCents: row.subtotalCents,
			adjustmentCents: row.adjustmentCents,
			taxCents: row.taxCents,
			tipCents: row.tipCents,
			totalCents: row.totalCents,
		},
		payments: storedPaymentsOnly(money).map((p) => ({
			id: p.id,
			method: p.method,
			amountCents: p.amountCents,
			tenderedCents: p.tenderedCents,
			at: new Date(p.paidAt).toISOString(),
			staff: staffRef(p.staffId, p.staffName),
			reference: p.reference,
		})),
	}
}

/**
 * Open tabs held by the other terminals of this terminal's location (or of
 * every location, for a terminal not bound to one), newest first. Tabs left on
 * a terminal that was removed (lost, broken) are included: that is when they
 * most need a new home.
 */
export async function listTransferableTabs(
	db: TenantDatabase,
	device: PosDevice,
) {
	const conditions = [
		eq(posOrders.status, 'open'),
		ne(posOrders.deviceId, device.id),
	]
	if (device.locationId)
		conditions.push(eq(posOrders.locationId, device.locationId))
	const rows = await db
		.select({
			order: posOrders,
			terminalCode: posDevices.terminalCode,
			terminalLabel: posDevices.label,
			revokedAt: posDevices.revokedAt,
		})
		.from(posOrders)
		.innerJoin(posDevices, eq(posDevices.id, posOrders.deviceId))
		.where(and(...conditions))
		.orderBy(desc(posOrders.rungUpAt))
		.limit(100)
	const money = await moneyFor(
		db,
		rows.map((r) => r.order.id),
	)
	return rows.map((r) => ({
		terminal: {
			code: r.terminalCode,
			label: r.terminalLabel,
			removed: r.revokedAt !== null,
		},
		order: toTerminalOrder(
			r.order,
			money.filter((p) => p.orderId === r.order.id),
		),
	}))
}

/**
 * Moves an open tab to this terminal. The claim names the revision the person
 * saw, so a tab that changed in the meantime is not taken over blind. The old
 * terminal learns of the move on its next check-in; anything it uploads for the
 * tab afterwards is held for review rather than applied.
 */
export async function claimTab(
	db: TenantDatabase,
	device: PosDevice,
	input: { orderId: string; revision: number; staffId: string | null },
	now = Date.now(),
): Promise<PosResult<ReturnType<typeof toTerminalOrder>>> {
	try {
		return await retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const [row] = await tx
					.select()
					.from(posOrders)
					.where(eq(posOrders.id, input.orderId))
					.limit(1)
				if (!row)
					return fail(404, 'not_found', 'That tab is not on the server.')
				if (row.deviceId === device.id) {
					const money = await tx
						.select()
						.from(posPayments)
						.where(eq(posPayments.orderId, row.id))
					return ok(toTerminalOrder(row, money))
				}
				if (row.status !== 'open')
					return fail(409, 'order_closed', 'That tab is already closed.')
				if (device.locationId && device.locationId !== row.locationId) {
					return fail(
						403,
						'wrong_location',
						'That tab belongs to another location.',
					)
				}
				if (row.revision !== input.revision) {
					return fail(
						409,
						'tab_changed',
						'That tab changed. Look at it again before taking it over.',
						{
							revision: row.revision,
						},
					)
				}
				await tx
					.update(posOrders)
					.set({ deviceId: device.id, updatedAt: now })
					.where(eq(posOrders.id, row.id))
				await tx.insert(posOrderTransfers).values({
					orderId: row.id,
					fromDeviceId: row.deviceId,
					toDeviceId: device.id,
					revision: row.revision,
					staffId: input.staffId,
					at: now,
				})
				const money = await tx
					.select()
					.from(posPayments)
					.where(eq(posPayments.orderId, row.id))
				return ok(toTerminalOrder({ ...row, deviceId: device.id }, money))
			}),
		)
	} catch (error) {
		// This terminal already issued the same number on that day.
		if (/UNIQUE/i.test(errorChain(error))) {
			return fail(
				409,
				'number_conflict',
				'This terminal already has an order with that number today.',
			)
		}
		throw error
	}
}

/** Tabs taken away from this terminal recently, so it stops showing them as its own. */
export async function recentTransfersAway(
	db: TenantDatabase,
	deviceId: string,
	now = Date.now(),
) {
	const since = now - 7 * 24 * 60 * 60 * 1000
	const rows = await db
		.select({
			orderId: posOrderTransfers.orderId,
			terminalCode: posDevices.terminalCode,
		})
		.from(posOrderTransfers)
		.innerJoin(posDevices, eq(posDevices.id, posOrderTransfers.toDeviceId))
		.where(
			and(
				eq(posOrderTransfers.fromDeviceId, deviceId),
				gt(posOrderTransfers.at, since),
			),
		)
		.orderBy(desc(posOrderTransfers.at))
		.limit(200)
	return rows
}

// ---------------------------------------------------------------------------
// Fiscal chain heads
// ---------------------------------------------------------------------------

/**
 * The last document of each chain this terminal uploaded, newest chain first.
 * A till whose local storage was lost continues its chain from here instead of
 * starting a second chain over the same counters.
 */
export async function fiscalChainHeads(db: TenantDatabase, deviceId: string) {
	const rows = await db
		.select({
			chainId: posFiscalDocuments.chainId,
			counter: posFiscalDocuments.counter,
			hash: posFiscalDocuments.hash,
			receivedAt: posFiscalDocuments.receivedAt,
		})
		.from(posFiscalDocuments)
		.where(
			and(
				eq(posFiscalDocuments.deviceId, deviceId),
				// Only this terminal's own documents: one another terminal filed under
				// its chain (chain_owner_mismatch) must not hide or move its head.
				sql`coalesce(${posFiscalDocuments.problem}, '') != 'chain_owner_mismatch'`,
				sql`${posFiscalDocuments.counter} = (select max(d.counter) from pos_fiscal_documents d where d.chain_id = ${posFiscalDocuments.chainId} and d.device_id = ${deviceId} and coalesce(d.problem, '') != 'chain_owner_mismatch')`,
			),
		)
		.orderBy(desc(posFiscalDocuments.receivedAt))
		.limit(5)
	return rows.map(({ chainId, counter, hash }) => ({ chainId, counter, hash }))
}

// ---------------------------------------------------------------------------
// Held uploads
// ---------------------------------------------------------------------------

/** Unsettled held uploads one terminal may pile up before it is asked to wait. */
export const MAX_HELD_PER_DEVICE = 1000
/** Unsettled held uploads a whole organization may hold (all terminals together). */
export const MAX_HELD_PER_ORG = 5000
/** Unsettled uploads that were not even JSON one terminal may pile up. */
export const MAX_UNREADABLE_HELD_PER_DEVICE = 20
export const MAX_HELD_PAYLOAD_CHARS = 64_000
const MAX_UNREADABLE_PAYLOAD_CHARS = 4_000
/** Settled held uploads are deleted this long after a person settled them. */
export const POS_HELD_RESOLVED_RETENTION_DAYS = 30

/** Keys that hold a person (`{ id, name }`): only the id is kept in held payloads. */
const HELD_STAFF_KEYS = new Set([
	'staff',
	'by',
	'approvedBy',
	'voidedBy',
	'voidApprovedBy',
	'openedBy',
	'closedBy',
])
/** Keys a cashier types a guest into: never kept in held payloads. */
const HELD_GUEST_KEYS = new Set([
	'customerName',
	'customerPhone',
	'guestName',
	'tableLabel',
])

function stripPeople(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripPeople)
	if (!value || typeof value !== 'object') return value
	const out: Record<string, unknown> = {}
	for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
		if (HELD_GUEST_KEYS.has(key)) out[key] = null
		else if (
			HELD_STAFF_KEYS.has(key) &&
			v &&
			typeof v === 'object' &&
			!Array.isArray(v) &&
			typeof (v as { id?: unknown }).id === 'string'
		)
			out[key] = { id: (v as { id: string }).id }
		else out[key] = stripPeople(v)
	}
	return out
}

const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"?`
const GUEST_FIELD = new RegExp(
	String.raw`("(?:${[...HELD_GUEST_KEYS].join('|')})"\s*:\s*)${JSON_STRING}`,
	'g',
)
const STAFF_NAME = new RegExp(
	String.raw`("(?:${[...HELD_STAFF_KEYS].join('|')})"\s*:\s*\{\s*"id"\s*:\s*${JSON_STRING})\s*,\s*"name"\s*:\s*${JSON_STRING}`,
	'g',
)

/**
 * A held upload as it may be kept: held records outlive guest retention and are
 * not reached by erasure, so they hold no guest name, callback number or table
 * note, and staff only as ids (the bill and the money stay, for review). A body
 * that is not JSON is redacted by pattern and cut short.
 */
export function redactHeldPayload(payload: string): {
	payload: string
	readable: boolean
} {
	let parsed: unknown
	try {
		parsed = JSON.parse(payload)
	} catch {
		return {
			payload: payload
				.replace(GUEST_FIELD, '$1null')
				.replace(STAFF_NAME, '$1')
				.slice(0, MAX_UNREADABLE_PAYLOAD_CHARS),
			readable: false,
		}
	}
	let stripped = stripPeople(parsed)
	let text = JSON.stringify(stripped)
	if (
		text.length > MAX_HELD_PAYLOAD_CHARS &&
		stripped &&
		typeof stripped === 'object'
	) {
		// Signed ZATCA XML is the bulk of a large upload and is not needed to
		// settle it by hand; the document hashes stay.
		const fiscal = (stripped as { fiscal?: unknown }).fiscal
		if (Array.isArray(fiscal)) {
			stripped = {
				...(stripped as Record<string, unknown>),
				fiscal: fiscal.map((doc) =>
					doc && typeof doc === 'object' && (doc as { zatca?: unknown }).zatca
						? {
								...(doc as Record<string, unknown>),
								zatca: {
									...(doc as { zatca: Record<string, unknown> }).zatca,
									xml: null,
								},
							}
						: doc,
				),
			}
			text = JSON.stringify(stripped)
		}
	}
	return { payload: text.slice(0, MAX_HELD_PAYLOAD_CHARS), readable: true }
}

/**
 * Keeps an upload the server could not apply, redacted, for a person to settle.
 * Returns false when this terminal or the organization already has too many
 * waiting (the till retries later).
 */
export async function holdUpload(
	db: TenantDatabase,
	device: PosDevice,
	input: {
		orderId: string | null
		revision: number | null
		error: string
		message: string | null
		contractVersion: number | null
		payload: string
	},
	now = Date.now(),
): Promise<boolean> {
	const { payload, readable } = redactHeldPayload(input.payload)
	const unsettled = and(
		eq(posHeldUploads.deviceId, device.id),
		isNull(posHeldUploads.resolvedAt),
	)
	// The same upload held twice (a till retrying) is kept once.
	const [twin] = await db
		.select({ id: posHeldUploads.id })
		.from(posHeldUploads)
		.where(
			and(
				unsettled,
				input.orderId
					? eq(posHeldUploads.orderId, input.orderId)
					: isNull(posHeldUploads.orderId),
				eq(posHeldUploads.error, input.error),
				eq(posHeldUploads.payload, payload),
			),
		)
		.limit(1)
	if (twin) return true
	const [count] = await db
		.select({ n: sql<number>`count(*)` })
		.from(posHeldUploads)
		.where(unsettled)
	if ((count?.n ?? 0) >= MAX_HELD_PER_DEVICE) return false
	if (!readable) {
		const [unreadable] = await db
			.select({ n: sql<number>`count(*)` })
			.from(posHeldUploads)
			.where(and(unsettled, isNull(posHeldUploads.orderId)))
		if ((unreadable?.n ?? 0) >= MAX_UNREADABLE_HELD_PER_DEVICE) return false
	}
	const [orgCount] = await db
		.select({ n: sql<number>`count(*)` })
		.from(posHeldUploads)
		.where(isNull(posHeldUploads.resolvedAt))
	if ((orgCount?.n ?? 0) >= MAX_HELD_PER_ORG) return false
	await db.insert(posHeldUploads).values({
		deviceId: device.id,
		orderId: input.orderId,
		revision: input.revision,
		error: input.error,
		message: input.message,
		contractVersion: input.contractVersion,
		payload,
		receivedAt: now,
	})
	return true
}

/**
 * Held-upload housekeeping for the regional tick: settled records are deleted
 * after `POS_HELD_RESOLVED_RETENTION_DAYS`, and any record still carrying a
 * guest's details (kept before payloads were redacted on arrival) is redacted.
 * Unsettled records stay until a person settles them: they hold a sale.
 */
export async function purgePosHeldUploads(
	db: TenantDatabase | Tx,
	now = Date.now(),
): Promise<{ deleted: number; redacted: number }> {
	const cutoff = now - POS_HELD_RESOLVED_RETENTION_DAYS * 24 * 60 * 60 * 1000
	const deleted = await db
		.delete(posHeldUploads)
		.where(
			and(
				isNotNull(posHeldUploads.resolvedAt),
				lt(posHeldUploads.resolvedAt, cutoff),
			),
		)
		.returning({ id: posHeldUploads.id })
	const redacted = await redactHeldUploadsWhere(
		db,
		or(
			...[...HELD_GUEST_KEYS].map(
				(key) => sql`${posHeldUploads.payload} like ${`%"${key}":"%`}`,
			),
		),
	)
	return { deleted: deleted.length, redacted }
}

/** Redacts the held payloads a condition selects (in pages); returns how many changed. */
async function redactHeldUploadsWhere(
	db: TenantDatabase | Tx,
	condition: ReturnType<typeof or>,
): Promise<number> {
	let changed = 0
	let after = ''
	for (;;) {
		const rows = await db
			.select({ id: posHeldUploads.id, payload: posHeldUploads.payload })
			.from(posHeldUploads)
			.where(and(condition, gt(posHeldUploads.id, after)))
			.orderBy(asc(posHeldUploads.id))
			.limit(200)
		for (const row of rows) {
			const { payload } = redactHeldPayload(row.payload)
			if (payload === row.payload) continue
			await db
				.update(posHeldUploads)
				.set({ payload })
				.where(eq(posHeldUploads.id, row.id))
			changed++
		}
		if (rows.length < 200) return changed
		after = rows[rows.length - 1]!.id
	}
}

/**
 * Erasure of a person (customer or staff): held payloads are redacted on
 * arrival, so this only catches a record kept before that, one naming the
 * person by id or by phone digits.
 */
export async function erasePosHeldUploads(
	tx: TenantDatabase | Tx,
	identifiers: string[],
): Promise<number> {
	const terms = identifiers.filter((t) => t.length >= 4)
	if (terms.length === 0) return 0
	return redactHeldUploadsWhere(
		tx,
		or(
			...terms.map(
				(term) => sql`${posHeldUploads.payload} like ${`%${term}%`}`,
			),
		),
	)
}

export async function listHeldUploads(
	db: TenantDatabase,
	options: { limit: number; includeResolved?: boolean },
) {
	const rows = await db
		.select({
			id: posHeldUploads.id,
			deviceId: posHeldUploads.deviceId,
			terminalCode: posDevices.terminalCode,
			terminalLabel: posDevices.label,
			orderId: posHeldUploads.orderId,
			revision: posHeldUploads.revision,
			error: posHeldUploads.error,
			message: posHeldUploads.message,
			contractVersion: posHeldUploads.contractVersion,
			payload: posHeldUploads.payload,
			receivedAt: posHeldUploads.receivedAt,
			resolvedAt: posHeldUploads.resolvedAt,
			resolvedBy: posHeldUploads.resolvedBy,
		})
		.from(posHeldUploads)
		.leftJoin(posDevices, eq(posDevices.id, posHeldUploads.deviceId))
		.where(
			options.includeResolved ? undefined : isNull(posHeldUploads.resolvedAt),
		)
		.orderBy(desc(posHeldUploads.receivedAt))
		.limit(options.limit)
	return rows
}

export async function countHeldUploads(db: TenantDatabase) {
	const [row] = await db
		.select({ n: sql<number>`count(*)` })
		.from(posHeldUploads)
		.where(isNull(posHeldUploads.resolvedAt))
	return row?.n ?? 0
}

/** A person settled a held upload (entered the sale by hand, or confirmed it is a duplicate). */
export async function resolveHeldUpload(
	db: TenantDatabase,
	id: string,
	by: string,
	now = Date.now(),
) {
	const updated = await db
		.update(posHeldUploads)
		.set({ resolvedAt: now, resolvedBy: by })
		.where(and(eq(posHeldUploads.id, id), isNull(posHeldUploads.resolvedAt)))
		.returning({ id: posHeldUploads.id })
	return updated.length === 1
}

// ---------------------------------------------------------------------------
// Erasing a person
// ---------------------------------------------------------------------------

/**
 * Replaces an erased staff member's name wherever the till recorded it. The ids
 * stay (they point at the pseudonymous staff row); revision history holds ids
 * only, so it needs no change.
 */
export async function erasePosStaffNames(
	tx: Tx,
	staffId: string,
	replacement: string,
) {
	await tx
		.update(posOrders)
		.set({ staffName: replacement })
		.where(eq(posOrders.staffId, staffId))
	await tx
		.update(posOrders)
		.set({ voidedByStaffName: replacement })
		.where(eq(posOrders.voidedByStaffId, staffId))
	await tx
		.update(posOrders)
		.set({ voidApprovedByStaffName: replacement })
		.where(eq(posOrders.voidApprovedByStaffId, staffId))
	await tx
		.update(posPayments)
		.set({ staffName: replacement })
		.where(eq(posPayments.staffId, staffId))
	await tx
		.update(posPayments)
		.set({ approvedByStaffName: replacement })
		.where(eq(posPayments.approvedByStaffId, staffId))
	await tx
		.update(posShifts)
		.set({ openedByStaffName: replacement })
		.where(eq(posShifts.openedByStaffId, staffId))
	await tx
		.update(posShifts)
		.set({ closedByStaffName: replacement })
		.where(eq(posShifts.closedByStaffId, staffId))
	await tx
		.update(posCashMovements)
		.set({ staffName: replacement })
		.where(eq(posCashMovements.staffId, staffId))
	await tx
		.update(posCashMovements)
		.set({ approvedByStaffName: replacement })
		.where(eq(posCashMovements.approvedByStaffId, staffId))
	const withVoids = await tx
		.select({ id: posOrders.id, lineVoids: posOrders.lineVoids })
		.from(posOrders)
		.where(sql`${posOrders.lineVoids} like ${`%${JSON.stringify(staffId)}%`}`)
	for (const row of withVoids) {
		const rename = (who: PosStaff | null) =>
			who && who.id === staffId ? { ...who, name: replacement } : who
		const lineVoids = (row.lineVoids as PosOrderRequest['lineVoids']).map(
			(v) => ({
				...v,
				by: rename(v.by),
				approvedBy: rename(v.approvedBy),
			}),
		)
		await tx
			.update(posOrders)
			.set({ lineVoids })
			.where(eq(posOrders.id, row.id))
	}
	// Held payloads keep staff as ids only; this catches one kept before that.
	await erasePosHeldUploads(tx, [staffId])
}
