import { restaurantOrderRequestSchema } from '@repo/common/restaurant-orders'
import { describe, expect, it, vi } from 'vitest'
import { createCartStore } from './cart-store.ts'
import { checkoutOrderRequest } from './checkout-payload.ts'
import { upsellLine } from './upsell.ts'

/** #192: a dish in a photo test is counted when added and named in the order. */

function memoryStorage() {
	const data = new Map<string, string>()
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		removeItem: (key: string) => void data.delete(key),
	}
}

const line = {
	itemId: 'dish_1',
	name: 'Burger',
	basePrice: 12,
	unitPrice: 12,
	quantity: 1,
	options: [],
	instructions: '',
}

describe('cart add hook', () => {
	it('tells the hook which line went in, merged lines included', () => {
		const added: Array<{ itemId: string; photoTestId?: string }> = []
		const store = createCartStore({
			key: 'cart',
			storage: memoryStorage(),
			onAdd: (entry) => added.push(entry),
		})
		store.add({ ...line, photoTestId: 'test_abcdefgh' })
		store.add({ ...line, photoTestId: 'test_abcdefgh' })
		expect(added.map((entry) => entry.photoTestId)).toEqual([
			'test_abcdefgh',
			'test_abcdefgh',
		])
		expect(store.count()).toBe(2)
	})

	it('never stops a dish going into the cart when the hook throws', () => {
		const store = createCartStore({
			key: 'cart',
			storage: memoryStorage(),
			onAdd: () => {
				throw new Error('counter down')
			},
		})
		expect(() => store.add(line)).not.toThrow()
		expect(store.count()).toBe(1)
	})

	it('loads a cart saved before photo tests existed', () => {
		const storage = memoryStorage()
		storage.setItem(
			'cart',
			JSON.stringify([{ ...line, id: 'cart_1', options: [] }]),
		)
		const store = createCartStore({ key: 'cart', storage })
		expect(store.lines()).toHaveLength(1)
		expect(store.lines()[0]).not.toHaveProperty('photoTestId')
	})

	it('keeps the test on a line added from "Goes well with"', () => {
		const tested = {
			id: 'dish_1',
			displayName: 'Burger',
			price: 12,
			variations: { groups: [], variants: [] },
			modifierGroups: [],
			photoTest: {
				id: 'test_abcdefgh',
				imageUrlB: 'https://cdn.test/b.jpg',
				imageFocalB: null,
			},
		}
		expect(upsellLine(tested).photoTestId).toBe('test_abcdefgh')
		expect(upsellLine({ ...tested, photoTest: undefined })).not.toHaveProperty(
			'photoTestId',
		)
	})

	it('does not break the funnel event', () => {
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
			storage: memoryStorage(),
			onAdd: () => {},
		})
		store.add(line)
		vi.unstubAllGlobals()
		expect(events.map((event) => event.type)).toEqual(['menuza:cart-add'])
	})
})

describe('the order body', () => {
	const core = {
		locale: 'en',
		fulfillment: 'pickup',
		lines: [{ itemId: 'dish_1', quantity: 1, instructions: '', options: [] }],
		contact: { name: 'Ada', phone: '+15550100', email: 'a@x.test' },
	}
	const tests = [
		{ testId: 'test_abcdefgh', itemId: 'dish_1', variant: 'B' as const },
	]

	it('carries photoTests only when a dish in the cart is in a test', () => {
		expect(checkoutOrderRequest(core, 'key')).not.toHaveProperty('photoTests')
		expect(
			checkoutOrderRequest(core, 'key', null, null, []),
		).not.toHaveProperty('photoTests')
		expect(
			checkoutOrderRequest(core, 'key', null, null, null),
		).not.toHaveProperty('photoTests')
		expect(
			checkoutOrderRequest(core, 'key', null, null, tests).photoTests,
		).toEqual(tests)
	})

	it('keeps the attempt key out of it and leaves the other keys alone', () => {
		const body = checkoutOrderRequest(core, 'key', null, null, tests)
		expect(body).toEqual({ ...core, photoTests: tests, idempotencyKey: 'key' })
	})

	it('is accepted by the region schema, and the schema stays strict', () => {
		const valid = {
			...core,
			locationId: 'loc_1',
			paymentMethod: 'handoff',
			idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
		}
		const accepted = restaurantOrderRequestSchema.safeParse(
			checkoutOrderRequest(valid, valid.idempotencyKey, null, null, tests),
		)
		expect(accepted.error?.issues).toBeUndefined()
		const send = (photoTests: unknown) =>
			restaurantOrderRequestSchema.safeParse({ ...valid, photoTests }).success
		expect(send(tests)).toBe(true)
		expect(send([{ ...tests[0], clientId: 'leak' }])).toBe(false)
		expect(send([{ ...tests[0], variant: 'C' }])).toBe(false)
	})
})
