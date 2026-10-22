import crypto from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { hmacHash } from './secrets.ts'
import {
	assertZatcaSealKey,
	needsReseal,
	seal,
	sealContext,
	unseal,
} from './zatca-seal.ts'

const context = sealContext('device-1', 'private_key')

/** A value sealed the way the first release did: derived key, no associated data. */
function sealV1(plain: string) {
	const key = Buffer.from(hmacHash('zatca-seal-v1'), 'hex')
	const iv = crypto.randomBytes(12)
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {
		authTagLength: 16,
	})
	const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
	return [
		'v1',
		iv.toString('base64'),
		cipher.getAuthTag().toString('base64'),
		body.toString('base64'),
	].join('.')
}

const nodeEnv = process.env.NODE_ENV
afterEach(() => {
	// Empty instead of deleted: the varlock sync only copies defined values.
	process.env.ZATCA_SEAL_KEY = ''
	process.env.ZATCA_SEAL_KEY_PREVIOUS = ''
	process.env.NODE_ENV = nodeEnv
})

describe('zatca seal', () => {
	it('round-trips a secret, naming the key it used', () => {
		const sealed = seal('egs-private-key', context)
		expect(sealed.startsWith('v2.h.')).toBe(true)
		expect(unseal(sealed, context)).toBe('egs-private-key')
	})

	it('still opens values sealed before key ids and associated data', () => {
		expect(unseal(sealV1('old-secret'), context)).toBe('old-secret')
	})

	it('binds a value to its unit and column', () => {
		const sealed = seal('egs-private-key', context)
		expect(() =>
			unseal(sealed, sealContext('device-2', 'private_key')),
		).toThrow()
		expect(() =>
			unseal(sealed, sealContext('device-1', 'production_secret')),
		).toThrow()
	})

	it('uses ZATCA_SEAL_KEY when set, so AUTH_HMAC_SECRET can rotate', () => {
		const derived = seal('derived', context)
		process.env.ZATCA_SEAL_KEY = 'ab'.repeat(32)
		const dedicated = seal('dedicated', context)
		expect(dedicated).toMatch(/^v2\.z[0-9a-f]{8}\./)
		expect(unseal(dedicated, context)).toBe('dedicated')
		// Values sealed with the derived key stay readable after the switch.
		expect(unseal(derived, context)).toBe('derived')
		process.env.ZATCA_SEAL_KEY = 'cd'.repeat(32)
		expect(() => unseal(dedicated, context)).toThrow(/not configured/)
	})

	it('refuses a malformed ZATCA_SEAL_KEY', () => {
		process.env.ZATCA_SEAL_KEY = 'too-short'
		expect(() => seal('x', context)).toThrow(/64 hex/)
	})

	it('refuses a truncated authentication tag', () => {
		const [version, id, iv, tag, body] = seal('egs-private-key', context).split(
			'.',
		)
		const short = Buffer.from(tag!, 'base64').subarray(0, 4).toString('base64')
		expect(() =>
			unseal([version, id, iv, short, body].join('.'), context),
		).toThrow()
	})

	it('refuses a tampered body', () => {
		const [version, id, iv, tag, body] = seal('egs-private-key', context).split(
			'.',
		)
		const bytes = Buffer.from(body!, 'base64')
		bytes[0] = bytes[0]! ^ 1
		expect(() =>
			unseal(
				[version, id, iv, tag, bytes.toString('base64')].join('.'),
				context,
			),
		).toThrow()
	})

	describe('production', () => {
		it('requires ZATCA_SEAL_KEY at startup and for new values', () => {
			const derived = seal('derived', context)
			process.env.NODE_ENV = 'production'
			expect(() => assertZatcaSealKey()).toThrow(/must be set in production/)
			expect(() => seal('new', context)).toThrow(/must be set in production/)
			// Values already sealed still open, so reporting keeps working.
			expect(unseal(derived, context)).toBe('derived')
			expect(needsReseal(derived)).toBe(false)
			process.env.ZATCA_SEAL_KEY = 'ab'.repeat(32)
			expect(() => assertZatcaSealKey()).not.toThrow()
			expect(seal('new', context)).toMatch(/^v2\.z/)
		})

		it('treats an unset NODE_ENV as production', () => {
			delete process.env.NODE_ENV
			expect(() => assertZatcaSealKey()).toThrow(/must be set in production/)
		})

		it('refuses a malformed previous key at startup', () => {
			process.env.NODE_ENV = 'production'
			process.env.ZATCA_SEAL_KEY = 'ab'.repeat(32)
			process.env.ZATCA_SEAL_KEY_PREVIOUS = 'not-hex'
			expect(() => assertZatcaSealKey()).toThrow(/ZATCA_SEAL_KEY_PREVIOUS/)
		})
	})

	it('rotates: a previous key still opens, and its values need re-sealing', () => {
		process.env.ZATCA_SEAL_KEY = 'ab'.repeat(32)
		const old = seal('egs-private-key', context)
		expect(needsReseal(old)).toBe(false)
		process.env.ZATCA_SEAL_KEY = 'cd'.repeat(32)
		expect(() => unseal(old, context)).toThrow(/not configured/)
		process.env.ZATCA_SEAL_KEY_PREVIOUS = 'ab'.repeat(32)
		expect(unseal(old, context)).toBe('egs-private-key')
		expect(needsReseal(old)).toBe(true)
		const resealed = seal(unseal(old, context), context)
		expect(needsReseal(resealed)).toBe(false)
		// The old key can go once everything is re-sealed.
		process.env.ZATCA_SEAL_KEY_PREVIOUS = ''
		expect(unseal(resealed, context)).toBe('egs-private-key')
	})

	it('marks v1 and derived-key values for re-sealing once a key is set', () => {
		const v1 = sealV1('old')
		const derived = seal('derived', context)
		process.env.ZATCA_SEAL_KEY = 'ab'.repeat(32)
		expect(needsReseal(v1)).toBe(true)
		expect(needsReseal(derived)).toBe(true)
	})
})
