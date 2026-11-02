import { describe, expect, it } from 'vitest'
import { buildDiscountChoices, variantGroupChoices } from './editor-choices.ts'

let nextId = 0
const id = (prefix: string) => `${prefix}${(nextId += 1)}`

/** A valid stored `variations` column: every combination has a price. */
const variations = (
	groups: Array<{ name: string; values: string[] }>,
): { variations: string } => {
	const built = groups.map((group) => ({
		id: id('g'),
		name: group.name,
		values: group.values.map((name) => ({ id: id('v'), name })),
	}))
	const combinations = built.reduce<string[][]>(
		(rows, group) =>
			rows.flatMap((ids) => group.values.map((value) => [...ids, value.id])),
		[[]],
	)
	return {
		variations: JSON.stringify({
			groups: built,
			variants: combinations.map((valueIds) => ({
				id: id('x'),
				valueIds,
				price: 10,
			})),
		}),
	}
}

describe('buildDiscountChoices', () => {
	it('names modifier groups and options in the default language, never raw JSON', () => {
		const choices = buildDiscountChoices({
			groups: [
				{
					id: 'g1',
					name: '{"en":"Toppings","ar":"إضافات"}',
					internalName: null,
				},
				{ id: 'g2', name: '{"ar":"صلصات"}', internalName: 'Sauces' },
				{ id: 'g3', name: '', internalName: null },
			],
			options: [
				{
					id: 'o1',
					displayName: '{"en":"Ranch","ar":"رانش"}',
					internalName: null,
				},
				{ id: 'o2', displayName: '', internalName: 'Extra cheese' },
			],
			assignments: [
				{ groupId: 'g1', optionId: 'o1' },
				{ groupId: 'g2', optionId: 'o1' },
			],
			itemVariations: [],
			defaultLocale: 'ar',
		})
		expect(choices.groups.map((group) => group.name)).toEqual([
			'إضافات',
			'صلصات',
			'g3',
		])
		expect(choices.options).toEqual([
			{ id: 'o1', name: 'رانش', detail: 'إضافات, صلصات' },
			{ id: 'o2', name: 'Extra cheese', detail: null },
		])
		for (const option of [...choices.groups, ...choices.options]) {
			expect(option.name).not.toMatch(/^\{/)
			expect(option.detail ?? '').not.toMatch(/\{/)
		}
	})
})

describe('variantGroupChoices', () => {
	it('merges option types across items by name, most used first', () => {
		const groups = variantGroupChoices(
			[
				variations([
					{
						name: '{"en":"Size","ar":"الحجم"}',
						values: ['{"en":"Large"}', 'Small'],
					},
					{ name: 'Crust', values: ['Thin'] },
				]),
				variations([{ name: ' size ', values: ['Large', 'Medium'] }]),
				variations([{ name: 'Size', values: ['{"en":"Medium","ar":"وسط"}'] }]),
				{ variations: null },
				{ variations: 'not json' },
			],
			'en',
		)
		expect(groups).toEqual([
			{
				key: 'size',
				name: 'Size',
				items: 3,
				values: [
					{ id: 'large', name: 'Large', detail: null },
					{ id: 'medium', name: 'Medium', detail: null },
					{ id: 'small', name: 'Small', detail: null },
				],
			},
			{
				key: 'crust',
				name: 'Crust',
				items: 1,
				values: [{ id: 'thin', name: 'Thin', detail: null }],
			},
		])
	})

	it('keys a JSON-named group by its default-language name', () => {
		const [group] = variantGroupChoices(
			[
				variations([
					{
						name: '{"en":"Size","ar":"الحجم"}',
						values: ['{"en":"Large","ar":"كبير"}'],
					},
				]),
			],
			'ar',
		)
		expect(group).toMatchObject({
			key: 'الحجم',
			name: 'الحجم',
			values: [{ id: 'كبير', name: 'كبير' }],
		})
	})
})
