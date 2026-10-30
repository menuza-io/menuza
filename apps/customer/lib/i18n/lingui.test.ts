import { i18n } from '@lingui/core'

import { APP_LOCALES, activateLocale } from './lingui'

describe('activateLocale', () => {
	it('activates each shipped locale', () => {
		for (const locale of APP_LOCALES) {
			expect(activateLocale(locale)).toBe(locale)
			expect(i18n.locale).toBe(locale)
		}
	})

	it('normalizes region tags to the base language', () => {
		expect(activateLocale('ar-SA')).toBe('ar')
		expect(i18n.locale).toBe('ar')
		expect(activateLocale('DE-at')).toBe('de')
		expect(i18n.locale).toBe('de')
	})

	it('falls back to English for an unsupported locale', () => {
		expect(activateLocale('xx')).toBe('en')
		expect(i18n.locale).toBe('en')
	})

	it('translates with the active catalog and falls back to the source text', () => {
		activateLocale('en')
		// Catalogs are extracted at build time; before extraction a message id
		// is its own English source text.
		expect(i18n._('Sign in')).toBe('Sign in')
	})
})
