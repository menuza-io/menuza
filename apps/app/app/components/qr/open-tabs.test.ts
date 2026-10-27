import { describe, expect, it } from 'vitest'
import { parseTip, parseTipCents } from './open-tabs.tsx'

describe('parseTip', () => {
	it('reads Latin and Arabic digits and comma decimals', () => {
		expect(parseTipCents('5')).toBe(500)
		expect(parseTipCents('5,50')).toBe(550)
		expect(parseTipCents('٥٫٥')).toBe(550)
		expect(parseTipCents('۲')).toBe(200)
		expect(parseTip('')).toEqual({ cents: 0, valid: true })
	})

	it('refuses anything it would have to guess at', () => {
		for (const raw of ['abc', '-3', '1,000', '5 000', '1.234', '1.5.0']) {
			expect(parseTip(raw)).toEqual({ cents: 0, valid: false })
		}
	})
})
