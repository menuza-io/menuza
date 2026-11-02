import { describe, expect, it } from 'vitest'
import {
	currencyIssueField,
	DISCOUNT_MAX_CODES,
	parseRangeCode,
	resolveDiscountCurrency,
	stateUsesAmounts,
	rangeCode,
	emptyEditorState,
	emptyGroup,
	generateCode,
	newSlot,
	newTier,
	stateFromDefinition,
	stateToDefinition,
	type EditorState,
} from './editor-model.ts'

const EN = { locales: ['en'], defaultLocale: 'en' }
const OPTIONS = { currency: 'USD', status: 'active' as const, locales: EN }

function state(overrides: Partial<EditorState>): EditorState {
	return {
		...emptyEditorState(),
		name: { en: 'Happy hour' },
		percent: '10',
		...overrides,
	}
}

function convert(overrides: Partial<EditorState>, extra = {}) {
	return stateToDefinition(state(overrides), { ...OPTIONS, ...extra })
}

describe('stateToDefinition', () => {
	it('builds a percent discount', () => {
		const result = convert({})
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.definition).toMatchObject({
			name: 'Happy hour',
			percentBp: 1000,
			amountMinor: null,
			currency: null,
			locationIds: null,
			totalLimit: null,
		})
	})

	it('reads money in the currency minor unit', () => {
		const result = convert({
			valueType: 'fixed',
			percent: '',
			amount: '5.50',
			minSubtotal: '20',
		})
		expect(result.ok && result.definition).toMatchObject({
			valueType: 'fixed',
			amountMinor: 550,
			currency: 'USD',
			percentBp: null,
			minSubtotalMinor: 2000,
		})
	})

	it('reports field errors as codes', () => {
		const result = convert({ name: { en: ' ' }, percent: '150' })
		expect(result).toEqual({
			ok: false,
			errors: { name: 'required', percent: 'percent' },
		})
	})

	it('needs items or categories for item and category scope', () => {
		expect(convert({ scope: 'items' })).toMatchObject({
			errors: { target: 'choose_items' },
		})
		expect(convert({ scope: 'categories' })).toMatchObject({
			errors: { target: 'choose_categories' },
		})
		const ok = convert({
			scope: 'items',
			itemIds: ['a'],
			categoryIds: ['stale'],
		})
		expect(ok.ok && ok.definition.target.categoryIds).toEqual([])
	})

	it('free delivery ignores targets and quantity rules but needs delivery', () => {
		const ok = convert({
			valueType: 'free_delivery',
			percent: '',
			scope: 'items',
			quantityKind: 'bogo',
		})
		expect(ok.ok && ok.definition.target.scope).toBe('order')
		expect(ok.ok && ok.definition.quantityRule).toEqual({ kind: 'none' })
		expect(
			convert({
				valueType: 'free_delivery',
				percent: '',
				fulfillments: ['pickup'],
			}),
		).toMatchObject({ errors: { fulfillments: 'needs_delivery' } })
	})

	it('builds quantity rules', () => {
		const bogo = convert({
			scope: 'items',
			itemIds: ['a'],
			quantityKind: 'bogo',
			buyQuantity: '2',
			getQuantity: '1',
			maxUnits: '3',
		})
		expect(bogo.ok && bogo.definition.quantityRule).toEqual({
			kind: 'bogo',
			buyQuantity: 2,
			getQuantity: 1,
		})
		expect(bogo.ok && bogo.definition.maxDiscountedUnits).toBe(3)
		expect(convert({ quantityKind: 'minimum', quantityN: '1' })).toMatchObject({
			errors: { quantityN: 'range:2:1000' },
		})
	})

	it('maps a schema refusal to its field', () => {
		// A schema refusal the form cannot name stays a generic one.
		const result = convert({
			scope: 'items',
			itemIds: ['a'],
			quantityKind: 'minimum',
			valueType: 'fixed_price',
			amount: '5',
		})
		expect(result).toMatchObject({ ok: false })
		const bogo = convert({ quantityKind: 'bogo' })
		// Intended change: Whole order plus buy-some-discount-some now names
		// itself instead of "Check this setting."
		expect(bogo).toEqual({
			ok: false,
			errors: { quantityKind: 'bogo_needs_items' },
		})
	})

	it('checks dates and weekly hours', () => {
		expect(
			convert({ startsAt: '2026-11-02T10:00', endsAt: '2026-11-01T10:00' }),
		).toMatchObject({ errors: { endsAt: 'end_before_start' } })
		expect(convert({ hoursOn: true })).toMatchObject({
			errors: { schedule: 'add_hours' },
		})
		expect(
			convert({
				hoursOn: true,
				schedule: [{ day: 1, start: '10:00', end: '10:00' }],
			}),
		).toMatchObject({ errors: { 'schedule.0.end': 'same_time' } })
		const ok = convert({
			hoursOn: true,
			schedule: [{ day: 5, start: '22:00', end: '02:00' }],
		})
		expect(ok.ok && ok.definition.schedule).toEqual([
			{ day: 5, start: '22:00', end: '02:00' },
		])
	})

	it('needs a location, channel and order type', () => {
		expect(
			convert({ allLocations: false, channels: [], fulfillments: [] }),
		).toMatchObject({
			errors: {
				locations: 'choose_one',
				channels: 'choose_one',
				fulfillments: 'choose_one',
			},
		})
	})

	it('total limit presets and custom values', () => {
		expect(convert({ totalLimit: '25' }).ok).toBe(true)
		const custom = convert({ totalLimit: 'custom', totalLimitCustom: '75' })
		expect(custom.ok && custom.definition.totalLimit).toBe(75)
		expect(
			convert({ totalLimit: 'custom', totalLimitCustom: 'lots' }),
		).toMatchObject({ errors: { totalLimit: 'range:1:1000000' } })
	})

	it('per customer limit', () => {
		const result = convert({
			perCustomerOn: true,
			perCustomerCount: '2',
			perCustomerPeriod: 'week',
		})
		expect(result.ok && result.definition.perCustomerLimit).toEqual({
			count: 2,
			period: 'week',
		})
	})

	describe('codes', () => {
		const code = (value: string, maxUses = '') => ({
			key: value,
			id: null,
			code: value,
			maxUses,
		})
		it('a code discount may have no code (marketing codes only)', () => {
			const result = convert({ application: 'code' })
			expect(result).toMatchObject({ ok: true, codes: [] })
		})
		it('checks format, duplicates and codes taken elsewhere', () => {
			expect(
				convert(
					{
						application: 'code',
						codes: [code('no'), code('SAVE-10'), code('save10'), code('TAKEN')],
					},
					{ takenCodes: new Set(['TAKEN']) },
				),
			).toEqual({
				ok: false,
				errors: {
					'codes.0.code': 'code_format',
					'codes.2.code': 'code_duplicate',
					'codes.3.code': 'code_taken',
				},
			})
		})
		it('keeps the code as typed with its use limit', () => {
			const result = convert({
				application: 'code',
				codes: [code('Save-10', '50')],
			})
			expect(result.ok && result.codes).toEqual([
				{ id: null, code: 'Save-10', maxUses: 50 },
			])
		})
		it('an automatic discount drops codes', () => {
			const result = convert({ codes: [code('SAVE10')] })
			expect(result.ok && result.codes).toEqual([])
		})
	})
})

