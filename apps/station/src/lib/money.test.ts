import { describe, expect, it } from 'vitest'
import { formatMoney } from './money.ts'

describe('formatMoney', () => {
	it('keeps the English format apps/sites uses', () => {
		expect(formatMoney(1250, 'USD', 'en')).toBe('$12.50')
		expect(formatMoney(-1250, 'USD', 'en')).toBe('-$12.50')
		expect(formatMoney(1250, 'SAR', 'en')).toBe(
			new Intl.NumberFormat('en', {
				style: 'currency',
				currency: 'SAR',
			}).format(12.5),
		)
	})

	it('follows the till’s language in Arabic, isolated as <bdi> would', () => {
		const text = formatMoney(1250, 'SAR', 'ar')
		expect(text.startsWith('⁨')).toBe(true)
		expect(text.endsWith('⁩')).toBe(true)
		expect(text.slice(1, -1)).toBe(
			new Intl.NumberFormat('ar', {
				style: 'currency',
				currency: 'SAR',
			}).format(12.5),
		)
		// Not the English dollar shortcut either.
		expect(formatMoney(1250, 'USD', 'ar')).not.toContain('$12.50')
	})

	it('uses the active language when none is given', () => {
		// The test setup activates English.
		expect(formatMoney(500, 'USD')).toBe('$5.00')
	})
})
