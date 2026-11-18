import { describe, expect, it } from 'vitest'
import {
	cardMatches,
	dietAttribute,
	dietaryTagsInMenu,
} from './dietary-filter.ts'

const cards = [
	{
		id: 'falafel',
		search: 'falafel',
		diet: dietAttribute({ dietaryTags: ['vegan', 'halal'] }),
	},
	{
		id: 'omelette',
		search: 'omelette',
		diet: dietAttribute({ isVegetarian: true }),
	},
	{
		id: 'kebab',
		search: 'kebab',
		diet: dietAttribute({ dietaryTags: ['halal', 'spicy', 'future_tag'] }),
	},
	{ id: 'beer', search: 'beer', diet: dietAttribute({}) },
]

const shown = (query: string, selected: string[]) =>
	cards
		.filter((card) => cardMatches(card, query, selected))
		.map((card) => card.id)

describe('website dietary filter (#335)', () => {
	it('choosing Vegan shows only dishes tagged vegan', () => {
		expect(shown('', ['vegan'])).toEqual(['falafel'])
	})

	it('combines choices as "has all" and counts vegan as vegetarian', () => {
		expect(shown('', ['halal'])).toEqual(['falafel', 'kebab'])
		expect(shown('', ['halal', 'spicy'])).toEqual(['kebab'])
		expect(shown('', ['vegetarian'])).toEqual(['falafel', 'omelette'])
		expect(shown('', [])).toEqual(['falafel', 'omelette', 'kebab', 'beer'])
	})

	it('works together with the search box', () => {
		expect(shown('keb', ['halal'])).toEqual(['kebab'])
		expect(shown('keb', ['vegan'])).toEqual([])
	})

	it('reads old records and ignores unknown tags', () => {
		expect(dietAttribute({ isVegetarian: true, isGlutenFree: true })).toBe(
			'vegetarian gluten_free',
		)
		expect(cards[2]!.diet).toBe('halal spicy')
		expect(
			dietaryTagsInMenu([
				{ dietaryTags: ['vegan'] },
				{ dietaryTags: ['spicy', 'x'] },
			]),
		).toEqual(['vegan', 'vegetarian', 'spicy'])
	})
})
