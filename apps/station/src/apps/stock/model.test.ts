import { describe, expect, it } from 'vitest'
import {
	convertAmount,
	countProgress,
	countTabs,
	deliveryLines,
	filterItems,
	formatAmount,
	hasShortLines,
	lineFromProduct,
	lineQuantity,
	linesFromExpected,
	mayReceive,
	recentWasteIds,
	rowKey,
	tabProgress,
	thousandthsIn,
	toBaseThousandths,
	undoRemainingMs,
	unitChoices,
	unitStep,
	unitTakesFractions,
} from './model.ts'
import { fitSize } from './photo.ts'
import { catalog } from './testing.ts'

const item = (id: string) => catalog.items.find((entry) => entry.id === id)!

describe('units', () => {
	it('knows how many base thousandths a unit holds for an item', () => {
		expect(thousandthsIn('kg', 'g')).toBe(1_000_000)
		expect(thousandthsIn('l', 'ml')).toBe(1_000_000)
		expect(thousandthsIn('piece', 'piece')).toBe(1000)
		expect(thousandthsIn('kg', 'ml')).toBeNull()
		expect(thousandthsIn('unit:box10', 'g', item('item_chicken').units)).toBe(
			10_000_000,
		)
		expect(thousandthsIn('unit:gone', 'g', [])).toBeNull()
	})

	it('offers the counting unit first, then named units, then the standard ones that fit', () => {
		const choices = unitChoices(item('item_chicken'))
		expect(choices.slice(0, 2)).toEqual(['kg', 'unit:box10'])
		expect(choices).toEqual(expect.arrayContaining(['g', 'oz', 'lb']))
		expect(choices).not.toContain('ml')
		expect(unitChoices(item('item_pita'))[0]).toBe('piece')
		// An archived named unit is not offered.
		expect(
			unitChoices({
				...item('item_chicken'),
				units: [{ ...item('item_chicken').units[0]!, archived: true }],
			}),
		).not.toContain('unit:box10')
	})

	it('steps by tens of grams and millilitres, otherwise by one, and offers ¼ ½ ¾ except for the smallest units', () => {
		expect(unitStep('g')).toBe(100)
		expect(unitStep('ml')).toBe(100)
		expect(unitStep('kg')).toBe(1)
		expect(unitStep('unit:box10')).toBe(1)
		expect(unitTakesFractions('g')).toBe(false)
		expect(unitTakesFractions('kg')).toBe(true)
		expect(unitTakesFractions('piece')).toBe(true)
	})

	it('converts what was typed to the stored quantity, and between units without losing it', () => {
		expect(toBaseThousandths(2.5, 'kg', item('item_tomato'))).toBe(2_500_000)
		expect(toBaseThousandths(1, 'unit:box10', item('item_chicken'))).toBe(
			10_000_000,
		)
		expect(toBaseThousandths(1, 'ml', item('item_tomato'))).toBeNull()
		expect(convertAmount(1.5, 'kg', 'g', item('item_tomato'))).toBe(1500)
		expect(convertAmount(1500, 'g', 'kg', item('item_tomato'))).toBe(1.5)
		expect(convertAmount(2, 'unit:box10', 'kg', item('item_chicken'))).toBe(20)
		expect(convertAmount(1, 'kg', 'l', item('item_tomato'))).toBeNull()
	})

	it('writes amounts in the person’s language', () => {
		expect(formatAmount(2.5, 'en')).toBe('2.5')
		expect(formatAmount(1234.5, 'en')).toBe('1,234.5')
		expect(formatAmount(2.5, 'not a locale!!')).toBe('2.5')
	})
})

describe('the counting sheet', () => {
	it('lists areas in walking order, items in shelf order, and no-area items last', () => {
		const tabs = countTabs(catalog, null)
		expect(tabs.map((tab) => [tab.key, tab.itemIds])).toEqual([
			['area_walkin', ['item_chicken', 'item_tomato', 'item_garlic_sauce']],
			['area_dry', ['item_pita', 'item_oil']],
			['none', ['item_lemon']],
		])
		expect(tabs[2]).toMatchObject({ areaId: null, name: null })
	})

	it('limits a list to its items and leaves out empty areas', () => {
		const tabs = countTabs(catalog, new Set(['item_oil', 'item_lemon']))
		expect(tabs.map((tab) => [tab.key, tab.itemIds])).toEqual([
			['area_dry', ['item_oil']],
			['none', ['item_lemon']],
		])
		expect(countTabs(catalog, new Set(['nothing-here']))).toEqual([])
	})

	it('puts an item in two areas on both tabs, each counted on its own', () => {
		const twice = {
			...catalog,
			areas: [
				...catalog.areas,
				{ id: 'area_bar', name: 'Bar', sortOrder: 3, itemIds: ['item_oil'] },
			],
		}
		const tabs = countTabs(twice, null)
		expect(tabs.filter((tab) => tab.itemIds.includes('item_oil'))).toHaveLength(
			2,
		)
		expect(rowKey('item_oil', 'area_dry')).not.toBe(
			rowKey('item_oil', 'area_bar'),
		)
	})

	it('counts "32 of 48" by item, not by row, and never mistakes blank for counted', () => {
		const tabs = countTabs(catalog, null)
		const none = countProgress(tabs, {})
		expect(none).toEqual({ counted: 0, total: 6 })
		const values = {
			[rowKey('item_tomato', 'area_walkin')]: {
				amount: 2,
				unit: 'kg' as const,
			},
			[rowKey('item_oil', 'area_dry')]: { amount: null, unit: 'l' as const },
			[rowKey('item_lemon', null)]: { amount: 0, unit: 'piece' as const },
		}
		expect(countProgress(tabs, values)).toEqual({ counted: 2, total: 6 })
		// Someone else counted the chicken: it counts, without a number.
		expect(countProgress(tabs, values, new Set(['item_chicken']))).toEqual({
			counted: 3,
			total: 6,
		})
		// What this person cleared is blank again, whoever else counted it.
		expect(countProgress(tabs, values, new Set(['item_oil']))).toEqual({
			counted: 2,
			total: 6,
		})
		expect(tabProgress(tabs[0]!, values)).toEqual({ counted: 1, total: 3 })
	})
})

