import { describe, expect, it } from 'vitest'
import {
	UPSELL_MAX_SUGGESTIONS,
	pickUpsells,
	upsellItemSoldOut,
	type UpsellCategory,
	type UpsellItem,
} from './upsell.ts'

const item = (id: string, patch: Partial<UpsellItem> = {}): UpsellItem => ({
	id,
	availabilityStatus: 'available',
	...patch,
})

const burgers: UpsellCategory = {
	id: 'burgers',
	upsellCategoryIds: ['drinks'],
	items: [item('burger'), item('veggie')],
}
const drinks: UpsellCategory = {
	id: 'drinks',
	items: [item('cola'), item('lemonade'), item('water')],
}
const sides: UpsellCategory = {
	id: 'sides',
	items: [item('fries', { isUpsell: true }), item('slaw')],
}
const menus = [{ categories: [burgers, drinks, sides] }]

const ids = (picks: ReturnType<typeof pickUpsells>) =>
	picks.map((pick) => pick.item.id)

describe('pickUpsells', () => {
	it('suggests the upsell category of what is in the cart, then flagged dishes', () => {
		// A burger in the cart and Drinks set as an upsell category of Burgers.
		expect(ids(pickUpsells({ menus, cartItemIds: ['burger'] }))).toEqual([
			'cola',
			'lemonade',
			'water',
			'fries',
		])
	})

	it('with an empty cart only the flagged dishes remain', () => {
		expect(ids(pickUpsells({ menus, cartItemIds: [] }))).toEqual(['fries'])
	})

	it('only the flag applies when the cart’s categories point nowhere', () => {
		expect(ids(pickUpsells({ menus, cartItemIds: ['slaw'] }))).toEqual([
			'fries',
		])
	})

	it('never suggests a dish already in the cart', () => {
		expect(
			ids(pickUpsells({ menus, cartItemIds: ['burger', 'cola', 'fries'] })),
		).toEqual(['lemonade', 'water'])
	})

	it('never suggests a sold out or unavailable dish', () => {
		const soldOut: UpsellCategory = {
			...drinks,
			items: [
				item('cola', { availabilityStatus: 'unavailable' }),
				item('lemonade', { availabilityStatus: 'unavailable_until' }),
				item('juice', {
					variations: {
						variants: [
							{ availabilityStatus: 'unavailable' },
							{ availabilityStatus: 'unavailable' },
						],
					},
				}),
				item('water'),
			],
		}
		expect(
			ids(
				pickUpsells({
					menus: [{ categories: [burgers, soldOut] }],
					cartItemIds: ['burger'],
				}),
			),
		).toEqual(['water'])
		expect(upsellItemSoldOut(item('x', { availabilityStatus: 'hidden' }))).toBe(
			true,
		)
	})

	it('keeps a dish with one variant left', () => {
		expect(
			upsellItemSoldOut(
				item('x', {
					variations: {
						variants: [
							{ availabilityStatus: 'unavailable' },
							{ availabilityStatus: 'available' },
						],
					},
				}),
			),
		).toBe(false)
	})

	it('skips hidden menus and categories', () => {
		const hiddenDrinks = { ...drinks, availabilityStatus: 'unavailable' }
		expect(
			ids(
				pickUpsells({
					menus: [{ categories: [burgers, hiddenDrinks, sides] }],
					cartItemIds: ['burger'],
				}),
			),
		).toEqual(['fries'])
		expect(
			pickUpsells({
				menus: [
					{ availabilityStatus: 'unavailable', categories: [burgers, drinks] },
				],
				cartItemIds: ['burger'],
			}),
		).toEqual([])
	})

	it('lets the caller veto a dish (order type, per-order limit)', () => {
		expect(
			ids(
				pickUpsells({
					menus,
					cartItemIds: ['burger'],
					allow: (dish) => dish.id !== 'cola',
				}),
			),
		).toEqual(['lemonade', 'water', 'fries'])
	})

	it('caps the list at six and respects a smaller limit', () => {
		const many: UpsellCategory = {
			id: 'drinks',
			items: Array.from({ length: 9 }, (_, index) => item(`d${index}`)),
		}
		const all = pickUpsells({
			menus: [{ categories: [burgers, many] }],
			cartItemIds: ['burger'],
		})
		expect(all).toHaveLength(UPSELL_MAX_SUGGESTIONS)
		expect(ids(all)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5'])
		expect(
			pickUpsells({
				menus: [{ categories: [burgers, many] }],
				cartItemIds: ['burger'],
				limit: 2,
			}),
		).toHaveLength(2)
		expect(pickUpsells({ menus, cartItemIds: ['burger'], limit: 0 })).toEqual(
			[],
		)
	})

	it('breaks ties by menu position, categories first', () => {
		const first: UpsellCategory = {
			id: 'a',
			items: [item('a1', { isUpsell: true })],
		}
		const second: UpsellCategory = {
			id: 'b',
			items: [item('b1', { isUpsell: true })],
		}
		expect(
			ids(
				pickUpsells({
					menus: [{ categories: [burgers, second, first] }],
					cartItemIds: ['burger'],
				}),
			),
		).toEqual(['b1', 'a1'])
	})

	it('finds dishes in subcategories and lists a dish once', () => {
		const nested: UpsellCategory = {
			id: 'drinks',
			items: [item('cola')],
			subcategories: [{ id: 'hot', items: [item('tea'), item('cola')] }],
		}
		expect(
			ids(
				pickUpsells({
					menus: [{ categories: [burgers, nested] }],
					cartItemIds: ['burger'],
				}),
			),
		).toEqual(['cola', 'tea'])
	})

	it('reads a cart dish inside a subcategory', () => {
		const parent: UpsellCategory = {
			id: 'mains',
			items: [],
			subcategories: [
				{
					id: 'burgers',
					upsellCategoryIds: ['drinks'],
					items: [item('burger')],
				},
			],
		}
		expect(
			ids(
				pickUpsells({
					menus: [{ categories: [parent, drinks] }],
					cartItemIds: ['burger'],
				}),
			),
		).toEqual(['cola', 'lemonade', 'water'])
	})

	it('never suggests add-ons hidden on the requested channel', () => {
		const channelDrinks: UpsellCategory = {
			id: 'drinks',
			items: [
				{ ...item('cola'), channels: ['web', 'pos'] },
				{ ...item('qr-special'), channels: ['qr'] },
			],
		}
		const hiddenCategory: UpsellCategory = {
			id: 'desserts',
			channels: ['pos'],
			items: [{ ...item('cake'), isUpsell: true }],
		}
		const hiddenMenu = {
			channels: ['app'],
			categories: [
				{
					id: 'app-only',
					items: [{ ...item('app-shake'), isUpsell: true }],
				},
			],
		}

		// On 'web': cola is allowed, qr-special is item-hidden, cake is category-hidden, app-shake is menu-hidden
		expect(
			ids(
				pickUpsells({
					menus: [
						{ categories: [burgers, channelDrinks, hiddenCategory] },
						hiddenMenu,
					],
					cartItemIds: ['burger'],
					channel: 'web',
				}),
			),
		).toEqual(['cola'])

		// On 'qr': qr-special is allowed
		expect(
			ids(
				pickUpsells({
					menus: [
						{ categories: [burgers, channelDrinks, hiddenCategory] },
						hiddenMenu,
					],
					cartItemIds: ['burger'],
					channel: 'qr',
				}),
			),
		).toEqual(['qr-special'])

		// Without channel: all are suggested
		expect(
			ids(
				pickUpsells({
					menus: [
						{ categories: [burgers, channelDrinks, hiddenCategory] },
						hiddenMenu,
					],
					cartItemIds: ['burger'],
				}),
			),
		).toEqual(['cola', 'qr-special', 'cake', 'app-shake'])
	})
})
