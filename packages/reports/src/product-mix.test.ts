import { describe, expect, it } from 'vitest'
import {
	buildProductMixTree,
	flattenProductMixTree,
	PRODUCT_MIX_LEVELS,
	productMixCsv,
	productMixCurrencies,
	type ProductMixLevel,
	type ProductMixRow,
} from './product-mix.ts'

function dish(
	over: Partial<ProductMixRow> & Pick<ProductMixRow, 'item' | 'category'>,
): ProductMixRow {
	return {
		kind: 'dish',
		currency: 'USD',
		menuId: 'm1',
		menu: 'Lunch',
		categoryId: `c-${over.category}`,
		itemId: `i-${over.item}`,
		quantity: 1,
		salesMinor: 1000,
		...over,
	}
}

function option(
	over: Partial<ProductMixRow> &
		Pick<ProductMixRow, 'item' | 'category' | 'optionGroup' | 'option'>,
): ProductMixRow {
	return { ...dish(over), kind: 'option', ...over }
}

const rows: ProductMixRow[] = [
	dish({ item: 'Burger', category: 'Mains', quantity: 4, salesMinor: 5000 }),
	dish({ item: 'Salad', category: 'Mains', quantity: 2, salesMinor: 1800 }),
	dish({
		item: 'Cola',
		category: 'Drinks',
		quantity: 6,
		salesMinor: 1500,
		menu: 'Bar',
		menuId: 'm2',
	}),
	dish({ item: 'Old dish', category: '', menu: '', menuId: '', categoryId: '', quantity: 1, salesMinor: 700 }),
	option({
		item: 'Burger',
		category: 'Mains',
		optionGroup: 'Extras',
		option: 'Cheese',
		quantity: 3,
		salesMinor: 450,
	}),
	option({
		item: 'Burger',
		category: 'Mains',
		optionGroup: 'Extras',
		option: 'Bacon',
		quantity: 1,
		salesMinor: 200,
	}),
]

const TOTAL = 5000 + 1800 + 1500 + 700

describe('product mix tree', () => {
	it('puts a category total next to its dishes and shares of the filtered total', () => {
		const tree = buildProductMixTree(rows, ['category', 'dish'], 'USD')
		expect(tree.total).toEqual({ quantity: 13, salesMinor: TOTAL })
		const mains = tree.nodes.find((node) => node.label === 'Mains')!
		expect(mains.salesMinor).toBe(6800)
		expect(mains.quantity).toBe(6)
		expect(mains.shareOfSales).toBeCloseTo((6800 / TOTAL) * 100)
		expect(mains.shareOfQuantity).toBeCloseTo((6 / 13) * 100)
		expect(mains.averagePriceMinor).toBe(Math.round(6800 / 6))
		expect(mains.children.map((child) => child.label)).toEqual([
			'Burger',
			'Salad',
		])
	})

	it('groups lines with no stamped category under Earlier sales', () => {
		const tree = buildProductMixTree(rows, ['category'], 'USD')
		const earlier = tree.nodes.find((node) => node.label === 'Earlier sales')
		expect(earlier?.salesMinor).toBe(700)
		const menus = buildProductMixTree(rows, ['menu'], 'USD')
		expect(menus.nodes.map((node) => node.label)).toContain('Earlier sales')
	})

	it('rolls option sales into the dish and shows options as an of-which', () => {
		const tree = buildProductMixTree(rows, ['dish', 'optionGroup', 'option'], 'USD')
		const burger = tree.nodes.find((node) => node.label === 'Burger')!
		// The dish keeps its whole sales, options included.
		expect(burger.salesMinor).toBe(5000)
		const extras = burger.children.find((node) => node.label === 'Extras')!
		expect(extras.salesMinor).toBe(650)
		expect(extras.children.map((node) => node.label).sort()).toEqual([
			'Bacon',
			'Cheese',
		])
		expect(tree.total.salesMinor).toBe(TOTAL)
	})

	it('never changes the grand total whichever levels are switched on', () => {
		// Every subset of the five levels, in a fixed order.
		for (let mask = 0; mask < 1 << PRODUCT_MIX_LEVELS.length; mask += 1) {
			const levels = PRODUCT_MIX_LEVELS.filter((_, index) => mask & (1 << index))
			const tree = buildProductMixTree(rows, levels, 'USD')
			expect(tree.total.salesMinor).toBe(TOTAL)
			expect(tree.total.quantity).toBe(13)
			for (const level of ['menu', 'category', 'dish'] as const) {
				if (!levels.includes(level)) continue
				const sum = flattenProductMixTree(tree, level).reduce(
					(acc, row) => acc + row.salesMinor,
					0,
				)
				// The rows of a structural level add up to the total.
				expect(sum).toBe(TOTAL)
			}
		}
	})

	it('holds for randomised menus too (seeded property check)', () => {
		let seed = 20260101
		const random = () => {
			seed = (seed * 1664525 + 1013904223) % 4294967296
			return seed / 4294967296
		}
		for (let round = 0; round < 60; round += 1) {
			const generated: ProductMixRow[] = []
			const count = 1 + Math.floor(random() * 25)
			for (let index = 0; index < count; index += 1) {
				const menu = Math.floor(random() * 3)
				const category = Math.floor(random() * 4)
				const base = dish({
					item: `dish${Math.floor(random() * 8)}`,
					category: `cat${category}`,
					menu: `menu${menu}`,
					menuId: `m${menu}`,
					quantity: 1 + Math.floor(random() * 5),
					salesMinor: Math.floor(random() * 5000),
				})
				generated.push(base)
				if (random() < 0.4) {
					generated.push(
						option({
							...base,
							optionGroup: `g${Math.floor(random() * 2)}`,
							option: `o${Math.floor(random() * 3)}`,
							quantity: 1 + Math.floor(random() * 3),
							salesMinor: Math.floor(random() * 300),
						}),
					)
				}
			}
			const expected = generated
				.filter((row) => row.kind === 'dish')
				.reduce((sum, row) => sum + row.salesMinor, 0)
			const mask = Math.floor(random() * 32)
			const levels: ProductMixLevel[] = PRODUCT_MIX_LEVELS.filter(
				(_, bit) => mask & (1 << bit),
			)
			const tree = buildProductMixTree(generated, levels, 'USD')
			expect(tree.total.salesMinor).toBe(expected)
		}
	})

	it('keeps one tree per currency and never mixes them', () => {
		const mixed = [
			...rows,
			dish({ item: 'Kebab', category: 'Mains', currency: 'SAR', salesMinor: 3000 }),
		]
		expect(productMixCurrencies(mixed)).toEqual(['USD', 'SAR'])
		expect(buildProductMixTree(mixed, ['category'], 'SAR').total.salesMinor).toBe(3000)
		expect(buildProductMixTree(mixed, ['category'], 'USD').total.salesMinor).toBe(TOTAL)
	})

	it('exports one level or every row, with a guarded cell for formula-like names', () => {
		const tree = buildProductMixTree(
			[...rows, dish({ item: 'Odd', category: '=cmd', salesMinor: 100 })],
			['category', 'dish'],
			'USD',
		)
		const onlyCategories = productMixCsv(tree, 'category').split('\n')
		// Header, four categories (one is Earlier sales) and the total.
		expect(onlyCategories.length).toBe(1 + 4 + 1)
		const all = productMixCsv(tree).split('\n')
		expect(all.length).toBeGreaterThan(onlyCategories.length)
		expect(all.join('\n')).toContain("'=cmd")
		expect(productMixCsv(tree, undefined, false).split('\n')[0]).not.toContain('Share')
	})
})
