import { describe, expect, it } from 'vitest'
import { changedDiscountKeys } from './history.server.ts'

describe('changedDiscountKeys', () => {
	it('lists only the keys whose values differ', () => {
		expect(
			changedDiscountKeys(
				{ name: 'A', percentBp: 1000, target: { itemIds: ['x'] } },
				{ name: 'B', percentBp: 1000, target: { itemIds: ['x'] } },
			),
		).toEqual(['name'])
	})

	it('sees nested changes and added or removed keys', () => {
		expect(
			changedDiscountKeys(
				{ target: { itemIds: ['x'] }, gone: 1 },
				{ target: { itemIds: ['x', 'y'] }, added: 2 },
			),
		).toEqual(['target', 'added', 'gone'])
	})

	it('is empty when nothing changed', () => {
		expect(changedDiscountKeys({ a: [1, 2] }, { a: [1, 2] })).toEqual([])
	})
})
