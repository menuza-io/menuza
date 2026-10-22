import crypto from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { hmacHash } from './secrets.ts'
import { seal, sealContext, unseal } from './zatca-seal.ts'

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

afterEach(() => {
	delete process.env.ZATCA_SEAL_KEY
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
})