describe('meal deals and set prices', () => {
	const group = (
		quantity: string,
		categoryIds: string[] = [],
		itemIds: string[] = [],
	) => ({
		...emptyGroup(quantity),
		itemIds,
		categoryIds,
	})
	const slot = (quantity: string, categoryIds: string[] = ['pizza']) => ({
		...newSlot(quantity),
		categoryIds,
	})

	it('builds a buy-get rule from two groups', () => {
		const result = convert({
			quantityKind: 'buy_get',
			percent: '100',
			buyGroup: group('1', [], ['burger']),
			getGroup: group('1', [], ['fries']),
		})
		expect(result.ok && result.definition.quantityRule).toEqual({
			kind: 'buy_get',
			buy: { quantity: 1, itemIds: ['burger'], categoryIds: [] },
			get: { quantity: 1, itemIds: ['fries'], categoryIds: [] },
		})
		// The rule names its own items, so the target is the whole order.
		expect(result.ok && result.definition.target.scope).toBe('order')
	})

	it('asks for both groups of a buy-get rule', () => {
		const result = convert({
			quantityKind: 'buy_get',
			buyGroup: group('1', [], ['burger']),
		})
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.errors['getGroup.items']).toBe('choose_one')
		expect(result.errors['buyGroup.items']).toBeUndefined()
	})

	it('builds a meal deal at a set price', () => {
		const result = convert({
			quantityKind: 'bundle',
			valueType: 'fixed_price',
			amount: '15.00',
			bundleSlots: [slot('1'), slot('1', ['drinks'])],
		})
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.definition.amountMinor).toBe(1500)
		expect(result.definition.currency).toBe('USD')
		expect(result.definition.quantityRule.kind).toBe('bundle')
	})

	it('flags a quantity or an empty group in a meal deal by position', () => {
		const result = convert({
			quantityKind: 'bundle',
			bundleSlots: [slot('2'), { ...slot('x'), categoryIds: [] }],
		})
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.errors['slots.1.quantity']).toBe('range:1:1000')
		expect(result.errors['slots.1.items']).toBe('choose_one')
	})

	it('refuses a deal of more than 20 items', () => {
		const result = convert({
			quantityKind: 'bundle',
			bundleSlots: [slot('11'), slot('10', ['drinks'])],
		})
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.errors.slots).toBe('bundle_too_big')
	})

	it('needs items or categories for a set price without a meal deal', () => {
		expect(convert({ valueType: 'fixed_price', amount: '10' })).toMatchObject({
			ok: false,
			errors: { target: 'set_price_needs_items' },
		})
		const priced = convert({
			valueType: 'fixed_price',
			amount: '10',
			scope: 'items',
			itemIds: ['large-pizza'],
		})
		expect(priced.ok && priced.definition.amountMinor).toBe(1000)
	})

	it('does not allow a set price with a counted rule', () => {
		const result = convert({
			valueType: 'fixed_price',
			amount: '10',
			scope: 'items',
			itemIds: ['a'],
			quantityKind: 'minimum',
			quantityN: '2',
		})
		expect(result).toMatchObject({
			ok: false,
			errors: { quantityKind: 'set_price_quantity' },
		})
	})

	it('keeps deals and set prices away from the till', () => {
		const deal = convert({
			application: 'manual',
			quantityKind: 'bundle',
			valueType: 'fixed_price',
			amount: '10',
			bundleSlots: [slot('2')],
		})
		expect(deal).toMatchObject({
			ok: false,
			errors: { application: 'invalid' },
		})
	})

	it('caps the items a deal covers even though the target is the whole order', () => {
		const result = convert({
			quantityKind: 'bundle',
			maxUnits: '4',
			bundleSlots: [slot('2')],
		})
		expect(result.ok && result.definition.maxDiscountedUnits).toBe(4)
	})
})

