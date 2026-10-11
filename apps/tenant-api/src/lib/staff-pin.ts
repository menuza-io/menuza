import crypto from 'node:crypto'
import { pinProblem } from '@repo/staffing'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'

import { hmacHash, timingSafeEqualString } from './secrets.ts'

/**
 * Kiosk secrets are HMAC'd with AUTH_HMAC_SECRET and a per-purpose prefix, so
 * a leaked tenant database cannot be brute-forced offline without the node
 * secret, and a hash from one purpose never verifies another.
 */
export function hashPin(orgId: string, pin: string) {
	return hmacHash(`staffing-pin:v1:${orgId}:${pin}`)
}

export function hashPairingCode(orgId: string, code: string) {
	return hmacHash(`kiosk-pair:v1:${orgId}:${code.toUpperCase()}`)
}

export function hashDeviceToken(token: string) {
	return hmacHash(`kiosk-device:v1:${token}`)
}

/** A random PIN that passes the weak-PIN rule. */
export function generatePin(length = 4) {
	for (;;) {
		const pin = Array.from({ length }, () => crypto.randomInt(0, 10)).join('')
		if (!pinProblem(pin)) return pin
	}
}

// Crockford base32 without I, L, O, U: easy to read off a screen.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function generatePairingCode(length = 10) {
	return Array.from(
		{ length },
		() => CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)],
	).join('')
}

const DEVICE_TOKEN_PREFIX = 'kd1'

/** The org id is in the clear so the node can open the right database. */
export function createDeviceToken(orgId: string) {
	const secret = crypto.randomBytes(32).toString('base64url')
	return `${DEVICE_TOKEN_PREFIX}.${orgId}.${secret}`
}

export function parseDeviceToken(token: string) {
	const [prefix, orgId, secret, ...rest] = token.split('.')
	if (
		prefix !== DEVICE_TOKEN_PREFIX ||
		rest.length > 0 ||
		!orgId ||
		!TENANT_ORG_ID_PATTERN.test(orgId) ||
		!secret ||
		secret.length < 40 ||
		secret.length > 64
	) {
		return null
	}
	return { orgId }
}

export const PUNCH_TOKEN_TTL_MS = 60_000

function punchSignature(
	orgId: string,
	deviceId: string,
	staffId: string,
	expires: number,
) {
	return hmacHash(`kiosk-punch:v1:${orgId}:${deviceId}:${staffId}:${expires}`)
}

/**
 * Short-lived proof that this device just verified this person's PIN. It lets
 * the confirm screen punch without sending the PIN twice.
 */
export function createPunchToken(
	orgId: string,
	deviceId: string,
	staffId: string,
	now = Date.now(),
) {
	const expires = now + PUNCH_TOKEN_TTL_MS
	return `${staffId}.${expires}.${punchSignature(orgId, deviceId, staffId, expires)}`
}

export function verifyPunchToken(
	orgId: string,
	deviceId: string,
	token: string,
	now = Date.now(),
) {
	const [staffId, expiresRaw, signature, ...rest] = token.split('.')
	if (!staffId || !expiresRaw || !signature || rest.length > 0) return null
	const expires = Number(expiresRaw)
	if (!Number.isSafeInteger(expires) || expires < now) return null
	if (expires > now + PUNCH_TOKEN_TTL_MS) return null
	const expected = punchSignature(orgId, deviceId, staffId, expires)
	return timingSafeEqualString(signature, expected) ? { staffId } : null
}

export const PIN_LOCKOUT_THRESHOLD = 5
const PIN_LOCKOUT_BASE_MS = 5 * 60_000
const PIN_LOCKOUT_MAX_MS = 60 * 60_000

/** 5 minutes after 5 misses, doubling for each further 5, capped at an hour. */
export function pinLockoutMs(failedCount: number) {
	if (failedCount < PIN_LOCKOUT_THRESHOLD) return 0
	const steps = Math.floor(failedCount / PIN_LOCKOUT_THRESHOLD) - 1
	return Math.min(PIN_LOCKOUT_MAX_MS, PIN_LOCKOUT_BASE_MS * 2 ** steps)
}
