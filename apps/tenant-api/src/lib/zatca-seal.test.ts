import { describe, expect, it } from 'vitest'
import { seal, unseal } from './zatca-seal.ts'

describe('zatca seal', () => {
	it('round-trips a secret', () => {
		expect(unseal(seal('egs-private-key'))).toBe('egs-private-key')
	})

	it('refuses a truncated authentication tag', () => {
		const [version, iv, tag, body] = seal('egs-private-key').split('.')
		const short = Buffer.from(tag!, 'base64').subarray(0, 4).toString('base64')
		expect(() => unseal([version, iv, short, body].join('.'))).toThrow()
	})

	it('refuses a tampered body', () => {
		const [version, iv, tag, body] = seal('egs-private-key').split('.')
		const bytes = Buffer.from(body!, 'base64')
		bytes[0] = bytes[0]! ^ 1
		expect(() =>
			unseal([version, iv, tag, bytes.toString('base64')].join('.')),
		).toThrow()
	})
})
