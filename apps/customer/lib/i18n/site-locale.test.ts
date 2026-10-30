import {
	CONTENT_LOCALES,
	availableAppLocales,
	createAppLanguage,
	isRtlLocale,
	isSupportedLocale,
	localeLabel,
	matchLocale,
	negotiateLocale,
	normalizeLocale,
	resolveAppLanguage,
	resolvedOrganizationDefaultLocale,
	resolvedOrganizationLocale,
	resolvedOrganizationLocales,
} from './site-locale'

describe('SiteLocale (ported from SiteLocaleTests.swift)', () => {
	it('normalizes locale codes', () => {
		expect(normalizeLocale('ar-SA')).toBe('ar')
		expect(normalizeLocale('EN')).toBe('en')
		expect(normalizeLocale('')).toBe('en')
	})

	it('knows the shared content locales', () => {
		expect(CONTENT_LOCALES).toEqual(['en', 'ar', 'es', 'fr', 'de', 'zh'])
		expect(isRtlLocale('ar')).toBe(true)
		expect(isRtlLocale('en')).toBe(false)
		expect(localeLabel('zh')).toBe('Chinese')
		expect(localeLabel('pt')).toBe('pt')
	})

	it('negotiates exact, then language, then the default', () => {
		expect(negotiateLocale(['ar-SA'], ['en', 'ar'], 'en')).toBe('ar')
		expect(negotiateLocale(['fr-CA', 'de'], ['en', 'de'], 'en')).toBe('de')
		expect(negotiateLocale(['pt-BR'], ['en', 'ar'], 'ar')).toBe('ar')
		expect(negotiateLocale([], [], 'en')).toBe('en')
	})

	it('prefers the customer override', () => {
		const organization = {
			locales: ['en', 'ar'],
			defaultLocale: 'en',
			locale: 'en',
		}
		const language = resolveAppLanguage({
			organization,
			deviceLanguages: ['en-US'],
			appLocales: ['en', 'ar'],
			override: 'ar',
		})
		expect(language.code).toBe('ar')
		expect(language.isRtl).toBe(true)
	})

	it('follows the translated device language', () => {
		const organization = {
			locales: ['en', 'ar'],
			defaultLocale: 'en',
			locale: 'ar',
		}
		const language = resolveAppLanguage({
			organization,
			deviceLanguages: ['de-DE', 'en-US'],
			appLocales: ['en', 'de', 'ar'],
		})
		expect(language.code).toBe('de')
		expect(language.isRtl).toBe(false)
	})

	it('falls back to the organization locale when the device is untranslated', () => {
		const organization = { locales: ['ar'], defaultLocale: 'ar', locale: 'ar' }
		const language = resolveAppLanguage({
			organization,
			deviceLanguages: ['ja-JP'],
			appLocales: ['en', 'ar'],
		})
		expect(language.code).toBe('ar')
		expect(language.isRtl).toBe(true)
	})

	it('falls back to English without a translated match', () => {
		expect(
			resolveAppLanguage({
				organization: null,
				deviceLanguages: ['ja-JP'],
				appLocales: ['en', 'ar'],
			}).code,
		).toBe('en')
	})
})

describe('SiteLocale (ported from the Android SiteLocaleTest)', () => {
	const organization = (locale?: string, defaultLocale?: string) => ({
		locales: ['en', 'ar'],
		defaultLocale,
		locale,
	})

	it('normalizes tags', () => {
		expect(normalizeLocale('AR-SA')).toBe('ar')
		expect(normalizeLocale('  ')).toBe('en')
	})

	it('matches exact then language', () => {
		expect(matchLocale(['ar-SA'], ['en', 'ar'])).toBe('ar')
		expect(matchLocale(['en-GB'], ['en', 'ar'])).toBe('en')
		expect(matchLocale(['ja'], ['en', 'ar'])).toBeNull()
	})

	it('negotiates to the default, then the first supported locale', () => {
		expect(negotiateLocale(['ja'], ['en', 'ar'], 'ar')).toBe('ar')
		expect(negotiateLocale(['ja'], ['en', 'ar'], 'ja')).toBe('en')
	})

	it('lets the override win', () => {
		expect(
			resolveAppLanguage({
				organization: organization('ar'),
				deviceLanguages: ['de-DE'],
				appLocales: CONTENT_LOCALES,
				override: 'en',
			}).code,
		).toBe('en')
	})

	it('lets the device language win over the organization locale', () => {
		expect(
			resolveAppLanguage({
				organization: organization('ar'),
				deviceLanguages: ['de-DE'],
				appLocales: CONTENT_LOCALES,
			}).code,
		).toBe('de')
	})

	it('uses the organization locale when the device language is not translated', () => {
		const language = resolveAppLanguage({
			organization: organization('ar'),
			deviceLanguages: ['ja-JP'],
			appLocales: CONTENT_LOCALES,
		})
		expect(language.code).toBe('ar')
		expect(language.isRtl).toBe(true)
	})

	it('falls back to English without an organization', () => {
		const language = resolveAppLanguage({
			organization: null,
			deviceLanguages: ['ja-JP'],
			appLocales: CONTENT_LOCALES,
		})
		expect(language.code).toBe('en')
		expect(language.isRtl).toBe(false)
	})
})

