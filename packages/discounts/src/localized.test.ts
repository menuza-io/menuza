import { describe, expect, it } from 'vitest'
import {
	discountLocalizedTextSchema,
	localizedDiscountText,
} from './localized.ts'

describe('localizedDiscountText', () => {
	const map = { en: 'Lunch deal', ar: 'عرض الغداء' }
	it('picks the guest language, then its base', () => {
		expect(localizedDiscountText(map, 'x', 'ar', 'en')).toBe('عرض الغداء')
		expect(localizedDiscountText(map, 'x', 'ar-SA', 'en')).toBe('عرض الغداء')
	})
	it('falls back to the default language, then the canonical text', () => {
		expect(localizedDiscountText(map, 'x', 'fr', 'en')).toBe('Lunch deal')
		expect(localizedDiscountText({}, 'Lunch', 'fr', 'en')).toBe('Lunch')
		expect(localizedDiscountText(undefined, 'Lunch', 'ar')).toBe('Lunch')
	})
	it('drops empty languages and refuses bad keys', () => {
		const schema = discountLocalizedTextSchema(10)
		expect(schema.parse({ en: ' Hi ', ar: '  ' })).toEqual({ en: 'Hi' })
		expect(schema.safeParse({ EN: 'Hi' }).success).toBe(false)
		expect(schema.safeParse({ en: 'x'.repeat(11) }).success).toBe(false)
	})
})
