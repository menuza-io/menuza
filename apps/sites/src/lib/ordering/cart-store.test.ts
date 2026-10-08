import { describe, expect, it } from 'vitest'
import { createCartStore } from './cart-store.ts'
import { type CartItem } from './types.ts'

const line: CartItem = {
	id: 'line',
	itemId: 'item',
	name: 'Dish',
	basePrice: 12,
	unitPrice: 12,
	quantity: 1,
	options: [],
	instructions: '',
}

function storeWith(values: unknown[]) {
	let value: string | null = JSON.stringify(values)
	return createCartStore({
		key: 'test',
		storage: {
			getItem: () => value,
			setItem: (ignoredKey, next) => {
				value = next
			},
			removeItem: () => {
				value = null
			},
		},
	})
}

describe('cart storage', () => {
	it('discards corrupt persisted lines without breaking valid ones', () => {
		const store = storeWith([
			line,
			{ ...line, quantity: -1 },
			{ ...line, quantity: 1.5 },
			{ ...line, options: 'invalid' },
			{ ...line, unitPrice: null },
			{ ...line, options: [{ optionId: 'incomplete' }] },
		])
		expect(store.count()).toBe(1)
		expect(store.subtotal()).toBe(12)
	})

	it('merges identical choices and ignores non-finite quantity updates', () => {
		const store = storeWith([line])
		store.add({ ...line, id: 'other', quantity: 2 })
		expect(store.lines()).toHaveLength(1)
		expect(store.count()).toBe(3)
		store.setQuantity('line', NaN)
		expect(store.count()).toBe(3)
	})

	it('rejects invalid additions', () => {
		const store = storeWith([])
		expect(() => store.add({ ...line, quantity: 0 })).toThrow(
			'Invalid cart item',
		)
		expect(store.count()).toBe(0)
	})
})
