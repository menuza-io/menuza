import { describe, expect, it } from 'vitest'
import { listText } from './cart-ui.ts'

describe('listText', () => {
	it('joins names the way the page language does', () => {
		expect(listText(['A', 'B', 'C'], 'en')).toBe('A, B, and C')
		expect(listText(['A', 'B'], 'en')).toBe('A and B')
		expect(listText(['A'], 'en')).toBe('A')
	})

	it('uses the language of the page, not a hard-coded comma', () => {
		expect(listText(['أ', 'ب', 'ج'], 'ar')).toContain('و')
	})
})
