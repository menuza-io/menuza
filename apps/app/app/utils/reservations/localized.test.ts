import { describe, expect, it } from 'vitest'
import {
	cleanLocalizedMap,
	defaultEntry,
	displayText,
	singleLanguageMap,
} from './localized.ts'

const config = { locales: ['ar', 'en', 'es'], defaultLocale: 'ar' }

describe('displayText', () => {
	it('shows the organization default language, never the interface language', () => {
		expect(displayText({ en: 'Patio', ar: 'الشرفة' }, config)).toBe('الشرفة')
	})
	it('falls back to the canonical text', () => {
		expect(displayText({}, config, 'Patio')).toBe('Patio')
		expect(displayText(null, config)).toBe('')
	})
})

describe('cleanLocalizedMap', () => {
	it('drops empty values and languages that are no longer enabled', () => {
		expect(
			cleanLocalizedMap(
				{ ar: ' الشرفة ', en: '  ', es: 'Terraza', fr: 'Terrasse' },
				config,
			),
		).toEqual({ ar: 'الشرفة', es: 'Terraza' })
	})
})

describe('defaultEntry and singleLanguageMap', () => {
	it('reads and writes the default language entry', () => {
		expect(defaultEntry({ ar: 'x', en: 'y' }, config)).toBe('x')
		expect(defaultEntry({ en: 'y' }, config)).toBe('')
		expect(singleLanguageMap(' Patio ', config)).toEqual({ ar: 'Patio' })
		expect(singleLanguageMap('  ', config)).toEqual({})
	})
})
