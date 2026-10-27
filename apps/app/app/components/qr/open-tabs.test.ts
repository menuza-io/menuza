import { describe, expect, it } from 'vitest'
import { parseTipCents } from './open-tabs.tsx'

describe('parseTipCents', () => {
	it('reads Latin and Arabic digits and comma decimals', () => {
		expect(parseTipCents('5')).toBe(500)
		expect(parseTipCents('5,50')).toBe(550)
		expect(parseTipCents('٥٫٥')).toBe(550)
		expect(parseTipCents('۲')).toBe(200)
		expect(parseTipCents('')).toBe(0)
		expect(parseTipCents('abc')).toBe(0)
		expect(parseTipCents('-3')).toBe(300)
	})
})