describe('modifier discounts', () => {
	const toppingsFree = (overrides: Partial<EditorState> = {}) =>
		convert({
			scope: 'modifiers',
			percent: '100',
			modifierGroupIds: ['toppings'],
			quantityKind: 'per_item',
			perItemN: '2',
			...overrides,
		})

	it('builds "2 toppings free" with an item filter', () => {
		const result = toppingsFree({ categoryIds: ['pizzas'] })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.definition.target).toMatchObject({
			scope: 'modifiers',
			modifierGroupIds: ['toppings'],
			modifierOptionIds: [],
			categoryIds: ['pizzas'],
		})
		expect(result.definition.quantityRule).toEqual({
			kind: 'per_item',
			quantity: 2,
		})
	})

	it('needs a group or an option', () => {
		expect(toppingsFree({ modifierGroupIds: [] })).toMatchObject({
			ok: false,
			errors: { target: 'choose_modifiers' },
		})
		expect(
			toppingsFree({ modifierGroupIds: [], modifierOptionIds: ['pepperoni'] })
				.ok,
		).toBe(true)
	})

	it('flags a per-item count that is not a number', () => {
		expect(toppingsFree({ perItemN: 'two' })).toMatchObject({
			ok: false,
			errors: { perItemN: 'range:1:1000' },
		})
	})

	it('drops a counted rule left over from an item discount', () => {
		const result = toppingsFree({
			quantityKind: 'bogo',
			buyQuantity: '1',
			getQuantity: '1',
		})
		expect(result.ok && result.definition.quantityRule).toEqual({
			kind: 'none',
		})
	})

	it('drops a per-item rule when the discount is not on modifiers', () => {
		const result = convert({
			scope: 'items',
			itemIds: ['a'],
			quantityKind: 'per_item',
		})
		expect(result.ok && result.definition.quantityRule).toEqual({
			kind: 'none',
		})
		expect(
			result.ok && result.definition.target.modifierGroupIds,
		).toBeUndefined()
	})

	it('allows a set price per choice', () => {
		const result = toppingsFree({
			valueType: 'fixed_price',
			amount: '1.00',
			quantityKind: 'none',
		})
		expect(result.ok && result.definition.amountMinor).toBe(100)
	})

	it('round trips', () => {
		const first = toppingsFree({
			modifierOptionIds: ['ranch'],
			itemIds: ['margherita'],
			maxUnits: '6',
		})
		if (!first.ok) throw new Error(JSON.stringify(first.errors))
		const second = stateToDefinition(
			stateFromDefinition(first.definition, [], 'USD', EN),
			OPTIONS,
		)
		expect(second.ok && second.definition).toEqual(first.definition)
	})
})

