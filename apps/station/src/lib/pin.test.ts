import { describe, expect, it } from 'vitest'
import { PIN_PATTERN, derivePinKey, newSalt } from './pin.ts'

describe('PIN hashing', () => {
	it('is deterministic for a salt and differs for another salt or PIN', async () => {
		const salt = newSalt()
		const a = await derivePinKey('4321', salt)
		expect(await derivePinKey('4321', salt)).toBe(a)
		expect(await derivePinKey('4322', salt)).not.toBe(a)
		expect(await derivePinKey('4321', newSalt())).not.toBe(a)
	})

	it('never contains the PIN, and is a fixed-size base64 string', async () => {
		const key = await derivePinKey('987654', newSalt())
		expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/)
		expect(key).not.toContain('987654')
	})

	it('makes a fresh random salt each time', () => {
		expect(new Set(Array.from({ length: 20 }, newSalt)).size).toBe(20)
	})

	it('accepts only 4 to 6 digits', () => {
		for (const ok of ['1234', '12345', '123456', '0000'])
			expect(PIN_PATTERN.test(ok)).toBe(true)
		for (const bad of [
			'123',
			'1234567',
			'12a4',
			'',
			' 1234',
			'12 34',
			'１２３４',
		])
			expect(PIN_PATTERN.test(bad)).toBe(false)
	})
})
