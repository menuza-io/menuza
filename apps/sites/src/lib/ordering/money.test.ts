import { describe, expect, it } from 'vitest'
import { fillTemplate, formatMoney } from './money.ts'

describe('formatMoney', () => {
	it('renders USD and CAD as plain dollars in every locale', () => {
		expect(formatMoney(18, 'USD', 'en')).toBe('$18.00')
		expect(formatMoney(18, 'USD', 'ar')).toBe('$18.00')
		expect(formatMoney(22.5, 'CAD', 'ar')).toBe('$22.50')
		expect(formatMoney(1234.5, 'CAD', 'fr')).toBe('$1,234.50')
	})

	it('keeps the sign and tolerates bad input', () => {
		expect(formatMoney(-3.25, 'USD', 'en')).toBe('-$3.25')
		expect(formatMoney(Number.NaN, 'USD', 'en')).toBe('$0.00')
		expect(formatMoney(5, '', 'en')).toBe('$5.00')
	})

	it('uses Intl for other currencies', () => {
		expect(formatMoney(12, 'EUR', 'de')).toBe(
			new Intl.NumberFormat('de', {
				style: 'currency',
				currency: 'EUR',
			}).format(12),
		)
		expect(formatMoney(12, 'SAR', 'en')).toContain('12.00')
	})
})

describe('fillTemplate', () => {
	it('replaces named placeholders and leaves unknown ones alone', () => {
		expect(fillTemplate('Only {count} left', { count: 3 })).toBe('Only 3 left')
		expect(
			fillTemplate('Only {count} left in {category}', {
				count: 2,
				category: 'Loaves',
			}),
		).toBe('Only 2 left in Loaves')
		expect(fillTemplate('{a} {b}', { a: 'x' })).toBe('x {b}')
	})
})
