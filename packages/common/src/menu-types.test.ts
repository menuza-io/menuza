import { describe, expect, it } from 'vitest'
import {
	ALLERGENS,
	ALLERGEN_LABELS,
	DIETARY_FLAGS,
	MENU_TYPES,
	MODIFIER_SELECTION_TYPES,
	MenuItemInputSchema,
	MenuInputSchema,
	MenuCategoryInputSchema,
	MenuOptionInputSchema,
	getCategoryDepth,
	isValidParentCategory,
	ModifierGroupInputSchema,
	ModifierOptionInputSchema,
	getLocalizedMenuValue,
	parseMenuItemImageKeys,
} from './menu-types.ts'

describe('menu-types', () => {
	it('defines all required allergens with labels', () => {
		expect(ALLERGENS).toContain('dairy')
		expect(ALLERGENS).toContain('eggs')
		expect(ALLERGENS).toContain('fish')
		expect(ALLERGENS).toContain('gluten')
		expect(ALLERGENS).toContain('mango')
		expect(ALLERGENS).toContain('peanuts')
		expect(ALLERGENS).toContain('sesame')
		expect(ALLERGENS).toContain('shellfish')
		expect(ALLERGENS).toContain('soy')
		expect(ALLERGENS).toContain('tree_nuts')
		expect(ALLERGEN_LABELS.dairy).toBe('Dairy')
		expect(ALLERGEN_LABELS.tree_nuts).toBe('Tree Nuts')
	})

	it('defines dietary flags', () => {
		expect(DIETARY_FLAGS).toContain('alcohol')
		expect(DIETARY_FLAGS).toContain('gluten_free')
		expect(DIETARY_FLAGS).toContain('vegetarian')
	})

	it('defines menu types and modifier selection types', () => {
		expect(MENU_TYPES).toContain('online_pos_kiosk')
		expect(MENU_TYPES).toContain('catering')
		expect(MODIFIER_SELECTION_TYPES).toContain('single')
		expect(MODIFIER_SELECTION_TYPES).toContain('multiple')
		expect(MODIFIER_SELECTION_TYPES).toContain('quantity')
		expect(MODIFIER_SELECTION_TYPES).toContain('pizza')
	})

	it('extracts localized menu value correctly', () => {
		expect(getLocalizedMenuValue('Burger')).toBe('Burger')
		expect(
			getLocalizedMenuValue(
				'{"en":"Pizza Margherita","ar":"بيتزا مارغريتا"}',
				'ar',
			),
		).toBe('بيتزا مارغريتا')
		expect(
			getLocalizedMenuValue(
				'{"en":"Pizza Margherita","ar":"بيتزا مارغريتا"}',
				'fr',
				'en',
			),
		).toBe('Pizza Margherita')
	})

	it('validates MenuItemInputSchema with calories and allergens', () => {
		const parsed = MenuItemInputSchema.safeParse({
			displayName: 'Cheeseburger',
			price: '12.99',
			isGlutenFree: false,
			isVegetarian: false,
			allergens: ['dairy', 'gluten'],
			calorieMin: '550',
			calorieMax: '750',
		})
		expect(parsed.success).toBe(true)
		if (parsed.success) {
			expect(parsed.data.price).toBe(12.99)
			expect(parsed.data.calorieMin).toBe(550)
			expect(parsed.data.calorieMax).toBe(750)
			expect(parsed.data.allergens).toEqual(['dairy', 'gluten'])
			expect(parsed.data.applySalesTax).toBe(true)
		}
	})

	it('allows up to five images for menu items only', () => {
		const parsed = MenuItemInputSchema.safeParse({
			displayName: 'Cheeseburger',
			price: 12.99,
			imageKeys: ['first', 'second'],
		})
		expect(parsed.success).toBe(true)
		if (parsed.success) {
			expect(parsed.data.imageKeys).toEqual(['first', 'second'])
		}

		expect(
			parseMenuItemImageKeys('["first", "second", "first"]', 'legacy'),
		).toEqual(['first', 'second'])
		expect(parseMenuItemImageKeys('not-json', 'legacy')).toEqual(['legacy'])

		const option = ModifierOptionInputSchema.parse({
			displayName: 'Extra cheese',
			imageKeys: ['not-supported'],
		})
		expect(option).not.toHaveProperty('imageKeys')
	})

	it('validates ModifierGroupInputSchema with pizza option pricing', () => {
		const parsed = ModifierGroupInputSchema.safeParse({
			name: 'Choose Toppings',
			selectionType: 'pizza',
			options: [
				{
					displayName: 'Pepperoni',
					price: 2,
					priceWhole: 2,
					priceLeft: 1,
					priceRight: 1,
					isTopping: true,
				},
			],
		})
		expect(parsed.success).toBe(true)
		if (parsed.success) {
			expect(parsed.data.selectionType).toBe('pizza')
			expect(parsed.data.options[0]?.priceWhole).toBe(2)
			expect(parsed.data.options[0]?.priceLeft).toBe(1)
		}
	})

	it('validates MenuInputSchema with nutritionalInfo and specialInstructions', () => {
		const parsed = MenuInputSchema.safeParse({
			displayName: 'Lunch Menu',
			menuType: 'online_pos_kiosk',
			nutritionalInfo: true,
			specialInstructions: true,
		})
		expect(parsed.success).toBe(true)
	})
	it('validates MenuCategoryInputSchema with parentId', () => {
		const parsed = MenuCategoryInputSchema.safeParse({
			displayName: 'Hot Coffees',
			parentId: 'cat_drinks_1',
		})
		expect(parsed.success).toBe(true)
		if (parsed.success) {
			expect(parsed.data.parentId).toBe('cat_drinks_1')
		}
	})

	it('validates category hierarchy depth and prevents cycles', () => {
		const categories = [
			{ id: 'drinks', parentId: null },
			{ id: 'hot_coffees', parentId: 'drinks' },
			{ id: 'americanos', parentId: 'hot_coffees' },
		]
		const map = new Map(categories.map((c) => [c.id, c]))

		expect(getCategoryDepth('drinks', map)).toBe(1)
		expect(getCategoryDepth('hot_coffees', map)).toBe(2)
		expect(getCategoryDepth('americanos', map)).toBe(3)

		// Adding Level 4 should be rejected (maxDepth = 3)
		const level4Check = isValidParentCategory(
			'blonde_americano',
			'americanos',
			categories,
			3,
		)
		expect(level4Check.valid).toBe(false)
		expect(level4Check.reason).toContain('maximum of 3 levels')

		// Self-parenting should be rejected
		const selfCheck = isValidParentCategory('drinks', 'drinks', categories, 3)
		expect(selfCheck.valid).toBe(false)
		expect(selfCheck.reason).toContain('cannot be its own parent')

		// Circular reference (descendant as parent) should be rejected
		const cycleCheck = isValidParentCategory(
			'drinks',
			'hot_coffees',
			categories,
			3,
		)
		expect(cycleCheck.valid).toBe(false)
		expect(cycleCheck.reason).toContain('descendant')

		// Valid parent assignment
		const validCheck = isValidParentCategory(
			'cold_coffees',
			'drinks',
			categories,
			3,
		)
		expect(validCheck.valid).toBe(true)
	})

	it('validates ModifierOptionInputSchema and MenuOptionInputSchema with nestedModifierGroupIds', () => {
		const parsedOption = ModifierOptionInputSchema.safeParse({
			displayName: 'French Fries',
			price: 4.5,
			nestedModifierGroupIds: ['grp_fry_size', 'grp_dipping_sauce'],
		})
		expect(parsedOption.success).toBe(true)
		if (parsedOption.success) {
			expect(parsedOption.data.nestedModifierGroupIds).toEqual([
				'grp_fry_size',
				'grp_dipping_sauce',
			])
		}

		const parsedMenuOption = MenuOptionInputSchema.safeParse({
			displayName: 'French Fries',
			price: 4.5,
			modifierGroupIds: ['grp_sides'],
			nestedModifierGroupIds: ['grp_fry_size'],
		})
		expect(parsedMenuOption.success).toBe(true)
		if (parsedMenuOption.success) {
			expect(parsedMenuOption.data.modifierGroupIds).toEqual(['grp_sides'])
			expect(parsedMenuOption.data.nestedModifierGroupIds).toEqual([
				'grp_fry_size',
			])
		}
	})
})
