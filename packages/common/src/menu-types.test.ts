import { describe, expect, it } from 'vitest'
import {
	ALLERGENS,
	ALLERGEN_LABELS,
	DIETARY_FLAGS,
	MENU_TYPES,
	MODIFIER_SELECTION_TYPES,
	MenuItemInputSchema,
	MenuInputSchema,
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
})
