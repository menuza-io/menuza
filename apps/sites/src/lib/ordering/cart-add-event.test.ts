import { afterEach, describe, expect, it, vi } from 'vitest'
import { CART_ADD_EVENT, createCartStore } from './cart-store'

describe('cart add announcement (#179)', () => {
	afterEach(() => vi.unstubAllGlobals())

	it('tells the window a dish went in, carrying nothing', () => {
		const events: Event[] = []
		vi.stubGlobal('window', {
			addEventListener: () => {},
			dispatchEvent: (event: Event) => {
				events.push(event)
				return true
			},
		})
		const store = createCartStore({
			key: 'cart',
			storage: {
				getItem: () => null,
				setItem: () => {},
				removeItem: () => {},
			},
		})
		store.add({
			itemId: 'dish',
			name: 'Margherita',
			basePrice: 12,
			unitPrice: 12,
			quantity: 1,
			options: [],
			instructions: '',
		})
		expect(events.map((event) => event.type)).toEqual([CART_ADD_EVENT])
		expect('detail' in events[0]!).toBe(false)
	})
})
