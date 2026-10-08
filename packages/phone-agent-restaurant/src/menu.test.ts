import { describe, expect, it } from 'vitest'
import {
	type AgentMenu,
	type AgentMenuItem,
	type AgentMenuOption,
	type AgentModifierGroup,
	buildCartLine,
	describeMenuItem,
	findMenuItem,
	HandoffCartSchema,
	resolveMenuItem,
	searchMenuItems,
	summarizeCart,
} from './menu.ts'

const menus: AgentMenu[] = [
	{
		id: 'menu',
		displayName: 'Main',
		availabilityStatus: 'available',
		categories: [
			{
				id: 'pizza',
				displayName: 'Pizzas',
				description: null,
				upsellCategoryIds: [],
				availabilityStatus: 'available',
				items: [
					{
						id: 'margherita',
						displayName: 'Margherita Pizza',
						description: 'Tomato, mozzarella, basil',
						price: 0,
						variations: {
							groups: [
								{
									id: 'size',
									name: 'Size',
									values: [
										{ id: 'small', name: 'Small' },
										{ id: 'large', name: 'Large' },
									],
								},
							],
							variants: [
								{
									id: 'v_small',
									valueIds: ['small'],
									price: 10,
									availabilityStatus: 'available',
								},
								{
									id: 'v_large',
									valueIds: ['large'],
									price: 15,
									availabilityStatus: 'available',
								},
							],
						},
						isGlutenFree: false,
						isVegetarian: true,
						allergens: ['dairy'],
						isPopular: true,
						isUpsell: false,
						availabilityStatus: 'available',
						modifierGroups: [
							{
								id: 'crust',
								name: 'Crust',
								selectionType: 'single',
								minSelections: 1,
								maxSelections: 1,
								availabilityStatus: 'available',
								options: [
									{
										id: 'thin',
										displayName: 'Thin',
										price: 0,
										availabilityStatus: 'available',
									},
									{
										id: 'stuffed',
										displayName: 'Stuffed',
										price: 2.5,
										availabilityStatus: 'available',
									},
								],
							},
						],
					},
					{
						id: 'garlic',
						displayName: 'Garlic Knots',
						description: null,
						price: 6,
						variations: { groups: [], variants: [] },
						isGlutenFree: false,
						isVegetarian: true,
						allergens: [],
						isPopular: false,
						isUpsell: true,
						availabilityStatus: 'available',
						modifierGroups: [],
					},
				],
			},
		],
	},
]

let counter = 0
const makeId = () => `line_${++counter}`

describe('menu helpers', () => {
	it('finds items from rough speech', () => {
		expect(searchMenuItems(menus, 'margarita pizzas')[0]?.item.id).toBe(
			'margherita',
		)
		expect(searchMenuItems(menus, 'garlic knot')[0]?.item.id).toBe('garlic')
		expect(searchMenuItems(menus, 'sushi')).toEqual([])
	})

	it('requires a size and required choices', () => {
		expect(buildCartLine(menus, { item: 'margherita' }, makeId)).toMatchObject({
			ok: false,
			error: expect.stringContaining('size'),
		})
		expect(
			buildCartLine(menus, { item: 'margherita', variantId: 'large' }, makeId),
		).toMatchObject({ ok: false, error: expect.stringContaining('Crust') })
	})

	it('prices a valid line in the Sites cart shape', () => {
		const result = buildCartLine(
			menus,
			{
				item: 'Margherita Pizza',
				variantId: 'Large',
				optionIds: ['stuffed'],
				quantity: 2,
				instructions: 'well done',
			},
			makeId,
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.line).toMatchObject({
			itemId: 'margherita',
			variantId: 'v_large',
			basePrice: 15,
			unitPrice: 17.5,
			quantity: 2,
		})
		expect(HandoffCartSchema.parse([result.line])).toHaveLength(1)
		expect(summarizeCart([result.line]).subtotal).toBe('$35.00')
	})

	it('enforces the maximum number of choices', () => {
		expect(
			buildCartLine(
				menus,
				{
					item: 'margherita',
					variantId: 'v_small',
					optionIds: ['thin', 'stuffed'],
				},
				makeId,
			),
		).toMatchObject({ ok: false, error: expect.stringContaining('at most 1') })
	})
})

