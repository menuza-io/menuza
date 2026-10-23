import { describe, expect, it } from 'vitest'
import {
	getLocaleHref,
	getSiteLocaleLabel,
	getSiteLocaleNativeLabel,
	isReservedSiteLocaleSlug,
	negotiateSiteLocale,
	getLocalizedEditableValue,
	parseLocalizedString,
	parseSiteLocalesConfig,
	pickLocalized,
	resolveSiteLocaleRequest,
	serializeLocalizedString,
} from './site-locales.ts'

describe('site-locales', () => {
	it.each([
		['en', 'English'],
		['ar', 'العربية'],
		['es', 'Español'],
		['fr', 'Français'],
		['de', 'Deutsch'],
		['zh', '中文'],
	])('always displays %s in its own language', (locale, label) => {
		expect(getSiteLocaleNativeLabel(locale)).toBe(label)
	})

	it('preserves the locale code for unsupported native language labels', () => {
		expect(getSiteLocaleNativeLabel('unknown')).toBe('unknown')
	})

	it('keeps existing English labels available to operator interfaces', () => {
		expect(getSiteLocaleLabel('ar')).toBe('Arabic')
		expect(getSiteLocaleLabel('de')).toBe('German')
	})

	it('parses locales config with defaults', () => {
		expect(parseSiteLocalesConfig(null, null)).toEqual({
			locales: ['en'],
			defaultLocale: 'en',
		})

		expect(parseSiteLocalesConfig(JSON.stringify(['en', 'ar']), 'ar')).toEqual({
			locales: ['en', 'ar'],
			defaultLocale: 'ar',
		})
	})

	it('parses legacy plain strings and JSON maps', () => {
		expect(parseLocalizedString('Hello', 'en')).toEqual({ en: 'Hello' })
		expect(parseLocalizedString('{"en":"Hi","ar":"مرحبا"}')).toEqual({
			en: 'Hi',
			ar: 'مرحبا',
		})
	})

	it('picks localized content with fallback', () => {
		const map = { en: 'Hello', ar: 'مرحبا' }
		expect(pickLocalized(map, 'ar', 'en')).toBe('مرحبا')
		expect(pickLocalized(map, 'fr', 'en')).toBe('Hello')
		expect(pickLocalized(map, 'fr-FR', 'de')).toBe('Hello')
	})

	it('preserves spaces for editable localized values', () => {
		expect(getLocalizedEditableValue('{"en":"Hello "}', 'en', 'en')).toBe(
			'Hello ',
		)
		expect(getLocalizedEditableValue('{"en":" "}', 'en', 'en')).toBe(' ')
		expect(getLocalizedEditableValue('Plain text ', 'en', 'en')).toBe(
			'Plain text ',
		)
	})

	it('serializes localized strings without empty values', () => {
		expect(
			serializeLocalizedString({ en: 'Hello', ar: '  ', fr: 'Bonjour' }),
		).toBe('{"en":"Hello","fr":"Bonjour"}')
	})

	it('negotiates supported locales', () => {
		expect(negotiateSiteLocale(['fr-FR', 'en'], ['en', 'ar'], 'en')).toBe('en')
		expect(negotiateSiteLocale('ar', ['en', 'ar'], 'en')).toBe('ar')
		expect(negotiateSiteLocale(['de'], ['en', 'ar'], 'ar')).toBe('ar')
	})

	it('reserves catalog locale codes as page slugs', () => {
		expect(isReservedSiteLocaleSlug('ar')).toBe(true)
		expect(isReservedSiteLocaleSlug('zh')).toBe(true)
		expect(isReservedSiteLocaleSlug('id')).toBe(false)
		expect(isReservedSiteLocaleSlug('about')).toBe(false)
		expect(isReservedSiteLocaleSlug('en-us')).toBe(false)
	})

	it('builds unprefixed hrefs for the default locale', () => {
		expect(getLocaleHref('/about', 'en', 'en', 'en')).toBe('/about')
		expect(getLocaleHref('/ar/about', 'en', 'ar', 'en')).toBe('/about')
		expect(getLocaleHref('/about', 'ar', 'ar', 'ar')).toBe('/about')
		expect(getLocaleHref('/', 'en', 'ar', 'en')).toBe('/')
	})

	it('prefixes non-default locales and never doubles the prefix', () => {
		expect(getLocaleHref('/about', 'ar', 'en', 'en')).toBe('/ar/about')
		expect(getLocaleHref('/ar/about', 'ar', 'ar', 'en')).toBe('/ar/about')
		expect(getLocaleHref('/about?preview=true', 'ar', 'en', 'en')).toBe(
			'/ar/about?preview=true',
		)
		expect(getLocaleHref('https://example.com', 'ar', 'en', 'en')).toBe(
			'https://example.com',
		)
	})

	it('rewrites enabled non-default prefixes and 301s default prefixes', () => {
		expect(
			resolveSiteLocaleRequest({
				pathname: '/ar/about',
				enabledLocales: ['en', 'ar'],
				defaultLocale: 'en',
			}),
		).toEqual({
			kind: 'rewrite',
			pathname: '/about',
			search: '',
			locale: 'ar',
		})

		expect(
			resolveSiteLocaleRequest({
				pathname: '/en/about',
				enabledLocales: ['en', 'ar'],
				defaultLocale: 'en',
			}),
		).toEqual({ kind: 'redirect', location: '/about' })

		expect(
			resolveSiteLocaleRequest({
				pathname: '/about',
				search: '?lng=ar&preview=true',
				enabledLocales: ['en', 'ar'],
				defaultLocale: 'en',
			}),
		).toEqual({ kind: 'redirect', location: '/ar/about?preview=true' })

		expect(
			resolveSiteLocaleRequest({
				pathname: '/fr/about',
				enabledLocales: ['en', 'ar'],
				defaultLocale: 'en',
			}),
		).toEqual({ kind: 'not_found' })

		expect(
			resolveSiteLocaleRequest({
				pathname: '/about',
				enabledLocales: ['en', 'ar'],
				defaultLocale: 'en',
			}),
		).toEqual({ kind: 'ok', locale: 'en' })
	})
})
