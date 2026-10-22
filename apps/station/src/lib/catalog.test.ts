import { describe, expect, it } from 'vitest'
import { buildCategories, categoryItems, isSoldOut } from './catalog.ts'
import { demoCatalog } from './demo-catalog.ts'
import {
	availableOptions,
	canQuickAdd,
	validateConfig,
	defaultSelections,
	defaultVariantPicks,
} from './item-config.ts'
import { type MenuPayload } from './types.ts'

const menu = (): MenuPayload => structuredClone(demoCatalog().menu)

describe('sub-categories', () => {
	it('keeps nested categories under their parent, three levels deep', () => {
		const drinks = buildCategories(menu(), 'loc-1').find(
			(c) => c.id === 'c-drinks',
		)!
		expect(drinks.subcategories!.map((c) => c.id)).toEqual(['c-hot', 'c-cold'])
		expect(drinks.subcategories![1]!.subcategories!.map((c) => c.id)).toEqual([
			'c-juice',
			'c-soda',
		])
	})

	it('folds every descendant item into the parent, once', () => {
		const drinks = buildCategories(menu(), 'loc-1').find(
			(c) => c.id === 'c-drinks',
		)!
		const ids = categoryItems(drinks).map((i) => i.id)
		expect(ids).toEqual(
			expect.arrayContaining([
				'i-water',
				'i-latte',
				'i-cola',
				'i-oj',
				'i-lemon',
			]),
		)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it('drops a sub-category that the API also lists at the top level', () => {
		const m = menu()
		const cold = m.menus[0]!.categories.find((c) => c.id === 'c-drinks')!
			.subcategories![1]!
		m.menus[0]!.categories.push(cold)
		const top = buildCategories(m, 'loc-1').map((c) => c.id)
		expect(top).not.toContain('c-cold')
	})

	it('hides a sub-category disabled for this location, and a parent left empty', () => {
		const m = menu()
		m.locationOverrides['loc-1'] = [
			{ entityType: 'category', entityId: 'c-juice', isEnabled: false },
		]
		const drinks = buildCategories(m, 'loc-1').find((c) => c.id === 'c-drinks')!
		const cold = drinks.subcategories!.find((c) => c.id === 'c-cold')!
		expect(cold.subcategories!.map((c) => c.id)).toEqual(['c-soda'])
	})

	it('applies item overrides: disabled items vanish, prices change', () => {
		const m = menu()
		m.locationOverrides['loc-1'] = [
			{ entityType: 'item', entityId: 'i-oj', isEnabled: false },
			{ entityType: 'item', entityId: 'i-cola', price: 9 },
		]
		const items = categoryItems(
			buildCategories(m, 'loc-1').find((c) => c.id === 'c-drinks')!,
		)
		expect(items.find((i) => i.id === 'i-oj')).toBeUndefined()
		expect(items.find((i) => i.id === 'i-cola')!.price).toBe(9)
	})
})

describe('availability and overrides match what the server enforces', () => {
	const items = (m: MenuPayload) =>
		categoryItems(buildCategories(m, 'loc-1').find((c) => c.id === 'c-mains')!)
	const find = (m: MenuPayload, id: string) => items(m).find((i) => i.id === id)

	it('an item whose status is hidden is not on the till at all', () => {
		const m = menu()
		m.menus[0]!.categories.find((c) => c.id === 'c-mains')!.items.find(
			(i) => i.id === 'i-chicken',
		)!.availabilityStatus = 'hidden'
		expect(find(m, 'i-chicken')).toBeUndefined()
	})

	it('an override can hide an item, and can make one sold out', () => {
		const m = menu()
		m.locationOverrides['loc-1'] = [
			{
				entityType: 'item',
				entityId: 'i-chicken',
				availabilityStatus: 'hidden',
			},
			{
				entityType: 'item',
				entityId: 'i-salmon',
				availabilityStatus: 'unavailable',
			},
		]
		expect(find(m, 'i-chicken')).toBeUndefined()
		expect(isSoldOut(find(m, 'i-salmon')!)).toBe(true)
	})

	it('any status other than available is sold out, including "unavailable until"', () => {
		for (const status of [
			'unavailable',
			'unavailable_until',
			'unavailable_until_tomorrow',
		]) {
			const m = menu()
			m.menus[0]!.categories.find((c) => c.id === 'c-mains')!.items.find(
				(i) => i.id === 'i-chicken',
			)!.availabilityStatus = status
			expect({ status, soldOut: isSoldOut(find(m, 'i-chicken')!) }).toEqual({
				status,
				soldOut: true,
			})
		}
	})

	it('a zero or missing override price never zeroes a price (the server ignores it too)', () => {
		const m = menu()
		m.locationOverrides['loc-1'] = [
			{ entityType: 'item', entityId: 'i-salmon', price: 0 },
			{ entityType: 'item', entityId: 'i-chicken', price: null },
		]
		expect(find(m, 'i-salmon')!.price).toBe(19)
		expect(find(m, 'i-chicken')!.price).toBe(12.75)
	})

	it('modifier option overrides apply: price replaced, disabled and hidden options removed', () => {
		const m = menu()
		m.locationOverrides['loc-1'] = [
			{ entityType: 'option', entityId: 'o-cheese', price: 3 },
			{ entityType: 'option', entityId: 'o-bacon', isEnabled: false },
			{ entityType: 'option', entityId: 'o-egg', availabilityStatus: 'hidden' },
			{
				entityType: 'option',
				entityId: 'o-avo',
				availabilityStatus: 'unavailable',
			},
		]
		const burger = find(m, 'i-burger')!
		const extras = burger.modifierGroups.find((g) => g.id === 'g-extras')!
		expect(extras.options.map((o) => o.id)).toEqual(['o-cheese', 'o-avo'])
		expect(extras.options.find((o) => o.id === 'o-cheese')!.price).toBe(3)
		// Sold-out options are kept in the data but never offered.
		expect(availableOptions(extras).map((o) => o.id)).toEqual(['o-cheese'])
	})

	it('a hidden modifier group is removed, and a sold-out group is skipped rather than demanded', () => {
		const m = menu()
		m.locationOverrides['loc-1'] = [
			{
				entityType: 'modifier_group',
				entityId: 'g-extras',
				availabilityStatus: 'hidden',
			},
			{
				entityType: 'modifier_group',
				entityId: 'g-temp',
				availabilityStatus: 'unavailable',
			},
		]
		const burger = find(m, 'i-burger')!
		expect(burger.modifierGroups.map((g) => g.id)).toEqual(['g-temp'])
		// The required "how cooked" group is sold out: nothing valid can be chosen.
		expect(
			validateConfig(
				burger,
				defaultVariantPicks(burger),
				defaultSelections(burger),
			),
		).toBeNull()
	})

	it('a variant that is "unavailable until" cannot be picked', () => {
		const m = menu()
		const pizza = m.menus[0]!.categories.find(
			(c) => c.id === 'c-pizza',
		)!.items.find((i) => i.id === 'i-marg')!
		pizza.variations.variants[0]!.availabilityStatus = 'unavailable_until'
		const built = categoryItems(
			buildCategories(m, 'loc-1').find((c) => c.id === 'c-pizza')!,
		).find((i) => i.id === 'i-marg')!
		expect(isSoldOut(built)).toBe(false) // the large still sells
		expect(defaultVariantPicks(built)).toEqual({ size: 'lg' })
		pizza.variations.variants[1]!.availabilityStatus = 'unavailable'
		const all = categoryItems(
			buildCategories(m, 'loc-1').find((c) => c.id === 'c-pizza')!,
		).find((i) => i.id === 'i-marg')!
		expect(isSoldOut(all)).toBe(true)
		expect(canQuickAdd(all)).toBe(false)
	})

	it('a payload with no availability fields is treated as available', () => {
		const m = menu()
		const item = m.menus[0]!.categories.find(
			(c) => c.id === 'c-mains',
		)!.items.find((i) => i.id === 'i-chicken')!
		delete (item as { availabilityStatus?: string }).availabilityStatus
		expect(isSoldOut(find(m, 'i-chicken')!)).toBe(false)
	})
})
