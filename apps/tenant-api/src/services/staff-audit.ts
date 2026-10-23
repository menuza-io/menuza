import { type Context } from 'hono'
import {
	staffAuditLog,
	type StaffAuditLogEntry,
	type TenantDatabase,
} from '@repo/tenant-db'
import { resolveClientIp } from '../lib/rate-limit.ts'
import { hmacHash } from '../lib/secrets.ts'
import { type StaffAuth } from '../lib/staff-auth.ts'

/** A tenant database handle or an open transaction on one. */
export type StaffDb =
	TenantDatabase | Parameters<Parameters<TenantDatabase['transaction']>[0]>[0]

export type StaffAuditEvent = {
	/** Dotted verb, for example `staff.created` or `staff.pay.read`. */
	action: string
	entityType: string
	entityId?: string | null
	staffId?: string | null
	scopeId?: string | null
	/**
	 * `pay` and `private` rows carry money or personal values and are only
	 * returned to readers holding the matching grant.
	 */
	sensitivity?: 'standard' | 'pay' | 'private'
	/** Field-level `{ before, after }` pairs, or a small summary object. */
	changes?: Record<string, unknown> | null
}

/**
 * A log-safe description of a failure. Drizzle's query error message quotes the
 * SQL statement and every bound parameter, which for staff routes means names,
 * contact details, wages and PIN lookups, so it is never logged. The driver's
 * own root-cause message (for example "UNIQUE constraint failed: table.column")
 * names columns but carries no values.
 */
export function describeStaffError(error: unknown): string {
	if (!(error instanceof Error)) return 'Unknown error'
	let root: Error = error
	while ((root as { cause?: unknown }).cause instanceof Error) {
		root = (root as { cause: Error }).cause
	}
	if (root === error && ('params' in error || 'query' in error)) {
		return 'Database query failed'
	}
	return `${root.name}: ${root.message}`.slice(0, 300)
}

/** Salted, keyed hash of the caller IP; the raw address is never stored. */
export function hashClientIp(c: Pick<Context, 'req'>): string | null {
	try {
		const ip = resolveClientIp(c as Context)
		if (!ip || ip === 'unknown') return null
		return hmacHash(`staff-audit-ip:${ip}`)
	} catch {
		// AUTH_HMAC_SECRET is asserted at startup; never fail a request over the
		// IP hash alone.
		return null
	}
}

/**
 * Appends one audit row. Callers pass the open transaction of the mutation so
 * a write can never commit without its audit row. For reads, callers await this
 * before returning data and fail the request if it throws: private and pay data
 * is never disclosed without a trail.
 */
export async function writeStaffAudit(
	db: StaffDb,
	auth: StaffAuth,
	ipHash: string | null,
	event: StaffAuditEvent,
): Promise<void> {
	await db.insert(staffAuditLog).values({
		actorKind: auth.actorKind ?? 'operator',
		actorId: auth.userId,
		impersonated: auth.impersonated,
		action: event.action,
		entityType: event.entityType,
		entityId: event.entityId ?? null,
		staffId: event.staffId ?? null,
		scopeId: event.scopeId ?? null,
		sensitivity: event.sensitivity ?? 'standard',
		changes: event.changes ?? null,
		ipHash,
	})
}

/**
 * Appends an audit row for an operator change made through a route that has no
 * staff token (the POS terminals page: host roster, Station app switches).
 */
export async function writeOperatorAudit(
	db: StaffDb,
	operatorId: string,
	ipHash: string | null,
	event: StaffAuditEvent,
) {
	await db.insert(staffAuditLog).values({
		actorKind: 'operator',
		actorId: operatorId,
		impersonated: false,
		action: event.action,
		entityType: event.entityType,
		entityId: event.entityId ?? null,
		staffId: event.staffId ?? null,
		scopeId: event.scopeId ?? null,
		sensitivity: event.sensitivity ?? 'standard',
		changes: event.changes ?? null,
		ipHash,
	})
}

/** Actor id recorded for changes made by the control plane, not an operator. */
export const SYSTEM_ACTOR_ID = 'control-plane'

/**
 * Appends an audit row for a change the control plane made on its own (linking
 * a login, erasure). It carries no operator and no client address.
 */
export async function writeSystemAudit(db: StaffDb, event: StaffAuditEvent) {
	await db.insert(staffAuditLog).values({
		actorKind: 'system',
		actorId: SYSTEM_ACTOR_ID,
		impersonated: false,
		action: event.action,
		entityType: event.entityType,
		entityId: event.entityId ?? null,
		staffId: event.staffId ?? null,
		scopeId: event.scopeId ?? null,
		sensitivity: event.sensitivity ?? 'standard',
		changes: event.changes ?? null,
		ipHash: null,
	})
}

/**
 * Appends an audit row for something a paired kiosk device did or suffered
 * (pairing, punch rejections, PIN backoff). The actor is the device id, never
 * a person; a device holds no operator identity.
 */
export async function writeKioskAudit(
	db: StaffDb,
	device: { id: string },
	ipHash: string | null,
	event: StaffAuditEvent,
) {
	await writeDeviceAudit(db, 'kiosk', device, ipHash, event)
}

/** An event recorded by a paired tablet: a time-clock kiosk or a Station terminal. */
export async function writeDeviceAudit(
	db: StaffDb,
	actorKind: 'kiosk' | 'pos',
	device: { id: string },
	ipHash: string | null,
	event: StaffAuditEvent,
) {
	await db.insert(staffAuditLog).values({
		actorKind,
		actorId: device.id,
		impersonated: false,
		action: event.action,
		entityType: event.entityType,
		entityId: event.entityId ?? null,
		staffId: event.staffId ?? null,
		scopeId: event.scopeId ?? null,
		sensitivity: event.sensitivity ?? 'standard',
		changes: event.changes ?? null,
		ipHash,
	})
}

/** Field-level before/after for the fields that actually changed. */
export function diffFields<T extends Record<string, unknown>>(
	before: T,
	after: Partial<T>,
): Record<string, { before: unknown; after: unknown }> {
	const out: Record<string, { before: unknown; after: unknown }> = {}
	for (const [key, next] of Object.entries(after)) {
		if (next === undefined) continue
		const previous = before[key]
		if (previous !== next) out[key] = { before: previous ?? null, after: next }
	}
	return out
}

/** Which audit sensitivities a token may read back. */
export function readableSensitivities(auth: {
	grants: readonly string[]
}): Array<'standard' | 'pay' | 'private'> {
	const has = (read: string, update: string) =>
		auth.grants.includes(read) || auth.grants.includes(update)
	const out: Array<'standard' | 'pay' | 'private'> = ['standard']
	if (has('read:staff_pay:any', 'update:staff_pay:any')) out.push('pay')
	if (has('read:staff_private:any', 'update:staff_private:any')) {
		out.push('private')
	}
	return out
}

export type { StaffAuditLogEntry }
