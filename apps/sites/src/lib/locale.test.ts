import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserLocale, browserLocaleHref } from './locale.ts'

function page(lang: string, defaultLocale?: string) {
	vi.stubGlobal('document', {
		documentElement: { lang, dataset: { defaultLocale } },
	})
}

afterEach(() => vi.unstubAllGlobals())

describe('browserLocale', () => {
	it('is the language the Sites locale resolution put on the page', () => {
		page('es', 'en')
		expect(browserLocale()).toBe('es')
		expect(browserLocaleHref('/reserve')).toBe('/es/reserve')
	})

	it('falls back to the organization default language, not to English', () => {
		page('', 'ar')
		expect(browserLocale()).toBe('ar')
		expect(browserLocaleHref('/reserve')).toBe('/reserve')
	})

	it('falls back to the platform default only when the page names nothing', () => {
		page('')
		expect(browserLocale()).toBe('en')
	})
})
