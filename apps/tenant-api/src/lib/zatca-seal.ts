import crypto from 'node:crypto'
import { ENV } from 'varlock/env'
import { hmacHash } from './secrets.ts'

/**
 * Seals ZATCA secrets at rest (EGS signing keys, CSID secrets) with
 * AES-256-GCM.
 *
 * The key is `ZATCA_SEAL_KEY` (64 hex characters), so rotating
 * `AUTH_HMAC_SECRET` for an OTP or session reason never destroys a signing
 * key. Production requires it: the Node entry refuses to start without it, and
 * the Worker refuses to seal anything new. In development, without it, the key
 * is derived from `AUTH_HMAC_SECRET`; values sealed that way stay readable
 * after it is set.
 *
 * Rotation: put the old key in `ZATCA_SEAL_KEY_PREVIOUS` (comma separated) and
 * the new one in `ZATCA_SEAL_KEY`. Values open with either, and the regional
 * tick re-seals them with the new key (`needsReseal`). Remove the old key once
 * the tick has run for every organization.
 *
 * Formats:
 * - `v1.<iv>.<tag>.<body>`: derived key, no associated data (read only).
 * - `v2.<keyId>.<iv>.<tag>.<body>`: the key named by `keyId` (`h` for the
 *   derived key, `z<fingerprint>` for `ZATCA_SEAL_KEY`), with the context
 *   (`<deviceId>:<column>`) as associated data, so a sealed value copied to
 *   another unit or column does not open.
 */

// Pinned so a truncated tag is refused instead of weakening authentication.
const AUTH_TAG_LENGTH = 16
const DERIVED_KEY_ID = 'h'

const derivedKey = () => Buffer.from(hmacHash('zatca-seal-v1'), 'hex')

type SealKey = { id: string; key: Buffer }

// process.env when there is one (the Worker copies its bindings there): the
// env snapshot never forgets a key that was unset.
function readEnv(
	name: 'ZATCA_SEAL_KEY' | 'ZATCA_SEAL_KEY_PREVIOUS' | 'NODE_ENV',
) {
	const value =
		typeof process !== 'undefined' && process.env
			? process.env[name]
			: (ENV as Record<string, unknown>)[name]
	return typeof value === 'string' ? value.trim() : ''
}

/** Only an explicit development or test environment is local. */
function isProduction() {
	const nodeEnv = readEnv('NODE_ENV')
	return nodeEnv !== 'development' && nodeEnv !== 'test'
}

function parseKey(name: string, raw: string): SealKey {
	if (!/^[0-9a-fA-F]{64}$/.test(raw))
		throw new Error(`${name} must be 64 hex characters (32 bytes)`)
	const key = Buffer.from(raw, 'hex')
	const fingerprint = crypto
		.createHash('sha256')
		.update(key)
		.digest('hex')
		.slice(0, 8)
	return { id: `z${fingerprint}`, key }
}

function configuredKey(): SealKey | null {
	const raw = readEnv('ZATCA_SEAL_KEY')
	return raw ? parseKey('ZATCA_SEAL_KEY', raw) : null
}

function previousKeys(): SealKey[] {
	return readEnv('ZATCA_SEAL_KEY_PREVIOUS')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => parseKey('ZATCA_SEAL_KEY_PREVIOUS', entry))
}

/** The key new values are sealed with. */
function currentKey(): SealKey {
	const configured = configuredKey()
	if (configured) return configured
	if (isProduction())
		throw new Error('ZATCA_SEAL_KEY must be set in production')
	return { id: DERIVED_KEY_ID, key: derivedKey() }
}

function keyFor(id: string): Buffer {
	if (id === DERIVED_KEY_ID) return derivedKey()
	const known = [configuredKey(), ...previousKeys()].find(
		(candidate) => candidate?.id === id,
	)
	if (known) return known.key
	throw new Error('The key this value was sealed with is not configured')
}

/**
 * Startup check for the Node entry: production needs `ZATCA_SEAL_KEY`, and
 * every configured key must be well formed.
 */
export function assertZatcaSealKey() {
	previousKeys()
	if (!configuredKey() && isProduction())
		throw new Error('ZATCA_SEAL_KEY must be set in production')
}

/**
 * True when a sealed value is not under the current key (a `v1`, derived or
 * previous key). False when there is no key to move it to (production without
 * `ZATCA_SEAL_KEY`).
 */
export function needsReseal(sealed: string): boolean {
	const current =
		configuredKey()?.id ?? (isProduction() ? null : DERIVED_KEY_ID)
	if (!current) return false
	const [version, id] = sealed.split('.')
	return version !== 'v2' || id !== current
}

/** `context` names what the value is (`<deviceId>:<column>`); unsealing needs the same. */
export function seal(plain: string, context: string): string {
	const { id, key } = currentKey()
	const iv = crypto.randomBytes(12)
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {
		authTagLength: AUTH_TAG_LENGTH,
	})
	cipher.setAAD(Buffer.from(context, 'utf8'))
	const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
	return [
		'v2',
		id,
		iv.toString('base64'),
		cipher.getAuthTag().toString('base64'),
		body.toString('base64'),
	].join('.')
}

export function unseal(sealed: string, context: string): string {
	const parts = sealed.split('.')
	let key: Buffer
	let iv: string | undefined
	let tag: string | undefined
	let body: string | undefined
	let aad: string | null
	if (parts[0] === 'v1' && parts.length === 4) {
		key = derivedKey()
		;[, iv, tag, body] = parts
		aad = null
	} else if (parts[0] === 'v2' && parts.length === 5 && parts[1]) {
		key = keyFor(parts[1])
		;[, , iv, tag, body] = parts
		aad = context
	} else {
		throw new Error('Unknown sealed value')
	}
	if (!iv || !tag || !body) throw new Error('Unknown sealed value')
	const decipher = crypto.createDecipheriv(
		'aes-256-gcm',
		key,
		Buffer.from(iv, 'base64'),
		{ authTagLength: AUTH_TAG_LENGTH },
	)
	if (aad !== null) decipher.setAAD(Buffer.from(aad, 'utf8'))
	decipher.setAuthTag(Buffer.from(tag, 'base64'))
	return Buffer.concat([
		decipher.update(Buffer.from(body, 'base64')),
		decipher.final(),
	]).toString('utf8')
}

/** The associated data for one sealed column of a unit. */
export const sealContext = (
	deviceId: string,
	column: 'private_key' | 'compliance_secret' | 'production_secret',
) => `${deviceId}:${column}`
