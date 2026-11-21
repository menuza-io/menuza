import crypto from 'node:crypto'
import { hmacHash } from './secrets.ts'

/**
 * Device tokens (#105) are sealed at rest and searched only by an HMAC:
 *  - `pushTokenHash` (HMAC-SHA256 under AUTH_HMAC_SECRET) is the unique key, so
 *    the same phone registers once and a lookup never reads a token;
 *  - `sealPushToken` encrypts the token with AES-256-GCM under a key derived
 *    from AUTH_HMAC_SECRET and a purpose label, so a database copy alone
 *    holds nothing a push service would accept.
 * A leaked token could send a push to one phone, never read anything; the
 * sealing is defence in depth, as `gift-card-secret.ts` does for codes.
 */

const PURPOSE = 'push-token:v1'
const AUTH_TAG_LENGTH = 16

function key(): Buffer {
	return Buffer.from(hmacHash(`${PURPOSE}:seal-key`), 'hex')
}

export function pushTokenHash(token: string): string {
	return hmacHash(`${PURPOSE}:hash:${token}`)
}

export function sealPushToken(token: string): string {
	const iv = crypto.randomBytes(12)
	const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv, {
		authTagLength: AUTH_TAG_LENGTH,
	})
	const sealed = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
	return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url')
}

/** The token, or null when the value is damaged or sealed under another key. */
export function openPushToken(value: string): string | null {
	try {
		const raw = Buffer.from(value, 'base64url')
		const iv = raw.subarray(0, 12)
		const tag = raw.subarray(12, 12 + AUTH_TAG_LENGTH)
		const data = raw.subarray(12 + AUTH_TAG_LENGTH)
		const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv, {
			authTagLength: AUTH_TAG_LENGTH,
		})
		decipher.setAuthTag(tag)
		return Buffer.concat([decipher.update(data), decipher.final()]).toString(
			'utf8',
		)
	} catch {
		return null
	}
}
