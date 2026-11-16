import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	giftCardCodeHash,
	giftCardFingerprint,
	giftCardHmac,
	openGiftCardCode,
	sealGiftCardCode,
} from './gift-card-secret.ts'
import { syncEnvFromProcess } from './secrets.ts'

const AUTH = 'gift-secret-auth-hmac-0123456789abcdef'
const DEDICATED = 'gift-secret-dedicated-hmac-0123456789abcdef0123'

beforeEach(() => {
	process.env.AUTH_HMAC_SECRET = AUTH
	process.env.GIFT_CARD_HMAC_SECRET = ''
	syncEnvFromProcess()
})

afterEach(() => {
	// Empty instead of deleted: the varlock sync only copies defined values.
	process.env.GIFT_CARD_HMAC_SECRET = ''
})

/** Re-seals `plain` with the same key but a tag of another length. */
function withTag(sealed: string, tag: Buffer) {
	const [version, keyId, iv, , body] = sealed.split('.')
	return [version, keyId, iv, tag.toString('base64url'), body].join('.')
}

describe('gift card sealing', () => {
	it('round-trips a code and names its key in the value', () => {
		const sealed = sealGiftCardCode('ABCD2345EFGH6789')
		expect(sealed.startsWith('v2.')).toBe(true)
		expect(sealed).not.toContain('ABCD2345EFGH6789')
		expect(openGiftCardCode(sealed)).toBe('ABCD2345EFGH6789')
	})

	it('refuses a truncated authentication tag', () => {
		const sealed = sealGiftCardCode('ABCD2345EFGH6789')
		const [, , , tag] = sealed.split('.')
		const full = Buffer.from(tag!, 'base64url')
		expect(full.length).toBe(16)
		expect(openGiftCardCode(withTag(sealed, full.subarray(0, 4)))).toBeNull()
		expect(openGiftCardCode(withTag(sealed, full.subarray(0, 12)))).toBeNull()
	})

	it('returns null for malformed or tampered values, never throwing', () => {
		const sealed = sealGiftCardCode('ABCD2345EFGH6789')
		expect(openGiftCardCode('')).toBeNull()
		expect(openGiftCardCode('v1.a.b.c')).toBeNull()
		expect(openGiftCardCode(`${sealed}.extra`)).toBeNull()
		const parts = sealed.split('.')
		parts[4] = crypto.randomBytes(16).toString('base64url')
		expect(openGiftCardCode(parts.join('.'))).toBeNull()
	})

	it('throws, rather than returning null, when the key changed', () => {
		const sealed = sealGiftCardCode('ABCD2345EFGH6789')
		process.env.GIFT_CARD_HMAC_SECRET = DEDICATED
		expect(() => openGiftCardCode(sealed)).toThrow(/different key/)
	})

	it('throws a configuration error when no key is set', () => {
		const sealed = sealGiftCardCode('ABCD2345EFGH6789')
		process.env.AUTH_HMAC_SECRET = ''
		syncEnvFromProcess()
		expect(() => openGiftCardCode(sealed)).toThrow(/not configured/)
		process.env.AUTH_HMAC_SECRET = AUTH
		syncEnvFromProcess()
	})
})

describe('gift card key', () => {
	it('uses AUTH_HMAC_SECRET when no dedicated key is set', () => {
		const viaAuth = crypto
			.createHmac('sha256', AUTH)
			.update('gift-card-code:v1:ABCD')
			.digest('hex')
		expect(giftCardCodeHash('ABCD')).toBe(viaAuth)
	})

	it('uses GIFT_CARD_HMAC_SECRET when set, so an AUTH_HMAC_SECRET rotation leaves cards findable', () => {
		process.env.GIFT_CARD_HMAC_SECRET = DEDICATED
		const before = giftCardCodeHash('ABCD')
		expect(before).toBe(
			crypto
				.createHmac('sha256', DEDICATED)
				.update('gift-card-code:v1:ABCD')
				.digest('hex'),
		)
		process.env.AUTH_HMAC_SECRET = 'a-completely-different-auth-secret-123456'
		syncEnvFromProcess()
		expect(giftCardCodeHash('ABCD')).toBe(before)
		expect(giftCardHmac('x')).toBe(giftCardHmac('x'))
	})

	it('refuses a dedicated key that is too short', () => {
		process.env.GIFT_CARD_HMAC_SECRET = 'too-short'
		expect(() => giftCardCodeHash('ABCD')).toThrow(/at least 32/)
	})
})

describe('gift card fingerprints', () => {
	it('folds case for an email only', () => {
		expect(giftCardFingerprint('email', '  Pat@Example.COM ')).toBe(
			giftCardFingerprint('email', 'pat@example.com'),
		)
		expect(giftCardFingerprint('device', 'Dev-ABC')).not.toBe(
			giftCardFingerprint('device', 'dev-abc'),
		)
		expect(giftCardFingerprint('payment', 'Fp_ABC')).not.toBe(
			giftCardFingerprint('payment', 'fp_abc'),
		)
		expect(giftCardFingerprint('device', ' dev ')).toBe(
			giftCardFingerprint('device', 'dev'),
		)
	})

	it('keeps the kinds apart', () => {
		expect(giftCardFingerprint('device', 'same')).not.toBe(
			giftCardFingerprint('payment', 'same'),
		)
	})
})
