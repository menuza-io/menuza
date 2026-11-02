import { describe, expect, it } from 'vitest'
import {
	DISCOUNT_MAX_LOCALES,
	discountLocalizedTextSchema,
	localizedDiscountText,
	withCanonicalDiscountCopy,
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
		expect(schema.safeParse({ 'e n': 'Hi' }).success).toBe(false)
		expect(schema.parse({ EN: 'Hi', 'zh-CN': '你好' })).toEqual({
			en: 'Hi',
			'zh-cn': '你好',
		})
		expect(schema.safeParse({ en: 'x'.repeat(11) }).success).toBe(false)
	})
})

describe('regional keys and limits', () => {
	it('finds a regional key whatever its case', () => {
		expect(
			localizedDiscountText({ 'zh-CN': '午餐' }, 'Lunch', 'zh-cn', 'en'),
		).toBe('午餐')
		expect(localizedDiscountText({ 'zh-cn': '午餐' }, 'Lunch', 'zh-CN')).toBe(
			'午餐',
		)
	})
	it('refuses a map with too many languages', () => {
		const schema = discountLocalizedTextSchema(10)
		const many = Object.fromEntries(
			Array.from({ length: DISCOUNT_MAX_LOCALES + 1 }, (_, index) => [
				`l${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}`,
				'x',
			]),
		)
		expect(schema.safeParse(many).success).toBe(false)
	})
})

describe('withCanonicalDiscountCopy', () => {
	const base = { name: 'Lunch', description: null as string | null }
	it('makes the default entry the canonical name and keeps the others', () => {
		expect(
			withCanonicalDiscountCopy(
				{ ...base, nameI18n: { en: 'Old', ar: 'غداء', fr: 'Lunch' } },
				'en',
			),
		).toEqual({ ...base, nameI18n: { ar: 'غداء', fr: 'Lunch', en: 'Lunch' } })
	})
	it('drops the description entry when there is no description', () => {
		expect(
			withCanonicalDiscountCopy(
				{ ...base, descriptionI18n: { en: 'Old' } },
				'en',
			),
		).toEqual({ ...base, nameI18n: { en: 'Lunch' } })
	})
})
