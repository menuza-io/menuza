import { describe, expect, it } from 'vitest'
import { menuItemSalePrice, type MenuPricePromotion } from './menu-price.ts'

const item = {
	id: 'burger',
	directCategoryIds: ['mains'],
	priceMinor: 1000,
	currency: 'USD',
}
const pct = (over: Partial<MenuPricePromotion> = {}): MenuPricePromotion => ({
	valueType: 'percent',
	percentBp: 2000,
	scope: 'items',
	itemIds: ['burger'],
	itemPrice: true,
	...over,
})

describe('menuItemSalePrice', () => {
	it('takes a percentage off, rounding the discount down', () => {
		expect(menuItemSalePrice([pct()], item)).toMatchObject({
			originalMinor: 1000,
			saleMinor: 800,
		})
		expect(
			menuItemSalePrice([pct({ percentBp: 3333 })], {
				...item,
				priceMinor: 999,
			}),
		).toMatchObject({ saleMinor: 999 - 332 })
	})

	it('takes a fixed amount off each item, never below zero', () => {
		const fixed = pct({ valueType: 'fixed', percentBp: null, amountMinor: 250 })
		expect(menuItemSalePrice([fixed], item)?.saleMinor).toBe(750)
		expect(
			menuItemSalePrice([{ ...fixed, amountMinor: 5000 }], item)?.saleMinor,
		).toBe(0)
	})

	it('matches a category offer by the direct category', () => {
		const offer = pct({
			scope: 'categories',
			itemIds: [],
			categoryIds: ['mains'],
		})
		expect(menuItemSalePrice([offer], item)).not.toBeNull()
		expect(
			menuItemSalePrice([offer], { ...item, directCategoryIds: ['drinks'] }),
		).toBeNull()
	})

	it('shows nothing when the discount is not plain', () => {
		expect(menuItemSalePrice([pct({ itemPrice: false })], item)).toBeNull()
		expect(menuItemSalePrice([pct({ itemPrice: undefined })], item)).toBeNull()
	})

	it('shows nothing when another offer covers the item', () => {
		expect(
			menuItemSalePrice(
				[pct(), pct({ itemPrice: false, valueType: 'fixed_price' })],
				item,
			),
		).toBeNull()
		expect(menuItemSalePrice([pct(), pct()], item)).toBeNull()
	})

	it('ignores free delivery and offers for other items', () => {
		const delivery = pct({ valueType: 'free_delivery', scope: 'order' })
		const other = pct({ itemIds: ['salad'] })
		expect(menuItemSalePrice([pct(), delivery, other], item)).not.toBeNull()
	})

	it('respects exclusions and the item flag', () => {
		expect(
			menuItemSalePrice([pct({ excludeItemIds: ['burger'] })], item),
		).toBeNull()
		expect(
			menuItemSalePrice(
				[pct({ scope: 'order', itemIds: [], excludeCategoryIds: ['mains'] })],
				item,
			),
		).toBeNull()
		expect(
			menuItemSalePrice([pct()], { ...item, excludeFromDiscounts: true }),
		).toBeNull()
	})

	it('refuses an amount in another currency and an order-wide amount', () => {
		const fixed = pct({
			valueType: 'fixed',
			percentBp: null,
			amountMinor: 100,
			currency: 'SAR',
		})
		expect(menuItemSalePrice([fixed], item)).toBeNull()
		expect(
			menuItemSalePrice([{ ...fixed, currency: 'usd', scope: 'order' }], item),
		).toBeNull()
	})
})