describe('ladders, sizes, spend, fee limit and stacking', () => {
	const ladder = (overrides: Partial<EditorState> = {}) =>
		convert({
			tiersOn: true,
			tierBasis: 'spend',
			percent: '',
			tiers: [newTier('30', '5'), newTier('50', '15')],
			...overrides,
		})

	it('builds a spend ladder with no value of its own', () => {
		const result = ladder()
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.definition.tiers).toEqual({
			basis: 'spend',
			steps: [
				{ at: 3000, percentBp: 500, amountMinor: null },
				{ at: 5000, percentBp: 1500, amountMinor: null },
			],
		})
		expect(result.definition.percentBp).toBeNull()
		expect(result.definition.currency).toBe('USD')
	})

	it('builds an item-count ladder, which needs no currency', () => {
		const result = ladder({
			tierBasis: 'quantity',
			tiers: [newTier('2', '10'), newTier('4', '20')],
		})
		expect(result.ok && result.definition.tiers?.steps[1]).toEqual({
			at: 4,
			percentBp: 2000,
			amountMinor: null,
		})
		expect(result.ok && result.definition.currency).toBeNull()
	})

	it('builds a ladder of amounts', () => {
		const result = ladder({
			valueType: 'fixed',
			tiers: [newTier('30', '5'), newTier('50', '12')],
		})
		expect(result.ok && result.definition.tiers?.steps).toEqual([
			{ at: 3000, percentBp: null, amountMinor: 500 },
			{ at: 5000, percentBp: null, amountMinor: 1200 },
		])
		expect(result.ok && result.definition.amountMinor).toBeNull()
	})

	it('flags each step that cannot be read, by position', () => {
		const result = ladder({ tiers: [newTier('', '5'), newTier('50', 'x')] })
		expect(result).toMatchObject({
			ok: false,
			errors: { 'tiers.0.at': 'amount', 'tiers.1.value': 'percent' },
		})
	})

	it('wants tiers that go up, and at least one', () => {
		expect(
			ladder({ tiers: [newTier('50', '15'), newTier('30', '5')] }),
		).toMatchObject({ ok: false, errors: { tiers: 'tiers_ascending' } })
		expect(ladder({ tiers: [] })).toMatchObject({
			ok: false,
			errors: { tiers: 'add_tier' },
		})
	})

	it('ignores a ladder where it does not fit', () => {
		// A modifier discount, a counted rule or a till discount has one value.
		const modifiers = convert({
			tiersOn: true,
			scope: 'modifiers',
			modifierGroupIds: ['toppings'],
			percent: '10',
		})
		expect(modifiers.ok && modifiers.definition.tiers).toBeUndefined()
		expect(modifiers.ok && modifiers.definition.percentBp).toBe(1000)
		const counted = convert({
			tiersOn: true,
			quantityKind: 'minimum',
			quantityN: '2',
			scope: 'items',
			itemIds: ['a'],
			percent: '10',
		})
		expect(counted.ok && counted.definition.tiers).toBeUndefined()
	})

	it('limits a discount to options on items, categories and modifiers only', () => {
		const items = convert({
			scope: 'items',
			itemIds: ['pizza'],
			variants: [{ group: 'Size', values: ['Large', 'large', ' Medium '] }],
		})
		expect(items.ok && items.definition.target.variants).toEqual([
			{ group: 'size', values: ['large', 'medium'] },
		])
		const order = convert({
			scope: 'order',
			variants: [{ group: 'size', values: ['large'] }],
		})
		expect(order.ok && order.definition.target.variants).toBeUndefined()
	})

	it('drops option rows still being filled in', () => {
		const result = convert({
			scope: 'items',
			itemIds: ['pizza'],
			variants: [
				{ group: '', values: [] },
				{ group: 'crust', values: [] },
			],
		})
		expect(result.ok && result.definition.target.variants).toBeUndefined()
	})

	it('caps the option types and their values', () => {
		const many = convert({
			scope: 'items',
			itemIds: ['pizza'],
			variants: ['a', 'b', 'c', 'd'].map((group) => ({
				group,
				values: ['x'],
			})),
		})
		expect(many).toMatchObject({
			ok: false,
			errors: { variants: 'too_many_variants' },
		})
		const values = convert({
			scope: 'modifiers',
			modifierGroupIds: ['toppings'],
			variants: [
				{
					group: 'size',
					values: Array.from({ length: 51 }, (_, index) => `v${index}`),
				},
			],
		})
		expect(values).toMatchObject({
			ok: false,
			errors: { 'modifier-variants': 'too_many_variants' },
		})
		const twice = convert({
			scope: 'items',
			itemIds: ['pizza'],
			variants: [
				{ group: 'size', values: ['large'] },
				{ group: 'Size', values: ['small'] },
			],
		})
		expect(twice).toMatchObject({ ok: false, errors: { variants: 'invalid' } })
	})

	it('limits a deal group to options', () => {
		const result = convert({
			quantityKind: 'bundle',
			valueType: 'fixed_price',
			amount: '20',
			bundleSlots: [
				{
					...newSlot('2'),
					categoryIds: ['pizzas'],
					variants: [{ group: 'size', values: ['large'] }],
				},
			],
		})
		expect(result.ok && result.definition.quantityRule).toMatchObject({
			kind: 'bundle',
			slots: [
				{ quantity: 2, variants: [{ group: 'size', values: ['large'] }] },
			],
		})
	})

	it('builds a buy-by-spend rule', () => {
		const result = convert({
			quantityKind: 'buy_get',
			percent: '100',
			buyGroup: {
				...emptyGroup(),
				itemIds: ['burger'],
				by: 'spend',
				spend: '30',
			},
			getGroup: { ...emptyGroup('1'), itemIds: ['dessert'] },
		})
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.definition.quantityRule).toMatchObject({
			kind: 'buy_get',
			buy: { spendMinor: 3000, itemIds: ['burger'] },
		})
		expect(result.definition.currency).toBe('USD')
	})

	it('flags a spend that is not an amount', () => {
		const result = convert({
			quantityKind: 'buy_get',
			percent: '100',
			buyGroup: {
				...emptyGroup(),
				itemIds: ['burger'],
				by: 'spend',
				spend: 'lots',
			},
			getGroup: { ...emptyGroup('1'), itemIds: ['dessert'] },
		})
		expect(result).toMatchObject({
			ok: false,
			errors: { 'buyGroup.spend': 'amount' },
		})
	})

	it('limits free delivery to a fee', () => {
		const result = convert({
			valueType: 'free_delivery',
			maxDeliveryFee: '7.00',
		})
		expect(result.ok && result.definition.maxDeliveryFeeMinor).toBe(700)
		expect(result.ok && result.definition.currency).toBe('USD')
		expect(
			convert({ valueType: 'free_delivery', maxDeliveryFee: 'free' }),
		).toMatchObject({ ok: false, errors: { maxDeliveryFee: 'amount' } })
	})

	it('ignores a fee limit left on a discount that is not free delivery', () => {
		const result = convert({ maxDeliveryFee: '7.00' })
		expect(result.ok && result.definition.maxDeliveryFeeMinor).toBeUndefined()
	})

	it('saves which kinds it stacks with, and the old switch with it', () => {
		const some = convert({ combinesWith: ['item', 'order'] })
		expect(some.ok && some.definition.combinesWith).toEqual(['item', 'order'])
		expect(some.ok && some.definition.combinable).toBe(true)
		const none = convert({ combinesWith: [] })
		expect(none.ok && none.definition.combinesWith).toEqual([])
		expect(none.ok && none.definition.combinable).toBe(false)
	})

	it('reads a stored discount that still has only the old switch', () => {
		const base = convert({})
		if (!base.ok) throw new Error('invalid')
		const { combinesWith: ignoredCombinesWith, ...old } = base.definition
		const state = stateFromDefinition(
			{ ...old, combinable: true },
			[],
			'USD',
			EN,
		)
		expect(state.combinesWith).toEqual(['item', 'order', 'delivery'])
	})

	it('round trips all of it', () => {
		const first = ladder({
			scope: 'categories',
			categoryIds: ['pizzas'],
			variants: [
				{ group: 'size', values: ['large', 'medium'] },
				{ group: 'crust', values: ['thin'] },
			],
			combinesWith: ['order'],
			maxUnits: '4',
		})
		if (!first.ok) throw new Error(JSON.stringify(first.errors))
		const second = stateToDefinition(
			stateFromDefinition(first.definition, [], 'USD', EN),
			OPTIONS,
		)
		expect(second.ok && second.definition).toEqual(first.definition)

		const spend = convert({
			quantityKind: 'buy_get',
			percent: '100',
			buyGroup: {
				...emptyGroup(),
				itemIds: ['burger'],
				variants: [{ group: 'size', values: ['large'] }],
				by: 'spend',
				spend: '30',
			},
			getGroup: { ...emptyGroup('1'), itemIds: ['dessert'] },
		})
		if (!spend.ok) throw new Error(JSON.stringify(spend.errors))
		const spendBack = stateToDefinition(
			stateFromDefinition(spend.definition, [], 'USD', EN),
			OPTIONS,
		)
		expect(spendBack.ok && spendBack.definition).toEqual(spend.definition)

		const delivery = convert({
			valueType: 'free_delivery',
			maxDeliveryFee: '7.00',
		})
		if (!delivery.ok) throw new Error(JSON.stringify(delivery.errors))
		const deliveryBack = stateToDefinition(
			stateFromDefinition(delivery.definition, [], 'USD', EN),
			OPTIONS,
		)
		expect(deliveryBack.ok && deliveryBack.definition).toEqual(
			delivery.definition,
		)
	})
})

