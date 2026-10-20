import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { type Context } from 'hono'
import { ENV } from 'varlock/env'
import { kioskSecretHashMessage, parseKioskDeviceSecret } from '@repo/staffing'
import {
	getTenantDb,
	kioskDevices,
	type KioskDevice,
	type TenantDatabase,
} from '@repo/tenant-db'
import { hashClientIp } from '../services/staff-audit.ts'
import { getBearerToken, hmacHash, syncEnvFromProcess } from './secrets.ts'

/**
 * Kiosk device principal. A paired tablet holds an opaque, org-prefixed secret
 * (`kdv1.<orgId>.<deviceId>.<random>`); only a keyed hash is stored. The secret
 * authorizes punches at one scope and nothing else: it can never be used
 * for operator routes and an operator token is never accepted here.
 *
 * Authentication touches only the organization's own database. It does not
 * call the control plane, so a tablet keeps working through an App outage on
 * nodes that serve it directly. The device row's existence is the proof that
 * the organization is provisioned on this node; a revoked device is refused
 * with a distinct code so the tablet can show "unpaired" and forget its secret.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export function kioskError(
	status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503,
	error: string,
	extra: Record<string, unknown> = {},
	headers: Record<string, string> = {},
) {
	return Response.json(
		{ error, ...extra },
		{ status, headers: { ...NO_STORE, ...headers } },
	)
}

/**
 * Environment kill switch. `STAFFING_KIOSK_ENABLED=false` (or `0`/`off`/`no`)
 * turns every `/kiosk` route and kiosk pairing off on this node, because a
 * paired tablet holds its secret locally and no organization flag can reach it.
 * Unset means enabled. Revoking devices is the per-device mitigation.
 */
export function isKioskEnabled(): boolean {
	syncEnvFromProcess()
	// Read the live environment when there is one: the switch exists to be
	// flipped without a deploy, and the varlock snapshot never forgets a key
	// that was later unset.
	const live =
		typeof process !== 'undefined' && process.env
			? process.env.STAFFING_KIOSK_ENABLED
			: (ENV as { STAFFING_KIOSK_ENABLED?: unknown }).STAFFING_KIOSK_ENABLED
	const raw = String(live ?? '')
		.trim()
		.toLowerCase()
	return !['false', '0', 'off', 'no', 'disabled'].includes(raw)
}

export function kioskDisabledResponse() {
	return kioskError(503, 'kiosk_disabled')
}

/** Constant-time comparison of two hex digests of equal length. */
function hashesMatch(left: string, right: string): boolean {
	const a = Buffer.from(left, 'utf8')
	const b = Buffer.from(right, 'utf8')
	if (a.length !== b.length) return false
	return crypto.timingSafeEqual(a, b)
}

export function hashKioskSecret(secret: string): string {
	return hmacHash(kioskSecretHashMessage(secret))
}

export type KioskAuth = {
	orgId: string
	device: KioskDevice
	db: TenantDatabase
	ipHash: string | null
}

type Failure = { error: Response }
type Success = { kiosk: KioskAuth }

/**
 * Verifies the bearer device secret. Order: kill switch, secret shape, the
 * organization's database, the device row, the keyed hash (constant time),
 * revocation. Unknown device and bad secret answer the same `invalid_device`.
 */
export async function authenticateKioskDevice(
	c: Context,
): Promise<Success | Failure> {
	if (!isKioskEnabled()) return { error: kioskDisabledResponse() }

	const secret = getBearerToken(c.req.header('Authorization'))
	const parsed = parseKioskDeviceSecret(secret)
	if (!parsed) return { error: kioskError(401, 'invalid_device') }

	let db: TenantDatabase
	try {
		db = await getTenantDb(parsed.orgId)
	} catch {
		// No database for this organization on this node.
		return { error: kioskError(401, 'invalid_device') }
	}

	const [device] = await db
		.select()
		.from(kioskDevices)
		.where(eq(kioskDevices.id, parsed.deviceId))
		.limit(1)
	// Hash even when the device is unknown so timing does not reveal which ids
	// exist.
	const presented = hashKioskSecret(secret)
	if (!device || !hashesMatch(presented, device.secretHash)) {
		return { error: kioskError(401, 'invalid_device') }
	}
	if (device.revokedAt !== null) {
		return { error: kioskError(401, 'device_revoked') }
	}

	return {
		kiosk: { orgId: parsed.orgId, device, db, ipHash: hashClientIp(c) },
	}
}
