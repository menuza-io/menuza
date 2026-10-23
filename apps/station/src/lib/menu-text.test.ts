import { describe, expect, it } from 'vitest'
import { localizeMenu, menuText } from './menu-text.ts'
import { type MenuPayload } from './types.ts'

const json = (value: Record<string, string>) => JSON.stringify(value)

function menu(): MenuPayload {
	const option = {
		id: 'o1',
		displayName: json({ en: 'Extra cheese', ar: 'جبنة إضافية' }),
		price: 1,
		minSelections: 0,
		maxSelections: 1,
		isDefault: false,
		applySalesTax: true,
		availabilityStatus: 'available',
		position: 0,
	}
	return {
		organization: {
			id: 'org',
			name: 'Demo',
			slug: 'demo',
			currency: 'USD',
			defaultLocale: 'en',
		},
		locations: [
			{
				id: 'loc',
				name: 'Downtown',
				timezone: 'UTC',
				taxRate: 0,
				currency: 'USD',
				isDefault: true,
				phone: null,
			},
		],
		menus: [
			{
				id: 'm',
				displayName: json({ en: 'Dinner' }),
				menuType: 'dinner',
				availabilityStatus: 'available',
				position: 0,
				categories: [
					{
						id: 'c',
						displayName: json({ en: 'Starters', ar: 'مقبلات' }),
						availabilityStatus: 'available',
						position: 0,
						items: [
							{
								id: 'i',
								displayName: json({ en: 'Pizza' }),
								description: json({ en: '' }),
								price: 20,
								imageUrl: null,
								variations: {
									groups: [
										{
											id: 'g',
											name: json({ en: 'Size' }),
											values: [{ id: 'v', name: json({ en: 'Large' }) }],
										},
									],
									variants: [],
								},
								isVegetarian: false,
								isGlutenFree: false,
								isAlcohol: false,
								allergens: [],
								isPopular: false,
								availabilityStatus: 'available',
								position: 0,
								modifierGroups: [
									{
										id: 'mg',
										name: json({ en: 'Toppings' }),
										selectionType: 'multiple',
										minSelections: 0,
										maxSelections: null,
										availabilityStatus: 'available',
										position: 0,
										options: [option],
									},
								],
							},
						],
					},
				],
			},
		],
		locationOverrides: {},
	}
}

describe('menu text', () => {
	it('shows a translated name in the till’s language, never the raw map', () => {
		const en = localizeMenu(menu(), 'en')
		const category = en.menus[0]!.categories[0]!
		const item = category.items[0]!
		expect(category.displayName).toBe('Starters')
		expect(item.displayName).toBe('Pizza')
		// An empty translation is no description at all.
		expect(item.description).toBeNull()
		expect(item.variations.groups[0]!.name).toBe('Size')
		expect(item.variations.groups[0]!.values[0]!.name).toBe('Large')
		expect(item.modifierGroups[0]!.options[0]!.displayName).toBe('Extra cheese')
		expect(en.menus[0]!.displayName).toBe('Dinner')
	})

	it('reads Arabic where there is one, the restaurant’s default otherwise', () => {
		const ar = localizeMenu(menu(), 'ar')
		const category = ar.menus[0]!.categories[0]!
		expect(category.displayName).toBe('مقبلات')
		expect(category.items[0]!.displayName).toBe('Pizza')
	})

	it('passes plain names through, and decodes lines saved before', () => {
		expect(menuText('Pizza', 'en')).toBe('Pizza')
		expect(menuText(json({ en: 'Pizza' }), 'en')).toBe('Pizza')
		expect(menuText(null, 'en')).toBe('')
	})
})
