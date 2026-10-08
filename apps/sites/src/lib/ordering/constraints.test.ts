import { describe, expect, it } from 'vitest'
import { linesExcluding, remainingFor } from './constraints.ts'
import { type Constraints } from './types.ts'

const constraints: Constraints = {
	items: {
		sourdough: { inventory: 5, maxPerOrder: 2 },
		baguette: { inventory: 0 },
		croissant: { maxPerOrder: 4 },
	},
	categories: {
		loaves: { inventory: 6, name: 'Loaves' },
		pastries: { maxPerOrder: 3 },
	},
	itemCategoryIds: {
		sourdough: ['loaves'],
		baguette: ['loaves'],
		rye: ['loaves'],
		croissant: ['pastries'],
		danish: ['pastries'],
	},
}

describe('remainingFor', () => {
	it('is uncapped without constraints or rules', () => {
		expect(remainingFor('x', [], null)).toEqual({ max: null, reason: null })
		expect(remainingFor('unknown', [], constraints).max).toBeNull()
	})

	it('reports the per-order limit when it is tighter than inventory', () => {
		const result = remainingFor('sourdough', [], constraints)
		expect(result.max).toBe(2)
		expect(result.reason).toBe('limit')
		expect(result.limit).toBe(2)
		expect(result.remaining).toBe(5)
	})

	it('subtracts what is already in the cart', () => {
		const result = remainingFor(
			'sourdough',
			[{ itemId: 'sourdough', quantity: 1 }],
			constraints,
		)
		expect(result.max).toBe(1)
		expect(result.reason).toBe('limit')
	})

	it('treats zero inventory as sold out', () => {
		const result = remainingFor('baguette', [], constraints)
		expect(result.max).toBe(0)
		expect(result.reason).toBe('inventory')
		expect(result.remaining).toBe(0)
	})

	it('applies category inventory across sibling items', () => {
		const result = remainingFor(
			'rye',
			[
				{ itemId: 'sourdough', quantity: 2 },
				{ itemId: 'baguette', quantity: 3 },
			],
			constraints,
		)
		expect(result.max).toBe(1)
		expect(result.reason).toBe('category-inventory')
		expect(result.categoryName).toBe('Loaves')
	})

	it('applies category per-order limits', () => {
		const result = remainingFor(
			'croissant',
			[{ itemId: 'danish', quantity: 2 }],
			constraints,
		)
		expect(result.max).toBe(1)
		expect(result.reason).toBe('limit')
	})

	it('never goes negative', () => {
		const result = remainingFor(
			'croissant',
			[{ itemId: 'croissant', quantity: 9 }],
			constraints,
		)
		expect(result.max).toBe(0)
	})
})

describe('linesExcluding', () => {
	it('drops the given line id', () => {
		const lines = [
			{ id: 'a', itemId: 'x', quantity: 1 },
			{ id: 'b', itemId: 'y', quantity: 2 },
		]
		expect(linesExcluding(lines, 'a')).toEqual([lines[1]])
	})
})
