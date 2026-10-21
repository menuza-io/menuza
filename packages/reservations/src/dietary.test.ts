import { describe, expect, it } from 'vitest'
import { extractDietaryCodes } from './dietary.ts'

describe('extractDietaryCodes', () => {
	it('reads codes and labels, drops free text and duplicates', () => {
		expect(
			extractDietaryCodes('nut_allergy, Gluten-Free; nut allergy'),
		).toEqual(['nut_allergy', 'gluten_free'])
		expect(
			extractDietaryCodes('No peanuts, mother-in-law hates onions'),
		).toEqual([])
		expect(extractDietaryCodes(null)).toEqual([])
	})
})