function option(
	id: string,
	displayName: string,
	price = 0,
	nestedModifierGroups?: AgentModifierGroup[],
): AgentMenuOption {
	return {
		id,
		displayName,
		price,
		availabilityStatus: 'available',
		...(nestedModifierGroups ? { nestedModifierGroups } : {}),
	}
}

function group(
	id: string,
	name: string,
	options: AgentMenuOption[],
	minSelections = 0,
	maxSelections: number | null = null,
): AgentModifierGroup {
	return {
		id,
		name,
		selectionType: 'single',
		minSelections,
		maxSelections,
		availabilityStatus: 'available',
		options,
	}
}

function item(
	id: string,
	displayName: string,
	extra: Partial<AgentMenuItem> = {},
): AgentMenuItem {
	return {
		id,
		displayName,
		description: null,
		price: 10,
		variations: { groups: [], variants: [] },
		isGlutenFree: false,
		isVegetarian: false,
		allergens: [],
		isPopular: false,
		isUpsell: false,
		availabilityStatus: 'available',
		modifierGroups: [],
		...extra,
	}
}

const cheese = group(
	'cheese',
	'Cheese',
	[option('mozz', 'Mozzarella', 1), option('cheddar', 'Cheddar', 1.5)],
	1,
	1,
)

const shop: AgentMenu[] = [
	{
		id: 'shop',
		displayName: 'Shop',
		availabilityStatus: 'available',
		categories: [
			{
				id: 'mains',
				displayName: 'Mains',
				description: null,
				upsellCategoryIds: [],
				availabilityStatus: 'available',
				items: [
					item('pep-pizza', 'Pepperoni Pizza', {
						modifierGroups: [
							group(
								'size',
								'Size',
								[
									option('small', 'Small'),
									option('large', 'Large', 4),
									option('xl', 'Extra Large', 6),
									option('twelve', '12" Personal', 2),
								],
								1,
								1,
							),
							group(
								'crust',
								'Crust',
								[
									option('thin', 'Thin'),
									option('stuffed', 'Stuffed', 3, [cheese]),
								],
								1,
								1,
							),
						],
					}),
					item('pep-calzone', 'Pepperoni Calzone'),
					item('veg', 'Veggie Pizza', {
						variations: {
							groups: [
								{
									id: 'sz',
									name: 'Size',
									values: [
										{ id: 'm', name: 'Medium' },
										{ id: 'r', name: 'Regular' },
										{ id: 'twelve', name: '12 inch' },
									],
								},
							],
							variants: [
								{
									id: 'v-m',
									valueIds: ['m'],
									price: 12,
									availabilityStatus: 'available',
								},
								{
									id: 'v-r',
									valueIds: ['r'],
									price: 11,
									availabilityStatus: 'available',
								},
								{
									id: 'v-12',
									valueIds: ['twelve'],
									price: 14,
									availabilityStatus: 'available',
								},
							],
						},
					}),
					item('chicken-wings', 'Chicken Wings'),
					item('fattoush', 'فتوش'),
				],
			},
		],
	},
]