describe('stateFromDefinition', () => {
	it('round trips a definition', () => {
		const first = convert({
			scope: 'items',
			itemIds: ['a', 'b'],
			excludeCategoryIds: ['c'],
			quantityKind: 'bogo',
			buyQuantity: '2',
			getQuantity: '1',
			requireOn: true,
			requireQuantity: '2',
			requireCategoryIds: ['c2'],
			startsAt: '2026-11-01T10:00',
			hoursOn: true,
			schedule: [{ day: 1, start: '11:00', end: '14:00' }],
			totalLimit: '100',
			perCustomerOn: true,
			perCustomerCount: '3',
			perCustomerPeriod: 'day',
			allLocations: false,
			locationIds: ['l1'],
			maxDiscount: '12.50',
			priority: '4',
			combinesWith: ['item', 'order'],
		})
		if (!first.ok) throw new Error(JSON.stringify(first.errors))
		const back = stateFromDefinition(first.definition, [], 'USD', EN)
		const second = stateToDefinition(back, OPTIONS)
		expect(second.ok && second.definition).toEqual(first.definition)
	})

	it('keeps a bundle and its set price when other fields are edited', () => {
		const base = convert({})
		if (!base.ok) throw new Error('invalid')
		const stored = {
			...base.definition,
			valueType: 'fixed_price' as const,
			percentBp: null,
			amountMinor: 2000,
			currency: 'USD',
			maxDiscountedUnits: 4,
			quantityRule: {
				kind: 'bundle' as const,
				slots: [
					{ quantity: 2, itemIds: [], categoryIds: ['pizza'] },
					{ quantity: 1, itemIds: [], categoryIds: ['drinks'] },
				],
			},
		}
		const editing = stateFromDefinition(stored, [], 'USD', EN)
		const saved = stateToDefinition(
			{ ...editing, name: { en: 'Renamed deal' } },
			OPTIONS,
		)
		expect(saved.ok && saved.definition).toEqual({
			...stored,
			name: 'Renamed deal',
			nameI18n: { en: 'Renamed deal' },
		})
	})

	it('keeps a buy-get rule when the discount is saved again', () => {
		const base = convert({})
		if (!base.ok) throw new Error('invalid')
		const stored = {
			...base.definition,
			percentBp: 10_000,
			maxDiscountedUnits: 2,
			quantityRule: {
				kind: 'buy_get' as const,
				buy: { quantity: 1, itemIds: ['burger'], categoryIds: [] },
				get: { quantity: 1, itemIds: ['fries'], categoryIds: [] },
			},
		}
		const saved = stateToDefinition(
			stateFromDefinition(stored, [], 'USD', EN),
			OPTIONS,
		)
		expect(saved.ok && saved.definition).toEqual(stored)
	})

	it('shows a custom total limit as custom', () => {
		const first = convert({ totalLimit: 'custom', totalLimitCustom: '75' })
		if (!first.ok) throw new Error('invalid')
		const back = stateFromDefinition(first.definition, [], 'USD', EN)
		expect(back.totalLimit).toBe('custom')
		expect(back.totalLimitCustom).toBe('75')
	})
})

describe('localized name and description', () => {
	const LOCALES = { locales: ['en', 'ar'], defaultLocale: 'en' }

	it('stores the default language as the canonical text and drops other languages', () => {
		const result = stateToDefinition(
			state({
				name: { en: ' Lunch deal ', ar: 'عرض الغداء', fr: 'Déjeuner', de: '' },
				description: { ar: 'خصم على الغداء', en: 'Lunch for less', es: 'x' },
			}),
			{ ...OPTIONS, locales: LOCALES },
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.definition).toMatchObject({
			name: 'Lunch deal',
			nameI18n: { en: 'Lunch deal', ar: 'عرض الغداء' },
			description: 'Lunch for less',
			descriptionI18n: { en: 'Lunch for less', ar: 'خصم على الغداء' },
		})
	})

	it('needs the name in the default language', () => {
		const missing = stateToDefinition(state({ name: { ar: 'عرض الغداء' } }), {
			...OPTIONS,
			locales: LOCALES,
		})
		expect(missing).toMatchObject({
			ok: false,
			errors: { name: 'default_language_required' },
		})
		const empty = stateToDefinition(state({ name: {} }), {
			...OPTIONS,
			locales: LOCALES,
		})
		expect(empty).toMatchObject({ ok: false, errors: { name: 'required' } })
	})

	it('checks the length in every language', () => {
		const result = stateToDefinition(
			state({ name: { en: 'Lunch', ar: 'ع'.repeat(61) } }),
			{ ...OPTIONS, locales: LOCALES },
		)
		expect(result).toMatchObject({ ok: false, errors: { name: 'too_long' } })
	})

	it('a description only in another language has no canonical text', () => {
		const result = stateToDefinition(state({ description: { ar: 'خصم' } }), {
			...OPTIONS,
			locales: LOCALES,
		})
		expect(result.ok && result.definition.description).toBeNull()
		expect(result.ok && result.definition.descriptionI18n).toEqual({
			ar: 'خصم',
		})
	})

	it('round trips, and fills a missing default entry from the canonical name', () => {
		const first = stateToDefinition(
			state({ name: { en: 'Lunch', ar: 'غداء' } }),
			{ ...OPTIONS, locales: LOCALES },
		)
		if (!first.ok) throw new Error(JSON.stringify(first.errors))
		const back = stateFromDefinition(first.definition, [], 'USD', LOCALES)
		expect(back.name).toEqual({ en: 'Lunch', ar: 'غداء' })
		expect(stateToDefinition(back, { ...OPTIONS, locales: LOCALES })).toEqual(
			first,
		)
		// The default language changed to Arabic, which has a translation.
		const arabic = stateFromDefinition(first.definition, [], 'USD', {
			defaultLocale: 'ar',
		})
		expect(arabic.name).toEqual({ en: 'Lunch', ar: 'غداء' })
		// A discount saved before translations: the canonical name is the default entry.
		const { nameI18n: ignoredNameI18n, ...plain } = first.definition
		expect(stateFromDefinition(plain, [], 'USD', LOCALES).name).toEqual({
			en: 'Lunch',
		})
	})
})

