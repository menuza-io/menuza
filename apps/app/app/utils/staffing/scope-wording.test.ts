import { setupI18n } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import {
	createScopeWordingI18n,
	scopeWordingFor,
	swapScopeWords,
	withScopeWording,
} from './scope-wording.ts'

describe('scopeWordingFor', () => {
	it('is workplace for the one implicit scope and location for anything else', () => {
		expect(scopeWordingFor([{ id: 'main' }])).toBe('workplace')
		expect(scopeWordingFor([])).toBe('workplace')
		expect(scopeWordingFor([{ id: 'loc_a' }, { id: 'loc_b' }])).toBe('location')
		expect(scopeWordingFor([{ id: 'loc_a' }])).toBe('location')
	})
})

describe('swapScopeWords', () => {
	it('swaps the English word, keeping case and number', () => {
		expect(swapScopeWords('Workplace', 'en')).toBe('Location')
		expect(swapScopeWords('All workplaces', 'en')).toBe('All locations')
		expect(swapScopeWords("this workplace's time zone", 'en')).toBe(
			"this location's time zone",
		)
		expect(swapScopeWords('Nothing to change', 'en')).toBe('Nothing to change')
	})

	it('swaps the Arabic forms, definite, indefinite and with a pronoun', () => {
		expect(swapScopeWords('جميع أماكن العمل', 'ar')).toBe('جميع الفروع')
		expect(swapScopeWords('اختر مكان العمل', 'ar')).toBe('اختر الفرع')
		expect(swapScopeWords('إضافة إلى مكان عمل', 'ar')).toBe('إضافة إلى فرع')
		expect(swapScopeWords('مناصبهم وأماكن عملهم', 'ar')).toBe('مناصبهم وفروعهم')
	})

	it('leaves other locales alone', () => {
		expect(swapScopeWords('workplace', 'fr')).toBe('workplace')
	})
})

describe('withScopeWording', () => {
	it('swaps strings and plural branches but never variable names', () => {
		const messages = {
			a: 'Add to a workplace',
			b: [
				[
					'workplaces',
					'plural',
					{ one: ['# workplace'], other: ['# workplaces'] },
				],
			],
		}
		expect(withScopeWording(messages as never, 'en')).toEqual({
			a: 'Add to a location',
			b: [
				[
					'workplaces',
					'plural',
					{ one: ['# location'], other: ['# locations'] },
				],
			],
		})
	})
})

describe('createScopeWordingI18n', () => {
	it('speaks like the base catalog with the word swapped, and caches per catalog', () => {
		const base = setupI18n({
			locale: 'en',
			messages: { en: { greet: 'Pick a workplace' } },
		})
		const derived = createScopeWordingI18n(base)
		expect(base._('greet')).toBe('Pick a workplace')
		expect(derived._('greet')).toBe('Pick a location')
		expect(createScopeWordingI18n(base)).toBe(derived)
	})
})
