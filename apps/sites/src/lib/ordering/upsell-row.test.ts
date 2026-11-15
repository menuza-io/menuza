// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi } from 'vitest'
import { type OrderingItem } from './types.ts'
import { buildUpsellRow } from './upsell-row.ts'

const dish = (id: string, patch: Partial<OrderingItem> = {}): OrderingItem => ({
	id,
	displayName: `Dish ${id}`,
	price: 4.5,
	imageUrl: `https://img.example/${id}.jpg`,
	variations: { groups: [], variants: [] },
	modifierGroups: [],
	...patch,
})

const labels = {
	heading: 'Goes well with',
	add: 'Add',
	addNamed: 'Add {name}',
}

function row(items: OrderingItem[], onAdd = vi.fn()) {
	return {
		node: buildUpsellRow({
			items,
			labels,
			formatMoney: (amount) => `$${amount.toFixed(2)}`,
			onAdd,
			place: 'cart',
		}),
		onAdd,
	}
}

describe('buildUpsellRow', () => {
	it('is absent when there is nothing to suggest', () => {
		expect(row([]).node).toBeNull()
	})

	it('shows each dish with its photo, price and an Add button', () => {
		const { node } = row([dish('a'), dish('b')])
		document.body.replaceChildren(node!)
		expect(node).toHaveAttribute('data-upsell-row', 'cart')
		expect(
			document.querySelector('h3'),
		).toHaveTextContent('Goes well with')
		expect(node).toHaveAttribute('aria-labelledby', 'upsell-heading-cart')
		const rows = [...document.querySelectorAll('li')]
		expect(rows).toHaveLength(2)
		expect(rows[0]).toHaveTextContent('Dish a')
		expect(rows[0]).toHaveTextContent('$4.50')
		expect(rows[0]?.querySelector('img')).toHaveAttribute(
			'src',
			'https://img.example/a.jpg',
		)
		// The photo is decorative: the name beside it says what it is.
		expect(rows[0]?.querySelector('img')).toHaveAttribute('alt', '')
		const add = rows[0]!.querySelector('button')!
		expect(add).toHaveTextContent('Add')
		expect(add).toHaveAccessibleName('Add Dish a')
	})

	it('omits the photo for a dish without one', () => {
		const { node } = row([dish('a', { imageUrl: null })])
		document.body.replaceChildren(node!)
		expect(document.querySelector('img')).toBeNull()
	})

	it('reports the dish and the button that was tapped', () => {
		const onAdd = vi.fn()
		const { node } = row([dish('a'), dish('b')], onAdd)
		document.body.replaceChildren(node!)
		const buttons = document.querySelectorAll('button')
		buttons[1]!.click()
		expect(onAdd).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'b' }),
			buttons[1],
		)
	})

	it('marks a dish that opens the item modal', () => {
		const sized = dish('s', {
			variations: {
				groups: [{ id: 'g', name: 'Size', values: [{ id: 'x', name: 'S' }] }],
				variants: [
					{ id: 'v', valueIds: ['x'], price: 3, availabilityStatus: 'available' },
				],
			},
		})
		const { node } = row([sized, dish('plain')])
		document.body.replaceChildren(node!)
		const [first, second] = [...document.querySelectorAll('button')]
		expect(first).toHaveAttribute('data-opens-modal', 'true')
		expect(second).not.toHaveAttribute('data-opens-modal')
	})

	it('writes dish names as text, never as markup', () => {
		const { node } = row([dish('a', { displayName: '<img src=x onerror=alert(1)>' })])
		document.body.replaceChildren(node!)
		expect(document.querySelectorAll('img[src="x"]')).toHaveLength(0)
		expect(document.querySelector('li')).toHaveTextContent(
			'<img src=x onerror=alert(1)>',
		)
	})
})
