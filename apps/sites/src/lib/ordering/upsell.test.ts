import { describe, expect, it, vi } from 'vitest'
import {
	type CartLine,
	type Constraints,
	type OrderingCategory,
	type OrderingItem,
} from './types.ts'
import { addSuggestion, suggestForCart, upsellNeedsChoices } from './upsell.ts'

const dish = (id: string, patch: Partial<OrderingItem> = {}): OrderingItem => ({
	id,
	displayName: id,
	price: 5,
	variations: { groups: [], variants: [] },
	modifierGroups: [],
	availabilityStatus: 'available',
	...patch,
})

const categories: OrderingCategory[] = [
	{
		id: 'burgers',
		displayName: 'Burgers',
		upsellCategoryIds: ['drinks'],
		items: [dish('burger')],
	},
	{
		id: 'drinks',
		displayName: 'Drinks',
		items: [dish('cola'), dish('lemonade'), dish('water')],
	},
	{
		id: 'sides',
		displayName: 'Sides',
		items: [dish('fries', { isUpsell: true })],
	},
]

const line = (itemId: string, quantity = 1): CartLine => ({ itemId, quantity })
const names = (items: OrderingItem[]) => items.map((item) => item.id)

const sized = (id: string) =>
	dish(id, {
		variations: {
			groups: [{ id: 'g', name: 'Size', values: [{ id: 's', name: 'S' }] }],
			variants: [
				{ id: 'v', valueIds: ['s'], price: 3, availabilityStatus: 'available' },
			],
		},
	})

const group = (minSelections: number) => ({
	id: 'g',
	name: 'Sauce',
	selectionType: 'single' as const,
	minSelections,
	maxSelections: 1,
	options: [],
})

describe('suggestForCart', () => {
	it('suggests drinks for a burger when Drinks is an upsell category of Burgers', () => {
		expect(
			names(suggestForCart({ categories, lines: [line('burger')], offered: true })),
		).toEqual(['cola', 'lemonade', 'water', 'fries'])
	})

	it('hides the row when the cart is empty', () => {
		expect(suggestForCart({ categories, lines: [], offered: true })).toEqual([])
	})

	it('hides the row when nothing is left to suggest', () => {
		expect(
			suggestForCart({
				categories: [{ id: 'c', displayName: 'C', items: [dish('only')] }],
				lines: [line('only')],
				offered: true,
			}),
		).toEqual([])
	})

	it('suggests nothing for an order type the location does not offer', () => {
		expect(
			suggestForCart({ categories, lines: [line('burger')], offered: false }),
		).toEqual([])
	})

	it('never suggests what is in the cart or sold out', () => {
		const soldOut = categories.map((category) =>
			category.id === 'drinks'
				? {
						...category,
						items: [
							dish('cola', { availabilityStatus: 'unavailable' }),
							dish('lemonade'),
							dish('water'),
						],
					}
				: category,
		)
		expect(
			names(
				suggestForCart({
					categories: soldOut,
					lines: [line('burger'), line('water')],
					offered: true,
				}),
			),
		).toEqual(['lemonade', 'fries'])
	})

	it('skips a dish already at its per-order limit or out of stock', () => {
		const constraints: Constraints = {
			items: { cola: { maxPerOrder: 1 }, lemonade: { inventory: 0 } },
		}
		expect(
			names(
				suggestForCart({
					categories,
					lines: [line('burger'), line('cola')],
					offered: true,
					constraints,
				}),
			),
		).toEqual(['water', 'fries'])
	})

	it('keeps a dish that still has room under a limit', () => {
		const constraints: Constraints = { items: { cola: { maxPerOrder: 3 } } }
		expect(
			names(
				suggestForCart({
					categories,
					lines: [line('burger')],
					offered: true,
					constraints,
				}),
			),
		).toContain('cola')
	})

	it('can keep to dishes that go straight in', () => {
		const withChoices = categories.map((category) =>
			category.id === 'drinks'
				? { ...category, items: [sized('cola'), dish('water')] }
				: category,
		)
		expect(
			names(
				suggestForCart({
					categories: withChoices,
					lines: [line('burger')],
					offered: true,
					oneTapOnly: true,
				}),
			),
		).toEqual(['water', 'fries'])
	})

	it('caps the row at six dishes', () => {
		const many: OrderingCategory[] = [
			categories[0]!,
			{
				id: 'drinks',
				displayName: 'Drinks',
				items: Array.from({ length: 9 }, (_, index) => dish(`d${index}`)),
			},
		]
		expect(
			suggestForCart({ categories: many, lines: [line('burger')], offered: true }),
		).toHaveLength(6)
	})
})

describe('upsellNeedsChoices', () => {
	it('is true for a size choice or a required option group, false otherwise', () => {
		expect(upsellNeedsChoices(dish('plain'))).toBe(false)
		expect(
			upsellNeedsChoices(dish('optional', { modifierGroups: [group(0)] })),
		).toBe(false)
		expect(
			upsellNeedsChoices(dish('required', { modifierGroups: [group(1)] })),
		).toBe(true)
		expect(upsellNeedsChoices(sized('sized'))).toBe(true)
	})
})

describe('addSuggestion', () => {
	const deps = () => ({
		add: vi.fn(),
		openModal: vi.fn(),
		markOpened: vi.fn(),
		countAdded: vi.fn(),
	})

	it('adds a dish without options in one tap, priced as the menu prices it', () => {
		const d = deps()
		expect(addSuggestion(dish('cola', { price: 3.5 }), d)).toBe('added')
		expect(d.add).toHaveBeenCalledTimes(1)
		expect(d.add.mock.calls[0]?.[0]).toMatchObject({
			itemId: 'cola',
			name: 'cola',
			basePrice: 3.5,
			unitPrice: 3.5,
			quantity: 1,
			options: [],
			instructions: '',
		})
		expect(d.countAdded).toHaveBeenCalledWith('cola')
		expect(d.openModal).not.toHaveBeenCalled()
	})

	it('opens the item modal for a dish with required options and adds nothing yet', () => {
		const d = deps()
		const withSauce = dish('wings', { modifierGroups: [group(1)] })
		expect(addSuggestion(withSauce, d)).toBe('opened')
		expect(d.openModal).toHaveBeenCalledWith(withSauce)
		expect(d.markOpened).toHaveBeenCalledWith('wings')
		expect(d.add).not.toHaveBeenCalled()
		expect(d.countAdded).not.toHaveBeenCalled()
	})

	it('opens the modal for a dish with a size to choose', () => {
		const d = deps()
		expect(addSuggestion(sized('shake'), d)).toBe('opened')
		expect(d.add).not.toHaveBeenCalled()
	})

	it('gives each added line its own id', () => {
		const d = deps()
		addSuggestion(dish('a'), d)
		addSuggestion(dish('a'), d)
		const [first, second] = d.add.mock.calls.map((call) => (call[0] as { id: string }).id)
		expect(first).toBeTruthy()
		expect(first).not.toBe(second)
	})
})
