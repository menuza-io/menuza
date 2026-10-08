import { describe, expect, it } from 'vitest'
import { sttLanguageFor } from './language.ts'

describe('sttLanguageFor', () => {
	it('uses Deepgram multi for English and Spanish together', () => {
		expect(sttLanguageFor(['en', 'es'], 'en')).toBe('multi')
		expect(sttLanguageFor(['es', 'en'], 'es')).toBe('multi')
	})

	it('listens in one language at a time when Arabic is among them', () => {
		expect(sttLanguageFor(['en', 'ar'], 'en')).toBe('en')
		expect(sttLanguageFor(['ar', 'en', 'es'], 'ar')).toBe('ar')
		expect(sttLanguageFor(['en', 'ar'], 'ar')).toBe('ar')
	})

	it('uses the only language on a single-language line', () => {
		expect(sttLanguageFor(['es'], 'es')).toBe('es')
		expect(sttLanguageFor(['ar'], 'ar')).toBe('ar')
	})
})