describe('generateCode', () => {
	it('makes a valid readable code', () => {
		expect(generateCode(() => 0)).toBe('SAVE-AAAAAAAA')
		expect(generateCode()).toMatch(/^SAVE-[A-Z2-9]{8}$/)
	})
})

describe('codes and money fields', () => {
	it('refuses more codes than a discount may hold', () => {
		const codes = Array.from(
			{ length: DISCOUNT_MAX_CODES + 1 },
			(_, index) => ({
				key: `k${index}`,
				id: null,
				code: `CODE${String(index).padStart(3, '0')}`,
				maxUses: '',
			}),
		)
		expect(convert({ application: 'code', codes })).toMatchObject({
			ok: false,
			errors: { codes: 'too_many_codes' },
		})
	})

	it('stores the currency when a percentage has a cap', () => {
		const withCap = convert({ maxDiscount: '5.00' })
		expect(withCap.ok && withCap.definition.currency).toBe('USD')
		const plain = convert({})
		expect(plain.ok && plain.definition.currency).toBeNull()
	})
})

describe('variable percentage with a cap', () => {
	const till = {
		application: 'manual' as const,
		valueType: 'variable_percent' as const,
		percent: '',
	}

	it('saves a percentage entered at the till with a maximum off', () => {
		const result = convert({ ...till, maxDiscount: '20' })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.definition).toMatchObject({
			valueType: 'variable_percent',
			percentBp: null,
			maxDiscountMinor: 2000,
			currency: 'USD',
		})
	})

	it('saves one with a minimum spend, and one with neither', () => {
		expect(convert({ ...till, minSubtotal: '30' }).ok).toBe(true)
		const plain = convert(till)
		expect(plain.ok && plain.definition.currency).toBeNull()
	})

	it('saves a percentage entered at the till with both a cap and a minimum', () => {
		expect(convert({ ...till, maxDiscount: '20', minSubtotal: '30' }).ok).toBe(
			true,
		)
	})
})

describe('currency issues land on a visible field', () => {
	const base = {
		valueType: 'percent',
		quantityKind: 'none',
		buyGroup: emptyGroup(),
	} as const
	const none = {
		maxDiscount: false,
		minSubtotal: false,
		maxDeliveryFee: false,
		tiers: false,
	}

	it('points at the field that needs the currency', () => {
		expect(currencyIssueField(base, { ...none, maxDiscount: true })).toBe(
			'maxDiscount',
		)
		expect(currencyIssueField(base, { ...none, minSubtotal: true })).toBe(
			'minSubtotal',
		)
		expect(currencyIssueField(base, { ...none, maxDeliveryFee: true })).toBe(
			'maxDeliveryFee',
		)
		expect(currencyIssueField(base, { ...none, tiers: true })).toBe('tiers')
		expect(currencyIssueField({ ...base, valueType: 'fixed' }, none)).toBe(
			'amount',
		)
		expect(
			currencyIssueField(
				{
					...base,
					quantityKind: 'buy_get',
					buyGroup: { ...emptyGroup(), by: 'spend' },
				},
				none,
			),
		).toBe('buyGroup.spend')
	})

	it('falls back to the discount choice, which the form always shows', () => {
		expect(
			currencyIssueField({ ...base, valueType: 'variable_amount' }, none),
		).toBe('valueType')
	})
})

