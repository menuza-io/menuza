import crypto from 'node:crypto'
import { ENV } from 'varlock/env'
import { hmacHash, syncEnvFromProcess } from './secrets.ts'

/**
 * Keyed hashes and sealing for gift cards. Every card code is stored only as
 * an HMAC (and its last four characters); a purchased card's code is also
 * sealed until the recipient email has gone out, then cleared.
 *
 * All of it hangs on `AUTH_HMAC_SECRET`: rotating that secret changes every
 * hash, so existing cards would stop being found. Treat it as a long-lived
 * secret (see docs/gift-cards.md, "Secrets").
 */

export function giftCardCodeHash(normalizedCode: string): string {
	return hmacHash(`gift-card-code:v1:${normalizedCode}`)
}

export function giftCardExternalHash(digits: string): string {
	return hmacHash(`gift-card-external:v1:${digits}`)
}

/** A hashed fingerprint of a payment card, buyer email or device. */
export function giftCardFingerprint(
	kind: 'payment' | 'email' | 'device',
	value: string,
): string {
	return hmacHash(
		`gift-card-fingerprint:v1:${kind}:${value.trim().toLowerCase()}`,
	)
}

export function giftCardShowTokenHash(token: string): string {
	return hmacHash(`gift-card-show-token:v1:${token}`)
}

function sealKey(): Buffer {
	syncEnvFromProcess()
	const secret = ENV.AUTH_HMAC_SECRET || ''
	if (secret.length < 16) throw new Error('AUTH_HMAC_SECRET is not configured')
	return crypto
		.createHmac('sha256', secret)
		.update('gift-card-seal:v1')
		.digest()
}

/** AES-256-GCM: `v1.<iv>.<tag>.<cipher>` in base64url. */
export function sealGiftCardCode(code: string): string {
	const iv = crypto.randomBytes(12)
	const cipher = crypto.createCipheriv('aes-256-gcm', sealKey(), iv)
	const body = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()])
	const tag = cipher.getAuthTag()
	return ['v1', iv, tag, body]
		.map((part, index) =>
			index === 0 ? part : (part as Buffer).toString('base64url'),
		)
		.join('.')
}

export function openGiftCardCode(sealed: string): string | null {
	const [version, iv, tag, body] = sealed.split('.')
	if (version !== 'v1' || !iv || !tag || !body) return null
	try {
		const decipher = crypto.createDecipheriv(
			'aes-256-gcm',
			sealKey(),
			Buffer.from(iv, 'base64url'),
		)
		decipher.setAuthTag(Buffer.from(tag, 'base64url'))
		return Buffer.concat([
			decipher.update(Buffer.from(body, 'base64url')),
			decipher.final(),
		]).toString('utf8')
	} catch {
		return null
	}
}

/** A fresh random id for the QR show token (256 bits). */
export function newShowToken(): string {
	return `gcs1.${crypto.randomBytes(32).toString('base64url')}`
}
