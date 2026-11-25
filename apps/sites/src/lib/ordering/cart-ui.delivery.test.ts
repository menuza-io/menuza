// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createCartStore } from './cart-store.ts'
import { mountCartUi } from './cart-ui.ts'
import { deliveryFeeForCart, deliveryFeeHint } from './delivery-fee.ts'
import { type OrderingLabels } from './types.ts'

const pricing = {
	baseFee: 5,
	steps: [
		{ from: 10, fee: 5 },
		{ from: 20, fee: 3 },
		{ from: 40, fee: 0 },
	],
	byDistance: false,
}
const delivery = { deliveryFee: 5, pricing }

const labels = {
	itemsCount: '{count} items',
	emptyCartTitle: 'Empty',
	emptyCartDesc: 'Nothing',
	deliveryHintFree: 'Add {amount} more for free delivery',
	deliveryHintLower: 'Add {amount} more and delivery is {fee}',
} as unknown as OrderingLabels

const money = (amount: number) => `$${amount.toFixed(2)}`

function memory() {
	const map = new Map<string, string>()
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
		removeItem: (key: string) => void map.delete(key),
	}
}

function mount(mode: 'delivery' | 'pickup' = 'delivery') {
	document.body.innerHTML = `
		<div id="cart-items-container"></div>
		<span id="drawer-subtotal"></span>
		<div id="drawer-delivery-row" class="hidden"><dd id="drawer-delivery-fee"></dd></div>
		<p id="drawer-delivery-hint" class="hidden"></p>
		<span id="drawer-total"></span>`
	const store = createCartStore({ key: 'cart', storage: memory() })
	const ui = mountCartUi({
		store,
		labels,
		formatMoney: money,
		totals: {
			taxRate: 0,
			deliveryFee: (subtotal) => deliveryFeeForCart(delivery, subtotal),
			deliveryHint: (subtotal) => deliveryFeeHint(delivery, subtotal),
			mode: () => mode,
		},
		gate: () => ({ allowed: true }),
	})
	return { store, ui }
}

const line = (price: number, itemId = 'i1') => ({
	itemId,
	name: 'Burger',
	instructions: '',
	quantity: 1,
	unitPrice: price,
	basePrice: price,
	options: [],
})

describe('cart drawer: delivery fee by order size (#244)', () => {
	beforeEach(() => {
		document.body.innerHTML = ''
	})

	it('prices the fee by the cart and says how much more unlocks the next step', () => {
		const { store } = mount()
		store.add(line(14))
		const fee = () => document.getElementById('drawer-delivery-fee')!.textContent
		const hint = document.getElementById('drawer-delivery-hint')!
		expect(fee()).toBe('$5.00')
		expect(hint.textContent).toBe('Add $6.00 more and delivery is $3.00')
		expect(hint.classList.contains('hidden')).toBe(false)

		store.add(line(20, 'i2'))
		expect(fee()).toBe('$3.00')
		expect(hint.textContent).toBe('Add $6.00 more for free delivery')

		// Above the last step the fee is gone, and so is the hint.
		store.add(line(30, 'i3'))
		expect(
			document.getElementById('drawer-delivery-row')!.classList.contains('hidden'),
		).toBe(true)
		expect(hint.textContent).toBe('')
		expect(hint.classList.contains('hidden')).toBe(true)
	})

	it('shows no hint for pickup', () => {
		const { store } = mount('pickup')
		store.add(line(14))
		expect(document.getElementById('drawer-delivery-hint')!.textContent).toBe('')
	})
})
