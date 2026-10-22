import crypto from 'node:crypto'
import { ENV } from 'varlock/env'
import { hmacHash } from './secrets.ts'

/**
 * Seals ZATCA secrets at rest (EGS signing keys, CSID secrets) with
 * AES-256-GCM.
 *
 * The key is `ZATCA_SEAL_KEY` (64 hex characters) when it is set, so rotating
 * `AUTH_HMAC_SECRET` for an OTP or session reason never destroys a signing
 * key. Without it the key is derived from `AUTH_HMAC_SECRET`, as it always
 * was, so existing values and local development keep working.
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

function configuredKey(): { id: string; key: Buffer } | null {
	// process.env when there is one (the Worker copies its bindings there): the
	// env snapshot never forgets a key that was unset.
	const raw = (
		(typeof process !== 'undefined' && process.env
			? process.env.ZATCA_SEAL_KEY
			: ENV.ZATCA_SEAL_KEY) ?? ''
	).trim()
	if (!raw) return null
	if (!/^[0-9a-fA-F]{64}$/.test(raw))
		throw new Error('ZATCA_SEAL_KEY must be 64 hex characters (32 bytes)')
	const key = Buffer.from(raw, 'hex')
	const fingerprint = crypto
		.createHash('sha256')
		.update(key)
		.digest('hex')
		.slice(0, 8)
	return { id: `z${fingerprint}`, key }
}

/** The key new values are sealed with. */
function currentKey(): { id: string; key: Buffer } {
	return configuredKey() ?? { id: DERIVED_KEY_ID, key: derivedKey() }
}

function keyFor(id: string): Buffer {
	if (id === DERIVED_KEY_ID) return derivedKey()
	const configured = configuredKey()
	if (configured && configured.id === id) return configured.key
	throw new Error('The key this value was sealed with is not configured')
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