describe('waste', () => {
	it('offers recent items first (this tablet’s, then the region’s), only ones that exist, once each', () => {
		expect(recentWasteIds(catalog, ['item_lemon', 'item_gone'])).toEqual([
			'item_lemon',
			'item_tomato',
			'item_pita',
		])
		expect(recentWasteIds(catalog, [], 1)).toEqual(['item_tomato'])
	})

	it('finds items by name, ignoring case and accents', () => {
		const names = [{ name: 'Crème fraîche' }, { name: 'Tomatoes' }]
		expect(filterItems(names, 'creme')).toEqual([names[0]])
		expect(filterItems(names, ' TOMA ')).toEqual([names[1]])
		expect(filterItems(names, '')).toEqual(names)
	})

	it('undo lasts a minute from when it was logged', () => {
		expect(undoRemainingMs(1_000, 1_000)).toBe(60_000)
		expect(undoRemainingMs(1_000, 31_000)).toBe(30_000)
		expect(undoRemainingMs(1_000, 100_000)).toBe(0)
	})
})

describe('delivery lines', () => {
	const order = catalog.expectedDeliveries[0]!

	it('starts an order’s lines ticked at what is still outstanding', () => {
		const lines = linesFromExpected(order)
		expect(lines).toMatchObject([
			{ key: 'ol_1', received: true, packs: 3, orderLineId: 'ol_1' },
			{ key: 'ol_2', received: true, packs: 2, pricedByWeight: true },
		])
		const done = linesFromExpected({
			...order,
			lines: [
				{ ...order.lines[0]!, outstandingPacks: 0, outstandingQuantity: 0 },
			],
		})
		expect(done[0]).toMatchObject({ received: false, packs: null })
	})

	it('works the stored quantity out from packs, or from the weight on the scale', () => {
		const [tomatoes, chicken] = linesFromExpected(order)
		expect(lineQuantity({ ...tomatoes!, packs: 2 })).toEqual({
			quantity: 12_000_000,
			realWeightQuantity: null,
		})
		// A pack that arrives half full.
		expect(lineQuantity({ ...tomatoes!, packs: 2.5 })?.quantity).toBe(
			15_000_000,
		)
		// Priced by weight: the scale decides, in the unit it shows.
		expect(
			lineQuantity({ ...chicken!, weight: 18.4, weightUnit: 'kg' }),
		).toEqual({
			quantity: 18_400_000,
			realWeightQuantity: 18_400_000,
		})
		expect(
			lineQuantity({ ...chicken!, weight: 18_400, weightUnit: 'g' }),
		).toEqual({
			quantity: 18_400_000,
			realWeightQuantity: 18_400_000,
		})
		// Not weighed: the packs are the best figure there is.
		expect(lineQuantity({ ...chicken!, packs: 2, weight: null })).toEqual({
			quantity: 20_000_000,
			realWeightQuantity: null,
		})
	})

	it('leaves out lines that did not come or have nothing typed', () => {
		const lines = linesFromExpected(order)
		expect(deliveryLines(lines)).toHaveLength(2)
		expect(
			deliveryLines([
				{ ...lines[0]!, received: false },
				{ ...lines[1]!, packs: null },
			]),
		).toEqual([])
		expect(deliveryLines([{ ...lines[0]!, packs: 0 }])).toEqual([])
		expect(deliveryLines([lines[0]!])[0]).toEqual({
			itemId: 'item_tomato',
			supplierProductId: 'sp_tomato_crate',
			quantity: 18_000_000,
			packs: 3,
			packName: 'Crate 6 kg',
			packBaseQuantity: 6_000_000,
			realWeightQuantity: null,
			orderLineId: 'ol_1',
		})
	})

	it('knows when an order is short, which is when "nothing more is coming" matters', () => {
		const lines = linesFromExpected(order)
		expect(hasShortLines(lines)).toBe(false)
		expect(hasShortLines([{ ...lines[0]!, packs: 2 }, lines[1]!])).toBe(true)
		expect(hasShortLines([{ ...lines[0]!, received: false }, lines[1]!])).toBe(
			true,
		)
		// A delivery without an order is never short.
		const free = lineFromProduct(
			catalog.suppliers[0]!.products[0]!,
			item('item_tomato'),
		)
		expect(hasShortLines([free])).toBe(false)
		expect(free).toMatchObject({ packs: 1, orderLineId: null, received: true })
	})

	it('lets a manager always receive, and anyone when the location allows it', () => {
		expect(mayReceive(catalog, 'cashier')).toBe(false)
		expect(mayReceive(catalog, null)).toBe(false)
		expect(mayReceive(catalog, 'manager')).toBe(true)
		const open = {
			settings: { ...catalog.settings, receiveRequiresManager: false },
		}
		expect(mayReceive(open, 'cashier')).toBe(true)
	})
})

describe('invoice photos', () => {
	it('fits the long edge without ever enlarging', () => {
		expect(fitSize(4000, 3000)).toEqual({ width: 1600, height: 1200 })
		expect(fitSize(3000, 4000)).toEqual({ width: 1200, height: 1600 })
		expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 })
		expect(fitSize(0, 0)).toEqual({ width: 1, height: 1 })
	})
})