describe('errors that name the problem', () => {
	it('says what buy-some-discount-some needs on the whole order', () => {
		expect(convert({ quantityKind: 'bogo', scope: 'order' })).toMatchObject({
			errors: { quantityKind: 'bogo_needs_items' },
		})
		const ok = convert({
			quantityKind: 'bogo',
			scope: 'items',
			itemIds: ['a'],
		})
		expect(ok.ok).toBe(true)
	})

	it('treats an end equal to the start as ending before it', () => {
		expect(
			convert({ startsAt: '2026-11-01T10:00', endsAt: '2026-11-01T10:00' }),
		).toMatchObject({ errors: { endsAt: 'end_before_start' } })
		expect(
			convert({ startsAt: '2026-11-01T10:00', endsAt: '2026-11-01T10:01' }).ok,
		).toBe(true)
	})

	it('refuses more weekly windows than the schema holds', () => {
		const schedule = Array.from({ length: 29 }, (_, index) => ({
			day: index % 7,
			start: '09:00',
			end: `${String(10 + (index % 10)).padStart(2, '0')}:00`,
		}))
		expect(convert({ hoursOn: true, schedule })).toMatchObject({
			errors: { schedule: 'too_many_windows' },
		})
		expect(convert({ hoursOn: true, schedule: schedule.slice(0, 28) }).ok).toBe(
			true,
		)
	})

	it('names the list that is too long', () => {
		const ids = (count: number) =>
			Array.from({ length: count }, (_, i) => `id${i}`)
		expect(convert({ scope: 'items', itemIds: ids(201) })).toMatchObject({
			errors: { target: 'too_many_items' },
		})
		expect(
			convert({ scope: 'categories', categoryIds: ids(101) }),
		).toMatchObject({
			errors: { target: 'too_many_categories' },
		})
		expect(convert({ excludeItemIds: ids(201) })).toMatchObject({
			errors: { 'exclude-items': 'too_many_items' },
		})
		expect(
			convert({ requireOn: true, requireItemIds: ids(201) }),
		).toMatchObject({ errors: { requirement: 'too_many_items' } })
		expect(
			convert({
				scope: 'modifiers',
				modifierGroupIds: ['g'],
				modifierOptionIds: ids(201),
			}),
		).toMatchObject({ errors: { 'modifier-options': 'too_many_modifiers' } })
		expect(convert({ scope: 'items', itemIds: ids(200) }).ok).toBe(true)
	})

	it('names the limits of a whole number instead of a bare "whole number"', () => {
		expect(convert({ quantityKind: 'exact', quantityN: '1' })).toMatchObject({
			errors: { quantityN: 'range:2:1000' },
		})
		expect(
			convert({
				scope: 'items',
				itemIds: ['a'],
				maxUnits: '0',
			}),
		).toMatchObject({ errors: { maxUnits: 'range:1:1000' } })
		expect(convert({ priority: '1001' })).toMatchObject({
			errors: { priority: 'range:0:1000' },
		})
		expect(
			convert({ perCustomerOn: true, perCustomerCount: '0' }),
		).toMatchObject({ errors: { perCustomerCount: 'range:1:10000' } })
		expect(
			convert({ requireOn: true, requireItemIds: ['a'], requireQuantity: 'x' }),
		).toMatchObject({ errors: { requireQuantity: 'range:1:1000' } })
		expect(
			convert({
				scope: 'items',
				itemIds: ['a'],
				quantityKind: 'bogo',
				buyQuantity: '0',
				getQuantity: '1',
			}),
		).toMatchObject({ errors: { buyQuantity: 'range:1:1000' } })
	})

	it('round trips a range code', () => {
		expect(parseRangeCode(rangeCode(2, 1000))).toEqual({ min: 2, max: 1000 })
		expect(parseRangeCode('required')).toBeNull()
	})
})

describe('currencies orders cannot count in yet', () => {
	// Orders price in hundredths, so money in a currency with another number of
	// decimals would be read as the wrong sum. Percentages stay.
	const kwd = { currency: 'KWD' }
	const jpy = { currency: 'JPY' }
	const eur = { currency: 'EUR' }
	const buyBySpend = {
		quantityKind: 'buy_get' as const,
		percent: '100',
		buyGroup: {
			...emptyGroup(),
			itemIds: ['burger'],
			by: 'spend' as const,
			spend: '3',
		},
		getGroup: { ...emptyGroup('1'), itemIds: ['dessert'] },
	}

	it('keeps percentages working', () => {
		for (const options of [kwd, jpy]) {
			const result = convert({ percent: '15' }, options)
			expect(result.ok && result.definition).toMatchObject({
				valueType: 'percent',
				percentBp: 1500,
				currency: null,
			})
		}
	})

	it('still takes amounts in a two-decimal currency', () => {
		const result = convert(
			{ valueType: 'fixed', percent: '', amount: '5.00' },
			eur,
		)
		expect(result.ok && result.definition.amountMinor).toBe(500)
	})

	it('refuses a fixed amount, a set price and a variable amount', () => {
		const fixed = convert(
			{ valueType: 'fixed', percent: '', amount: '1.000' },
			kwd,
		)
		expect(fixed).toEqual({
			ok: false,
			errors: { valueType: 'amounts_unavailable' },
		})
		const price = convert(
			{
				valueType: 'fixed_price',
				percent: '',
				amount: '50',
				scope: 'items',
				itemIds: ['burger'],
			},
			jpy,
		)
		expect(price).toEqual({
			ok: false,
			errors: { valueType: 'amounts_unavailable' },
		})
		const variable = convert(
			{ valueType: 'variable_amount', percent: '', application: 'manual' },
			kwd,
		)
		expect(variable).toMatchObject({
			ok: false,
			errors: { valueType: 'amounts_unavailable' },
		})
	})

	it('refuses a cap, a minimum spend and a delivery fee limit', () => {
		expect(convert({ maxDiscount: '2.000' }, kwd)).toEqual({
			ok: false,
			errors: { maxDiscount: 'limits_unavailable' },
		})
		expect(convert({ minSubtotal: '20' }, jpy)).toEqual({
			ok: false,
			errors: { minSubtotal: 'limits_unavailable' },
		})
		expect(
			convert({ valueType: 'free_delivery', maxDeliveryFee: '1.500' }, kwd),
		).toEqual({ ok: false, errors: { maxDeliveryFee: 'limits_unavailable' } })
		// Empty fields are not amounts.
		expect(convert({ maxDiscount: '', minSubtotal: ' ' }, kwd).ok).toBe(true)
	})

	it('refuses spend tiers and a buy-by-spend deal, not quantity ones', () => {
		const spend = convert(
			{
				tiersOn: true,
				tierBasis: 'spend',
				tiers: [newTier('30', '5'), newTier('50', '10')],
			},
			kwd,
		)
		expect(spend).toEqual({
			ok: false,
			errors: { tiers: 'limits_unavailable' },
		})
		expect(convert(buyBySpend, kwd)).toEqual({
			ok: false,
			errors: { 'buyGroup.spend': 'limits_unavailable' },
		})
		const units = convert(
			{
				tiersOn: true,
				tierBasis: 'quantity',
				tiers: [newTier('2', '10'), newTier('4', '20')],
			},
			kwd,
		)
		expect(units.ok).toBe(true)
	})

	it('refuses fixed-amount tiers', () => {
		const result = convert(
			{
				valueType: 'fixed',
				percent: '',
				tiersOn: true,
				tierBasis: 'quantity',
				tiers: [newTier('2', '1.000'), newTier('4', '2.000')],
			},
			kwd,
		)
		expect(result).toEqual({
			ok: false,
			errors: { valueType: 'amounts_unavailable' },
		})
	})

	it('does not flag amounts a dollar organization enters', () => {
		expect(convert({ maxDiscount: '5.00', minSubtotal: '20' }).ok).toBe(true)
		expect(convert(buyBySpend).ok).toBe(true)
	})
})

