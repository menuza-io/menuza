import { describe, expect, it } from 'vitest'
import { demoCatalog } from './demo-catalog.ts'
import {
	buildLine,
	canQuickAdd,
	defaultSelections,
	defaultVariantPicks,
	stepOption,
	toggleOption,
	validateConfig,
} from './item-config.ts'
import { type MenuItem } from './types.ts'

const items = demoCatalog().menu.menus[0]!.categories.flatMap((c) => c.items)
const get = (id: string): MenuItem => items.find((i) => i.id === id)!

describe('item configuration', () => {
	it('adds a plain item in one tap', () => {
		expect(canQuickAdd(get('i-fries'))).toBe(true)
		expect(canQuickAdd(get('i-marg'))).toBe(false)
	})

	it('pre-selects the default option and passes validation', () => {
		const burger = get('i-burger')
		const sel = defaultSelections(burger)
		expect(sel['g-temp']).toEqual({ 'o-med': 1 })
		expect(validateConfig(burger, {}, sel)).toBeNull()
	})

	it('requires a required group to be chosen', () => {
		const steak = get('i-steak')
		expect(validateConfig(steak, {}, {})).toBe(
			'Choose How would you like it cooked?',
		)
	})

	it('caps multiple selections at the group maximum', () => {
		const burger = get('i-burger')
		const extras = burger.modifierGroups.find((g) => g.id === 'g-extras')!
		let sel = {}
		for (const o of extras.options) sel = toggleOption(extras, o, sel)
		expect(
			Object.keys((sel as Record<string, object>)['g-extras']!),
		).toHaveLength(4)
		const limited = { ...extras, maxSelections: 2 }
		let capped = {}
		for (const o of limited.options) capped = toggleOption(limited, o, capped)
		expect(
			Object.keys((capped as Record<string, object>)['g-extras']!),
		).toHaveLength(2)
	})

	it('prices a sized item with extras', () => {
		const pizza = get('i-pep')
		const picks = { ...defaultVariantPicks(pizza), size: 'lg' }
		const extras = pizza.modifierGroups[0]!
		const sel = toggleOption(extras, extras.options[0]!, {})
		const line = buildLine(pizza, picks, sel, 2, '  no basil ')
		expect(line).toMatchObject({
			variantId: 'v-lg',
			variantLabel: 'Large',
			baseCents: 2100,
			quantity: 2,
			instructions: 'no basil',
		})
		expect(line.options[0]).toMatchObject({ unitCents: 150, taxable: true })
	})

	it('steps quantity groups within limits', () => {
		const group = {
			...get('i-burger').modifierGroups[1]!,
			selectionType: 'quantity' as const,
			maxSelections: 3,
		}
		const opt = group.options[0]!
		let sel = stepOption(group, opt, 1, {})
		sel = stepOption(group, opt, 1, sel)
		sel = stepOption(group, opt, 5, sel)
		expect(sel[group.id]![opt.id]).toBe(2)
		expect(stepOption(group, opt, -9, sel)[group.id]).toEqual({})
	})

	it('a one-tap item keeps the options the menu selects by default', () => {
		const item: MenuItem = {
			...get('i-fries'),
			modifierGroups: [
				{
					id: 'g-sauce',
					name: 'Sauce',
					selectionType: 'multiple',
					minSelections: 0,
					maxSelections: 2,
					availabilityStatus: 'available',
					position: 0,
					options: [
						{
							id: 'o-ketchup',
							displayName: 'Ketchup',
							price: 0,
							minSelections: 0,
							maxSelections: null,
							isDefault: true,
							applySalesTax: true,
							availabilityStatus: 'available',
							position: 0,
						},
						{
							id: 'o-aioli',
							displayName: 'Aioli',
							price: 1,
							minSelections: 0,
							maxSelections: null,
							isDefault: false,
							applySalesTax: true,
							availabilityStatus: 'available',
							position: 1,
						},
					],
				},
			],
		}
		expect(canQuickAdd(item)).toBe(true)
		const line = buildLine(
			item,
			defaultVariantPicks(item),
			defaultSelections(item),
			1,
			'',
		)
		expect(line.options.map((o) => o.optionName)).toEqual(['Ketchup'])
	})
})
