import { describe, expect, it } from 'vitest'
import {
	checkLocalizedMap,
	localizedTextSchema,
	pruneLocalizedMap,
	resolveGuestLocale,
	resolveLocalizedText,
} from './i18n.ts'

describe('localizedTextSchema', () => {
	const schema = localizedTextSchema(10)
	it('accepts any language code, trims and drops empty values', () => {
		expect(schema.parse({ en: ' Patio ', zh: '露台', fr: '   ' })).toEqual({
			en: 'Patio',
			zh: '露台',
		})
	})
	it('rejects malformed keys and over-long values', () => {
		expect(schema.safeParse({ 'EN-us!': 'x' }).success).toBe(false)
		expect(schema.safeParse({ en: 'x'.repeat(11) }).success).toBe(false)
	})
})

describe('checkLocalizedMap', () => {
	const config = { locales: ['ar', 'en'], defaultLocale: 'ar' }
	it('requires the default language when asked', () => {
		expect(
			checkLocalizedMap({ en: 'Patio' }, config, { requireDefault: true }),
		).toEqual({ ok: false, issue: 'default_locale_required' })
		expect(
			checkLocalizedMap({ ar: 'x', en: 'y' }, config, { requireDefault: true })
				.ok,
		).toBe(true)
	})
	it('refuses a language the organization does not enable', () => {
		expect(checkLocalizedMap({ ar: 'x', es: 'y' }, config)).toEqual({
			ok: false,
			issue: 'locale_not_enabled',
		})
	})
	it('prunes disabled languages when carrying a row forward', () => {
		expect(pruneLocalizedMap({ ar: 'x', es: 'y' }, config)).toEqual({
			ar: 'x',
		})
	})
})

describe('resolveGuestLocale', () => {
	const locales = ['en', 'ar', 'es']
	it('keeps an enabled language, including regional tags', () => {
		expect(resolveGuestLocale('es', locales, 'en')).toBe('es')
		expect(resolveGuestLocale('AR-SA', locales, 'en')).toBe('ar')
	})
	it('falls back to the organization default', () => {
		expect(resolveGuestLocale('fr', locales, 'en')).toBe('en')
		expect(resolveGuestLocale('', locales, 'ar')).toBe('ar')
		expect(resolveGuestLocale(undefined, locales, 'es')).toBe('es')
	})
})

describe('resolveLocalizedText', () => {
	it('uses requested, then org default, then canonical, never another language', () => {
		const map = { ar: 'مقبلات', fr: 'Entrées' }
		expect(resolveLocalizedText(map, 'ar', 'en', 'Starters')).toBe('مقبلات')
		expect(resolveLocalizedText(map, 'es', 'en', 'Starters')).toBe('Starters')
		expect(resolveLocalizedText(map, 'en', 'ar', 'Starters')).toBe('مقبلات')
		expect(resolveLocalizedText(null, 'en', 'en', null)).toBeNull()
	})
})
