import { i18n } from '@lingui/core'
import { beforeAll, describe, expect, it } from 'vitest'
import {
	emptyEditorState,
	emptyGroup,
	newSlot,
	newTier,
	type EditorState,
} from './editor-model.ts'
import { buildDiscountSummary, nameList } from './summary.ts'

beforeAll(() => {
	i18n.loadAndActivate({ locale: 'en', messages: {} })
})

const catalog = {
	items: [
		{ id: 'burger', name: 'Burger', detail: null },
		{ id: 'fries', name: 'Fries', detail: null },
		{ id: 'pizza', name: 'Pizza', detail: null },
		{ id: 'wings', name: 'Wings', detail: null },
		{ id: 'salad', name: 'Salad', detail: null },
	],
	categories: [
		{ id: 'pizzas', name: 'Pizzas', detail: null },
		{ id: 'drinks', name: 'Drinks', detail: null },
	],
}
const choices = {
	groups: [{ id: 'toppings', name: 'Toppings', detail: null }],
	options: [{ id: 'ranch', name: 'Ranch', detail: 'Sauces' }],
	variantGroups: [
		{
			key: 'size',
			name: 'Size',
			items: 3,
			values: [
				{ id: 'large', name: 'Large', detail: null },
				{ id: 'medium', name: 'Medium', detail: null },
			],
		},
		{
			key: 'crust',
			name: 'Crust',
			items: 1,
			values: [{ id: 'thin', name: 'Thin', detail: null }],
		},
	],
}

function summarize(overrides: Partial<EditorState>) {
	const state: EditorState = {
		...emptyEditorState(),
		name: { en: 'Pizza night', ar: 'ليلة البيتزا' },
		percent: '20',
		...overrides,
	}
	const summary = buildDiscountSummary({
		state,
		currency: 'USD',
		locale: 'en',
		defaultLocale: 'en',
		catalog,
		choices,
		locations: [{ id: 'l1', name: 'Downtown' }],
		tx: (descriptor) => i18n._(descriptor),
	})
	const rows = Object.fromEntries(
		summary.rows.map((row) => [row.key, row.value]),
	)
	return { ...summary, row: rows }
}

describe('nameList', () => {
	it('lists up to three names and counts the rest', () => {
		const items = catalog.items
		expect(nameList(['burger', 'fries'], items)).toBe('Burger, Fries')
		expect(
			nameList(['burger', 'fries', 'pizza', 'wings', 'salad'], items),
		).toBe('Burger, Fries, Pizza +2')
	})

	it('leaves out ids the menu no longer has', () => {
		expect(nameList(['gone', 'burger'], catalog.items)).toBe('Burger')
		expect(nameList(['gone'], catalog.items)).toBe('')
	})
})

