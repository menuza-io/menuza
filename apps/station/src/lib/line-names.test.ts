import { describe, expect, it } from 'vitest'
import { decodedLine, renameLine } from './line-names.ts'
import { type MenuItem } from './types.ts'

const item = (name: string, size: string, cheese: string): MenuItem => ({
	id: 'pizza',
	displayName: name,
	description: null,
	price: 20,
	imageUrl: null,
	variations: {
		groups: [{ id: 'g', name: 'Size', values: [{ id: 'l', name: size }] }],
		variants: [
			{
				id: 'v-l',
				valueIds: ['l'],
				price: 22,
				availabilityStatus: 'available',
			},
		],
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
			name: 'Extras',
			selectionType: 'multiple',
			minSelections: 0,
			maxSelections: null,
			availabilityStatus: 'available',
			position: 0,
			options: [
				{
					id: 'cheese',
					displayName: cheese,
					price: 1,
					minSelections: 0,
					maxSelections: 1,
					isDefault: false,
					applySalesTax: true,
					availabilityStatus: 'available',
					position: 0,
				},
			],
		},
	],
})

const line = {
	itemId: 'pizza',
	name: 'بيتزا',
	variantId: 'v-l',
	variantLabel: 'كبير',
	options: [
		{
			groupId: 'mg',
			groupName: 'إضافات',
			optionId: 'cheese',
			optionName: 'جبنة',
			quantity: 1,
			unitCents: 100,
			taxable: true,
		},
	],
}

describe('order line names', () => {
	it('records a line in one language, whichever language the till rang it in', () => {
		const recorded = renameLine(line, item('Pizza', 'Large', 'Cheese'))
		expect(recorded.name).toBe('Pizza')
		expect(recorded.variantLabel).toBe('Large')
		expect(recorded.options[0]).toMatchObject({
			groupName: 'Extras',
			optionName: 'Cheese',
		})
	})

	it('keeps the recorded words when the menu no longer has the item', () => {
		expect(renameLine(line, undefined)).toBe(line)
	})

	it('decodes lines saved as raw translations, a part at a time', () => {
		const old = {
			...line,
			name: JSON.stringify({ en: 'Pizza' }),
			variantLabel: `${JSON.stringify({ en: 'Large' })} · ${JSON.stringify({ en: 'Thin' })}`,
		}
		const decoded = decodedLine(old)
		expect(decoded.name).toBe('Pizza')
		expect(decoded.variantLabel).toBe('Large · Thin')
	})
})