describe('currency follows the locations a discount applies to', () => {
	const toronto = { id: 'to', name: 'Toronto', currency: 'CAD', active: true }
	const boston = { id: 'bo', name: 'Boston', currency: 'USD', active: true }
	const closed = { id: 'cl', name: 'Closed', currency: 'SAR', active: false }
	const everywhere = { allLocations: true, locationIds: [] as string[] }

	it('takes the one currency every location shares, so a CAD-only organization gets CAD', () => {
		expect(resolveDiscountCurrency(everywhere, [toronto], 'USD')).toEqual({
			mixed: false,
			currency: 'CAD',
		})
	})

	it('falls back when there is no location to read a currency from', () => {
		expect(resolveDiscountCurrency(everywhere, [], 'SAR')).toEqual({
			mixed: false,
			currency: 'SAR',
		})
	})

	it('is mixed when "all locations" spans two currencies', () => {
		expect(
			resolveDiscountCurrency(everywhere, [toronto, boston], 'USD'),
		).toEqual({ mixed: true, currency: null })
	})

	it('leaves an inactive location out of "all locations"', () => {
		expect(
			resolveDiscountCurrency(everywhere, [toronto, closed], 'USD'),
		).toEqual({ mixed: false, currency: 'CAD' })
	})

	it('lets chosen locations that share a currency settle it in a mixed organization', () => {
		expect(
			resolveDiscountCurrency(
				{ allLocations: false, locationIds: ['to'] },
				[toronto, boston],
				'USD',
			),
		).toEqual({ mixed: false, currency: 'CAD' })
		expect(
			resolveDiscountCurrency(
				{ allLocations: false, locationIds: ['to', 'bo'] },
				[toronto, boston],
				'USD',
			),
		).toEqual({ mixed: true, currency: null })
	})

	it('stores the locations currency on a fixed amount', () => {
		const result = convert(
			{ valueType: 'fixed', percent: '', amount: '5' },
			{
				currency: 'CAD',
			},
		)
		expect(result.ok && result.definition).toMatchObject({
			amountMinor: 500,
			currency: 'CAD',
		})
	})

	const mixed = { currency: null }
	const amountCases: Array<[string, Partial<EditorState>, string]> = [
		[
			'a fixed amount',
			{ valueType: 'fixed', percent: '', amount: '5' },
			'amount',
		],
		[
			'a set price',
			{
				valueType: 'fixed_price',
				percent: '',
				amount: '5',
				scope: 'items',
				itemIds: ['a'],
			},
			'amount',
		],
		['a cap', { maxDiscount: '5' }, 'maxDiscount'],
		['a minimum spend', { minSubtotal: '20' }, 'minSubtotal'],
		[
			'a spend ladder',
			{
				tiersOn: true,
				tierBasis: 'spend',
				percent: '',
				tiers: [newTier('30', '5'), newTier('50', '15')],
			},
			'tiers',
		],
		[
			'a delivery fee limit',
			{
				valueType: 'free_delivery',
				percent: '',
				fulfillments: ['delivery'],
				maxDeliveryFee: '5',
			},
			'maxDeliveryFee',
		],
	]
	it.each(amountCases)(
		'refuses %s when the locations mix currencies',
		(_n, overrides, field) => {
			const result = convert(overrides, mixed)
			expect(result.ok).toBe(false)
			if (result.ok) return
			expect(result.errors.locations).toBe('mixed_currencies')
			expect(result.errors[field]).toBe('mixed_currencies')
			expect(stateUsesAmounts(state(overrides))).toBe(true)
		},
	)

	it('refuses a spend-based deal when the locations mix currencies', () => {
		const result = convert(
			{
				quantityKind: 'buy_get',
				percent: '100',
				buyGroup: {
					...emptyGroup(),
					itemIds: ['burger'],
					by: 'spend',
					spend: '3',
				},
				getGroup: { ...emptyGroup('1'), itemIds: ['dessert'] },
			},
			mixed,
		)
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.errors.locations).toBe('mixed_currencies')
	})

	it('still saves a percentage without a cap when the locations mix currencies', () => {
		const result = convert({}, mixed)
		expect(result.ok && result.definition).toMatchObject({
			percentBp: 1000,
			currency: null,
		})
		expect(stateUsesAmounts(state({}))).toBe(false)
	})

	it('keeps the two-decimal block working with the real currency', () => {
		const result = convert(
			{ valueType: 'fixed', percent: '', amount: '5' },
			{ currency: 'KWD' },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.errors.valueType).toBe('amounts_unavailable')
	})
})
