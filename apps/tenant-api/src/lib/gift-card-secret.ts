import crypto from 'node:crypto'
import { ENV } from 'varlock/env'
import { hmacHash, syncEnvFromProcess } from './secrets.ts'

/**
 * Keyed hashes and sealing for gift cards. Every card code is stored only as
 * an HMAC (and its last four characters); a purchased card's code is also
 * sealed until the recipient email has gone out, then cleared.
 *
 * The key is `GIFT_CARD_HMAC_SECRET` (32 or more characters) when it is set, so
 * rotating `AUTH_HMAC_SECRET` for an OTP or session reason never makes a card
 * unfindable. Unset, everything falls back to `AUTH_HMAC_SECRET` (the same
 * hashes as before, so a database built that way keeps working).
 *
 * Choose the key before the first card is sold and never change it: every code
 * hash depends on it, and there is no re-keying step. A changed key makes
 * existing cards unfindable (see docs/gift-cards.md, "Secrets").
 */

// Pinned so a truncated tag is refused instead of weakening authentication.
const AUTH_TAG_LENGTH = 16
const MIN_DEDICATED_SECRET_LENGTH = 32

// process.env when there is one (the Worker copies its bindings there): the
// env snapshot never forgets a key that was unset.
function dedicatedSecret(): string | null {
	const raw =
		typeof process !== 'undefined' && process.env
			? process.env.GIFT_CARD_HMAC_SECRET
			: (ENV as Record<string, unknown>).GIFT_CARD_HMAC_SECRET
	const value = typeof raw === 'string' ? raw.trim() : ''
	if (!value) return null
	if (value.length < MIN_DEDICATED_SECRET_LENGTH) {
		throw new Error('GIFT_CARD_HMAC_SECRET must be at least 32 characters')
	}
	return value
}

/** HMAC-SHA256 (hex) of `value` under the gift card key. */
export function giftCardHmac(value: string): string {
	const secret = dedicatedSecret()
	if (!secret) return hmacHash(value)
	return crypto.createHmac('sha256', secret).update(value).digest('hex')
}

export function giftCardCodeHash(normalizedCode: string): string {
	return giftCardHmac(`gift-card-code:v1:${normalizedCode}`)
}

export function giftCardExternalHash(digits: string): string {
	return giftCardHmac(`gift-card-external:v1:${digits}`)
}

/**
 * A hashed fingerprint of a payment card, buyer email or device. Only an email
 * is case-folded; a payment or device id is compared as given (trimmed).
 */
export function giftCardFingerprint(
	kind: 'payment' | 'email' | 'device',
	value: string,
): string {
	const trimmed = value.trim()
	const normalized = kind === 'email' ? trimmed.toLowerCase() : trimmed
	return giftCardHmac(`gift-card-fingerprint:v1:${kind}:${normalized}`)
}

export function giftCardShowTokenHash(token: string): string {
	return giftCardHmac(`gift-card-show-token:v1:${token}`)
}

/** The key sealed codes use, and a short id of it stored in each sealed value. */
function sealKey(): { key: Buffer; id: string } {
	const secret = dedicatedSecret()
	let base = secret
	if (!base) {
		syncEnvFromProcess()
		base = ENV.AUTH_HMAC_SECRET || ''
		if (base.length < 16) throw new Error('AUTH_HMAC_SECRET is not configured')
	}
	const key = crypto
		.createHmac('sha256', base)
		.update('gift-card-seal:v1')
		.digest()
	const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)
	return { key, id }
}

/** AES-256-GCM: `v2.<keyId>.<iv>.<tag>.<cipher>`, the parts after the version in base64url. */
export function sealGiftCardCode(code: string): string {
	const { key, id } = sealKey()
	const iv = crypto.randomBytes(12)
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {
		authTagLength: AUTH_TAG_LENGTH,
	})
	const body = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()])
	const tag = cipher.getAuthTag()
	return [
		'v2',
		id,
		iv.toString('base64url'),
		tag.toString('base64url'),
		body.toString('base64url'),
	].join('.')
}

/**
 * The sealed code, or `null` when the value is malformed or fails GCM
 * authentication (corrupt or tampered). A configuration problem is different
 * and throws: a missing key, or a value sealed with another key, must never
 * look like bad data. A caller logs the card id (never the code).
 */
export function openGiftCardCode(sealed: string): string | null {
	const [version, keyId, iv, tag, body, extra] = sealed.split('.')
	if (
		version !== 'v2' ||
		!keyId ||
		!iv ||
		!tag ||
		!body ||
		extra !== undefined
	) {
		return null
	}
	const { key, id } = sealKey()
	if (keyId !== id) {
		throw new Error('The gift card code was sealed with a different key')
	}
	try {
		const tagBytes = Buffer.from(tag, 'base64url')
		if (tagBytes.length !== AUTH_TAG_LENGTH) return null
		const decipher = crypto.createDecipheriv(
			'aes-256-gcm',
			key,
			Buffer.from(iv, 'base64url'),
			{ authTagLength: AUTH_TAG_LENGTH },
		)
		decipher.setAuthTag(tagBytes)
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