describe('resolveMenuItem', () => {
	it('returns one item for ids, exact names, and clear best matches', () => {
		expect(resolveMenuItem(shop, 'pep-calzone')).toMatchObject({
			status: 'found',
			entry: { item: { id: 'pep-calzone' } },
		})
		expect(resolveMenuItem(shop, 'pepperoni pizza')).toMatchObject({
			status: 'found',
			entry: { item: { id: 'pep-pizza' } },
		})
		expect(resolveMenuItem(shop, 'large pepperoni pizza')).toMatchObject({
			status: 'found',
			entry: { item: { id: 'pep-pizza' } },
		})
		expect(resolveMenuItem(shop, 'calzone')).toMatchObject({
			status: 'found',
			entry: { item: { id: 'pep-calzone' } },
		})
		expect(findMenuItem(shop, 'chiken wings')?.item.id).toBe('chicken-wings')
		expect(findMenuItem(shop, 'الفتوش')?.item.id).toBe('fattoush')
	})

	it('returns candidates when more than one item fits', () => {
		const result = resolveMenuItem(shop, 'pepperoni')
		expect(result.status).toBe('ambiguous')
		if (result.status !== 'ambiguous') return
		expect(result.candidates.map((entry) => entry.item.id).sort()).toEqual([
			'pep-calzone',
			'pep-pizza',
		])
		expect(findMenuItem(shop, 'pepperoni')).toBeNull()
	})

	it("doesn't commit to a weak partial match", () => {
		const result = resolveMenuItem(shop, 'chicken sandwich')
		expect(result).toMatchObject({
			status: 'ambiguous',
			candidates: [{ item: { id: 'chicken-wings' } }],
		})
		expect(resolveMenuItem(shop, 'sushi')).toEqual({ status: 'not_found' })
	})

	it('asks which item from buildCartLine', () => {
		const result = buildCartLine(shop, { item: 'large pepperoni' }, makeId)
		expect(result).toMatchObject({
			ok: false,
			candidates: expect.arrayContaining([
				{ id: 'pep-pizza', name: 'Pepperoni Pizza' },
				{ id: 'pep-calzone', name: 'Pepperoni Calzone' },
			]),
		})
	})
})

describe('sizes said with the item', () => {
	it('picks a size modifier option from the item phrase', () => {
		const result = buildCartLine(
			shop,
			{ item: 'large pepperoni pizza', optionIds: ['thin'] },
			makeId,
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.line.options.map((o) => o.optionId).sort()).toEqual([
			'large',
			'thin',
		])
		expect(result.line.unitPrice).toBe(14)
	})

	it('prefers the most specific size and understands inches', () => {
		const xl = buildCartLine(
			shop,
			{ item: 'extra large pepperoni pizza', optionIds: ['thin'] },
			makeId,
		)
		expect(xl.ok && xl.line.options.some((o) => o.optionId === 'xl')).toBe(true)
		const personal = buildCartLine(
			shop,
			{ item: '12 inch personal pepperoni pizza', optionIds: ['thin'] },
			makeId,
		)
		expect(
			personal.ok && personal.line.options.some((o) => o.optionId === 'twelve'),
		).toBe(true)
	})

	it('picks a variant from the item phrase or a loose size label', () => {
		const medium = buildCartLine(shop, { item: 'medium veggie pizza' }, makeId)
		expect(medium).toMatchObject({ ok: true, line: { variantId: 'v-m' } })
		const regular = buildCartLine(shop, { item: 'reg veggie pizza' }, makeId)
		expect(regular).toMatchObject({ ok: true, line: { variantId: 'v-r' } })
		const inches = buildCartLine(
			shop,
			{ item: 'veggie pizza', variantId: '12"' },
			makeId,
		)
		expect(inches).toMatchObject({
			ok: true,
			line: { variantId: 'v-12', unitPrice: 14 },
		})
		expect(buildCartLine(shop, { item: 'veggie pizza' }, makeId)).toMatchObject(
			{ ok: false, error: expect.stringContaining('size') },
		)
	})
})