describe('discount summary', () => {
	it('describes a half-filled discount instead of waiting for a valid one', () => {
		const result = summarize({ name: { ar: 'ليلة' }, percent: '' })
		expect(result.title).toBe('Untitled discount')
		expect(result.headline).toBe('Percentage off')
		expect(result.row.covers).toBe('Whole order')
	})

	it('reads the value, the cap and the name as they are typed', () => {
		const result = summarize({ percent: '15', maxDiscount: '5.00' })
		expect(result.title).toBe('Pizza night')
		expect(result.headline).toBe('15% off (up to $5.00)')
	})

	it('names the items a discount covers', () => {
		const result = summarize({ scope: 'items', itemIds: ['pizza', 'wings'] })
		expect(result.row.covers).toBe('Pizza, Wings')
	})

	it('reads a buy-get deal as a sentence', () => {
		const result = summarize({
			quantityKind: 'buy_get',
			percent: '100',
			buyGroup: { ...emptyGroup('1'), itemIds: ['burger'] },
			getGroup: { ...emptyGroup('2'), itemIds: ['fries'] },
		})
		expect(result.row.covers).toBe('Buy Burger, get 2 × Fries')
	})

	it('reads a meal deal as its parts and a set price', () => {
		const result = summarize({
			quantityKind: 'bundle',
			valueType: 'fixed_price',
			amount: '15',
			bundleSlots: [
				{ ...newSlot('2'), categoryIds: ['pizzas'] },
				{ ...newSlot('1'), categoryIds: ['drinks'] },
			],
		})
		expect(result.headline).toBe('Set price $15.00')
		expect(result.row.covers).toBe('2 × Pizzas + Drinks')
	})

	it('reads a modifier discount with its item filter', () => {
		const result = summarize({
			scope: 'modifiers',
			modifierGroupIds: ['toppings'],
			categoryIds: ['pizzas'],
			quantityKind: 'per_item',
			perItemN: '2',
			percent: '100',
		})
		expect(result.row.covers).toBe('Toppings on Pizzas')
		expect(result.row.rule).toBe(
			'The first 2 on each item, most expensive first',
		)
	})

	it('says everywhere when nothing is narrowed', () => {
		expect(summarize({}).row.where).toBe('Everywhere')
	})

	it('asks for a choice that is still empty', () => {
		expect(summarize({ scope: 'items' }).row.covers).toBe('Nothing chosen yet')
		expect(
			summarize({ scope: 'modifiers', modifierGroupIds: [] }).row.covers,
		).toBe('Nothing chosen yet')
	})

	it('names only the channels and order types it is limited to', () => {
		const result = summarize({ channels: ['web', 'qr'] })
		expect(result.row.where).toBe('Website, QR ordering')
	})

	it('says when, where and who', () => {
		const result = summarize({
			channels: ['web'],
			fulfillments: ['pickup'],
			allLocations: false,
			locationIds: ['l1'],
			eligibility: 'new_customer',
			totalLimit: '100',
			minSubtotal: '20',
			startsAt: '2026-11-01T10:00',
		})
		expect(result.row.when).toContain('From')
		expect(result.row.where).toBe('Downtown, Website, Pickup')
		expect(result.row.who).toBe(
			'New customers (first order), Up to 100 uses, Minimum spend $20.00',
		)
	})

	it('reads a spend ladder as its steps', () => {
		const result = summarize({
			tiersOn: true,
			tierBasis: 'spend',
			tiers: [newTier('30', '5'), newTier('50', '15')],
		})
		expect(result.headline).toBe('Tiered discount')
		expect(result.row.tiers).toBe(
			'$30.00 or more: 5% off, $50.00 or more: 15% off',
		)
	})

	it('reads an item-count ladder', () => {
		const result = summarize({
			tiersOn: true,
			tierBasis: 'quantity',
			tiers: [newTier('2', '10')],
		})
		expect(result.row.tiers).toBe('2 or more items: 10% off')
	})

	it('shows no ladder where it does not apply', () => {
		const result = summarize({ tiersOn: true, application: 'manual' })
		expect(result.row.tiers).toBeUndefined()
		expect(result.headline).toBe('20% off')
	})

	it('adds the options to what a discount covers', () => {
		const result = summarize({
			scope: 'categories',
			categoryIds: ['pizzas'],
			variants: [{ group: 'size', values: ['large', 'medium'] }],
		})
		expect(result.row.covers).toBe('Pizzas (Size: Large or Medium)')
	})

	it('names every option type, and keys the menu no longer has', () => {
		const result = summarize({
			scope: 'categories',
			categoryIds: ['pizzas'],
			variants: [
				{ group: 'size', values: ['large'] },
				{ group: 'crust', values: ['thin', 'stuffed'] },
				{ group: 'colour', values: ['red'] },
				{ group: '', values: [] },
			],
		})
		expect(result.row.covers).toBe(
			'Pizzas (Size: Large, Crust: Thin or stuffed, colour: red)',
		)
	})

	it('limits a modifier discount on every item to its options', () => {
		const result = summarize({
			scope: 'modifiers',
			modifierGroupIds: ['toppings'],
			variants: [{ group: 'size', values: ['large'] }],
		})
		expect(result.row.covers).toBe('Toppings on Size: Large')
	})

	it('reads a spend deal as a sentence', () => {
		const result = summarize({
			quantityKind: 'buy_get',
			percent: '100',
			buyGroup: {
				...emptyGroup(),
				itemIds: ['burger'],
				by: 'spend',
				spend: '30',
			},
			getGroup: { ...emptyGroup('1'), itemIds: ['fries'] },
		})
		expect(result.row.covers).toBe('Spend $30.00 on Burger, get Fries')
	})

	it('says what free delivery is limited to', () => {
		const result = summarize({
			valueType: 'free_delivery',
			maxDeliveryFee: '7',
		})
		expect(result.row.fee).toBe('Only when the fee is $7.00 or less')
	})

	it('says what a discount combines with, and that it stands alone when nothing is ticked', () => {
		expect(summarize({ combinesWith: ['item', 'order'] }).row.combine).toBe(
			'Item discounts, Whole-order discounts',
		)
		expect(summarize({ combinesWith: [] }).row.combine).toBe(
			'Nothing (stands alone)',
		)
	})

	it('words a use limit of one as a singular', () => {
		expect(
			summarize({ totalLimit: 'custom', totalLimitCustom: '1' }).row.who,
		).toContain('Up to 1 use')
		expect(
			summarize({ totalLimit: 'custom', totalLimitCustom: '1' }).row.who,
		).not.toContain('1 uses')
	})

	it('shows the first code of a coupon', () => {
		const result = summarize({
			application: 'code',
			codes: [
				{ key: 'a', id: null, code: 'PIZZA2', maxUses: '' },
				{ key: 'b', id: null, code: 'PIZZA3', maxUses: '' },
			],
		})
		expect(result.row.how).toBe('Coupon code, PIZZA2 +1')
	})

	it('says "At the till" where the form does', () => {
		expect(summarize({ application: 'manual' }).row.how).toBe('At the till')
	})

	it('says a fixed amount comes off each item on an item discount, once on the order', () => {
		const order = summarize({ valueType: 'fixed', amount: '5' })
		expect(order.headline).toBe('$5.00 off')
		const items = summarize({
			valueType: 'fixed',
			amount: '5',
			scope: 'items',
			itemIds: ['pizza'],
		})
		expect(items.headline).toBe('$5.00 off each item')
		const categories = summarize({
			valueType: 'fixed',
			amount: '5',
			scope: 'categories',
			categoryIds: ['pizzas'],
		})
		expect(categories.headline).toBe('$5.00 off each item')
		const modifiers = summarize({
			valueType: 'fixed',
			amount: '1',
			scope: 'modifiers',
			modifierGroupIds: ['toppings'],
		})
		expect(modifiers.headline).toBe('$1.00 off each choice')
		const deal = summarize({
			valueType: 'fixed',
			amount: '3',
			quantityKind: 'bundle',
			bundleSlots: [{ ...newSlot('1'), categoryIds: ['pizzas'] }],
		})
		expect(deal.headline).toBe('$3.00 off each deal')
	})

	it('lists the rules it used to leave out', () => {
		const result = summarize({
			scope: 'items',
			itemIds: ['pizza'],
			maxUnits: '2',
			requireOn: true,
			requireQuantity: '2',
			requireItemIds: ['burger'],
			excludeItemIds: ['salad'],
			excludeCategoryIds: ['drinks'],
			includeDrops: true,
			perCustomerOn: true,
			perCustomerCount: '2',
			perCustomerPeriod: 'week',
		})
		expect(result.row.units).toBe('Up to 2 items')
		expect(result.row.require).toBe('2 × Burger')
		expect(result.row.exclude).toBe('Salad, Drinks')
		expect(result.row.drops).toBe('Included')
		expect(result.row.perCustomer).toBe(
			"2 uses per customer per week. Guests can't use it.",
		)
		expect(result.row.who).toBe('Everyone')
	})

	it('leaves those rows out when nothing is set', () => {
		const rows = Object.keys(summarize({}).row)
		for (const key of ['units', 'require', 'exclude', 'drops', 'perCustomer']) {
			expect(rows).not.toContain(key)
		}
	})

	it('says one use with the singular', () => {
		const result = summarize({
			perCustomerOn: true,
			perCustomerCount: '1',
			perCustomerPeriod: 'lifetime',
		})
		expect(result.row.perCustomer).toBe(
			"1 use per customer in total. Guests can't use it.",
		)
	})

	it('shows the cap of a percentage ladder', () => {
		const result = summarize({
			tiersOn: true,
			tierBasis: 'spend',
			tiers: [newTier('30', '5')],
			maxDiscount: '10',
		})
		expect(result.row.cap).toBe('$10.00')
	})

	it('shows the time a discount starts and ends, not just the day', () => {
		const result = summarize({
			startsAt: '2026-11-01T10:00',
			endsAt: '2026-12-01T00:00',
		})
		expect(result.row.when).toMatch(/10:00/)
		expect(result.row.when).toMatch(/12:00\sAM/)
	})
})
