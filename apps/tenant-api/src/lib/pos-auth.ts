import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { type Context } from 'hono'
import { ENV } from 'varlock/env'
import {
	parsePosDeviceSecret,
	posSecretHashMessage,
} from '@repo/common/pos-orders'
import {
	getTenantDb,
	posDevices,
	type PosDevice,
	type TenantDatabase,
} from '@repo/tenant-db'
import { getBearerToken, hmacHash, syncEnvFromProcess } from './secrets.ts'

/**
 * POS terminal principal. A paired tablet or phone holds an opaque,
 * org-prefixed secret (`pdv1.<orgId>.<deviceId>.<random>`); only a keyed hash
 * is stored. The secret authorizes uploading orders from that one terminal and
 * nothing else: it is never accepted on operator or kiosk routes, and an
 * operator token or kiosk secret is never accepted here.
 *
 * Authentication itself touches only the organization's own database. On the
 * US Workers node the router first confirms the organization with App (cached
 * for a minute, and answered 503, never "removed", when App cannot be reached),
 * so during a longer App outage terminals keep selling and queue their uploads.
 * A revoked terminal is refused with a distinct code so it can show "unpaired"
 * and forget its secret.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export function posError(
	status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503,
	error: string,
	extra: Record<string, unknown> = {},
) {
	return Response.json({ error, ...extra }, { status, headers: NO_STORE })
}

/**
 * `POS_ENABLED=false` (or `0`/`off`/`no`) turns every terminal route and
 * pairing off on this node: a paired terminal holds its secret locally, so
 * only the environment can reach it. Unset means enabled.
 */
export function isPosEnabled(): boolean {
	syncEnvFromProcess()
	const live =
		typeof process !== 'undefined' && process.env
			? process.env.POS_ENABLED
			: (ENV as { POS_ENABLED?: unknown }).POS_ENABLED
	const raw = String(live ?? '')
		.trim()
		.toLowerCase()
	return !['false', '0', 'off', 'no', 'disabled'].includes(raw)
}

export const posDisabledResponse = () => posError(503, 'pos_disabled')

function hashesMatch(left: string, right: string): boolean {
	const a = Buffer.from(left, 'utf8')
	const b = Buffer.from(right, 'utf8')
	if (a.length !== b.length) return false
	return crypto.timingSafeEqual(a, b)
}

export const hashPosSecret = (secret: string): string =>
	hmacHash(posSecretHashMessage(secret))

/**
 * True when `AUTH_HMAC_SECRET` is missing or too short on this node. That is a
 * configuration fault, answered 503 (the till retries) rather than a 500.
 */
export function isPosHashUnavailable(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message === 'AUTH_HMAC_SECRET is not configured'
	)
}

export const posUnavailableResponse = () => posError(503, 'service_unavailable')

export type PosAuth = { orgId: string; device: PosDevice; db: TenantDatabase }

/**
 * Order: kill switch, secret shape, the organization's database, the device
 * row, the keyed hash (constant time), revocation. Unknown device and bad
 * secret answer the same `invalid_device`.
 */
export async function authenticatePosDevice(
	c: Context,
): Promise<{ pos: PosAuth } | { error: Response }> {
	if (!isPosEnabled()) return { error: posDisabledResponse() }

	const secret = getBearerToken(c.req.header('Authorization'))
	const parsed = parsePosDeviceSecret(secret)
	if (!parsed) return { error: posError(401, 'invalid_device') }

	let db: TenantDatabase
	try {
		db = await getTenantDb(parsed.orgId)
	} catch {
		return { error: posError(401, 'invalid_device') }
	}

	const [device] = await db
		.select()
		.from(posDevices)
		.where(eq(posDevices.id, parsed.deviceId))
		.limit(1)
	// Hash even when the device is unknown so timing does not reveal which ids exist.
	let presented: string
	try {
		presented = hashPosSecret(secret)
	} catch (error) {
		if (isPosHashUnavailable(error)) return { error: posUnavailableResponse() }
		throw error
	}
	if (!device || !hashesMatch(presented, device.secretHash)) {
		return { error: posError(401, 'invalid_device') }
	}
	if (device.revokedAt !== null) {
		return { error: posError(401, 'device_revoked') }
	}
	return { pos: { orgId: parsed.orgId, device, db } }
}