describe('nested choices', () => {
	it('describes nested groups under their option', () => {
		const entry = findMenuItem(shop, 'pep-pizza')!
		const crust = describeMenuItem(entry).choices.find(
			(choice) => choice.groupId === 'crust',
		)!
		expect(
			crust.options.find((o) => o.optionId === 'stuffed')?.choices,
		).toEqual([
			expect.objectContaining({
				groupId: 'cheese',
				required: true,
				options: [
					expect.objectContaining({ optionId: 'mozz' }),
					expect.objectContaining({ optionId: 'cheddar' }),
				],
			}),
		])
	})

	it('requires nested groups only when their option is chosen', () => {
		expect(
			buildCartLine(
				shop,
				{ item: 'pep-pizza', optionIds: ['small', 'thin'] },
				makeId,
			).ok,
		).toBe(true)
		expect(
			buildCartLine(
				shop,
				{ item: 'pep-pizza', optionIds: ['small', 'stuffed'] },
				makeId,
			),
		).toMatchObject({
			ok: false,
			error: expect.stringContaining('choose Cheese for Stuffed'),
		})
	})

	it('validates the nested max and prices nested choices', () => {
		expect(
			buildCartLine(
				shop,
				{
					item: 'pep-pizza',
					optionIds: ['small', 'stuffed', 'mozz', 'cheddar'],
				},
				makeId,
			),
		).toMatchObject({ ok: false, error: expect.stringContaining('at most 1') })
		const result = buildCartLine(
			shop,
			{ item: 'pep-pizza', optionIds: ['large', 'Stuffed', 'Cheddar'] },
			makeId,
		)
		expect(result).toMatchObject({ ok: true, line: { unitPrice: 18.5 } })
	})

	it('rejects a nested choice without its parent option', () => {
		expect(
			buildCartLine(
				shop,
				{ item: 'pep-pizza', optionIds: ['small', 'thin', 'mozz'] },
				makeId,
			),
		).toMatchObject({
			ok: false,
			error: expect.stringContaining('only goes with Stuffed'),
		})
	})
})

describe('size labels', () => {
	function sized(sizes: Array<[id: string, name: string]>): AgentMenu[] {
		return [
			{
				id: 'sized',
				displayName: 'Sized',
				availabilityStatus: 'available',
				categories: [
					{
						id: 'drinks',
						displayName: 'Drinks',
						description: null,
						availabilityStatus: 'available',
						upsellCategoryIds: [],
						items: [
							item('coffee', 'Coffee', {
								variations: {
									groups: [
										{
											id: 'size',
											name: 'Size',
											values: sizes.map(([id, name]) => ({ id, name })),
										},
									],
									variants: sizes.map(([id], index) => ({
										id: `v-${id}`,
										valueIds: [id],
										price: 3 + index,
										availabilityStatus: 'available' as const,
									})),
								},
							}),
						],
					},
				],
			},
		]
	}

	const order = (menu: AgentMenu[], variantId: string) =>
		buildCartLine(menu, { item: 'coffee', variantId }, makeId)

	it('does not pick a qualified size for a plain one', () => {
		const menu = sized([
			['xs', 'Extra small'],
			['md', 'Medium'],
		])
		expect(order(menu, 'small')).toMatchObject({ ok: false })
		expect(order(menu, 'extra small')).toMatchObject({
			ok: true,
			line: { variantId: 'v-xs' },
		})
	})

	it('matches whole words, not parts of words', () => {
		const menu = sized([
			['sm', 'Small'],
			['lg', 'Large'],
		])
		expect(order(menu, 'lar')).toMatchObject({ ok: false })
		expect(order(menu, 'mall')).toMatchObject({ ok: false })
		expect(order(menu, 'lg')).toMatchObject({
			ok: true,
			line: { variantId: 'v-lg' },
		})
	})

	it('accepts a shorter name when only one label has every word', () => {
		const menu = sized([
			['sm', 'Small (10 oz)'],
			['lg', 'Large (16 oz)'],
		])
		expect(order(menu, 'large')).toMatchObject({
			ok: true,
			line: { variantId: 'v-lg' },
		})
		expect(order(menu, '16 oz')).toMatchObject({
			ok: true,
			line: { variantId: 'v-lg' },
		})
		expect(order(menu, 'oz')).toMatchObject({ ok: false })
	})
})