describe('SiteLocale details', () => {
	it('normalizes like Swift split, which drops empty pieces', () => {
		expect(normalizeLocale(' zh-Hant-TW ')).toBe('zh')
		expect(normalizeLocale('-ar')).toBe('ar')
		expect(normalizeLocale('-')).toBe('-')
		expect(normalizeLocale('en_US')).toBe('en_us')
	})

	it('reports support, labels and direction for regional tags', () => {
		expect(isSupportedLocale('fr-CA')).toBe(true)
		expect(isSupportedLocale('pt')).toBe(false)
		expect(localeLabel('AR-sa')).toBe('Arabic')
		expect(localeLabel('constructor')).toBe('constructor')
		expect(isRtlLocale('ar-EG')).toBe(true)
	})

	it('matches the first preference that has any match', () => {
		expect(matchLocale(['', 'es-MX', 'en'], ['en', 'es'])).toBe('es')
		expect(matchLocale(['EN-us'], ['en-US', 'ar'])).toBe('en')
	})

	it('builds app languages from normalized codes', () => {
		expect(createAppLanguage()).toEqual({
			code: 'en',
			isRtl: false,
			displayName: 'English',
		})
		expect(createAppLanguage('AR-SA')).toEqual({
			code: 'ar',
			isRtl: true,
			displayName: 'Arabic',
		})
	})

	it('negotiates the override against the app locales with English as default', () => {
		expect(
			resolveAppLanguage({
				organization: { locales: ['en', 'ar'] },
				deviceLanguages: ['ar'],
				appLocales: ['en', 'ar'],
				override: 'ja',
			}).code,
		).toBe('en')
		expect(
			resolveAppLanguage({
				organization: null,
				deviceLanguages: [],
				appLocales: ['ar'],
				override: 'ja',
			}).code,
		).toBe('ar')
	})

	it('ignores an empty override', () => {
		expect(
			resolveAppLanguage({
				organization: null,
				deviceLanguages: ['fr-FR'],
				appLocales: CONTENT_LOCALES,
				override: '',
			}).code,
		).toBe('fr')
	})

	it('treats empty app locales as every content locale', () => {
		expect(
			resolveAppLanguage({
				organization: null,
				deviceLanguages: ['zh-CN'],
				appLocales: [],
			}).code,
		).toBe('zh')
	})

	it('falls back from the organization locale to its default, then English', () => {
		expect(
			resolveAppLanguage({
				organization: { locale: 'ja', defaultLocale: 'ar' },
				deviceLanguages: ['ko'],
				appLocales: ['en', 'ar'],
			}).code,
		).toBe('ar')
		expect(
			resolveAppLanguage({
				organization: { locale: 'ja', defaultLocale: 'ko' },
				deviceLanguages: ['ko'],
				appLocales: ['ar', 'en'],
			}).code,
		).toBe('en')
		expect(
			resolveAppLanguage({
				organization: {},
				deviceLanguages: [],
				appLocales: ['ar', 'en'],
			}).code,
		).toBe('en')
	})

	it('resolves the organization locale fields', () => {
		expect(resolvedOrganizationLocales({})).toEqual(['en'])
		expect(resolvedOrganizationLocales({ locales: ['', 'ar'] })).toEqual(['ar'])
		expect(resolvedOrganizationDefaultLocale({ defaultLocale: '' })).toBe('en')
		expect(resolvedOrganizationLocale({ defaultLocale: 'ar' })).toBe('ar')
		expect(
			resolvedOrganizationLocale({ locale: 'fr', defaultLocale: 'ar' }),
		).toBe('fr')
	})

	it('lists the shipped content locales in content order', () => {
		expect(availableAppLocales(['ar', 'en', 'Base', 'ar-SA'])).toEqual([
			'en',
			'ar',
		])
		expect(availableAppLocales(['Base', 'pt'])).toEqual(['en'])
		expect(availableAppLocales([])).toEqual(['en'])
	})
})
