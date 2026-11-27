import { describe, expect, it } from 'vitest'
import { diffMenuSnapshots } from './snapshot-diff.ts'
import {
	MENU_SNAPSHOT_VERSION,
	type MenuSnapshotContent,
} from './snapshot-types.ts'

const emptySnapshot = (): MenuSnapshotContent => ({
	version: MENU_SNAPSHOT_VERSION,
	menus: [],
	categories: [],
	menuCategoryAssignments: [],
	items: [],
	itemCategoryAssignments: [],
	modifierGroups: [],
	itemModifierGroupAssignments: [],
	options: [],
	modifierGroupOptionAssignments: [],
	optionNestedModifierGroupAssignments: [],
	locationOverrides: [],
	posLinks: [],
})

describe('diffMenuSnapshots', () => {
	it('reports added, removed, and changed items', () => {
		const left = emptySnapshot()
		left.items = [
			{
				id: 'item1',
				organizationId: 'org1',
				displayName: 'Burger',
				internalName: null,
				description: null,
				price: 10,
				imageKey: null,
				imageUrl: null,
				imageKeys: '[]',
				variations: '{"groups":[],"variants":[]}',
				isAlcohol: false,
				dietaryTags: '[]',
				orderTypePrices: null,
				isGlutenFree: false,
				isVegetarian: false,
				allergens: '[]',
				calorieMin: null,
				calorieMax: null,
				applySalesTax: true,
				excludeFromOverride: false,
				excludeFromDiscounts: false,
				excludeFromOrderLimits: false,
				dailySaleLimit: null,
				kitchenName: null,
				kitchenHighlight: null,
				isPopular: false,
				popularMode: 'auto',
				isUpsell: false,
				sitePageEnabled: false,
				siteSlug: null,
				availabilityStatus: 'available',
				unavailableUntil: null,
				channels: '["web","qr","pos","app"]',
				barcode: null,
				position: 0,
				createdAt: new Date('2025-01-01'),
				updatedAt: new Date('2025-01-01'),
			},
		]
		const right = emptySnapshot()
		right.items = [
			{
				...left.items[0]!,
				price: 12,
			},
			{
				...left.items[0]!,
				id: 'item2',
				displayName: 'Fries',
			},
		]

		const diff = diffMenuSnapshots(left, right)
		expect(diff.changed.some((row) => row.id === 'item1')).toBe(true)
		expect(diff.added.some((row) => row.id === 'item2')).toBe(true)
		expect(diff.removed).toHaveLength(0)
	})

	it('records channel changes on menu, category, and item (#220)', () => {
		const left = emptySnapshot()
		left.menus = [
			{
				id: 'menu1',
				organizationId: 'org1',
				displayName: 'Dinner',
				internalName: null,
				menuType: 'online_pos_kiosk',
				nutritionalInfo: true,
				calorieDisplay: null,
				specialInstructions: true,
				availabilityHours: null,
				availabilityStatus: 'available',
				unavailableUntil: null,
				channels: '["web","qr","pos","app"]',
				position: 0,
				createdAt: new Date('2025-01-01'),
				updatedAt: new Date('2025-01-01'),
			},
		]
		left.categories = [
			{
				id: 'cat1',
				organizationId: 'org1',
				displayName: 'Mains',
				internalName: null,
				description: null,
				defaultCourseId: null,
				channels: '["web","qr","pos","app"]',
				parentId: null,
				upsellCategoryIds: '[]',
				availabilityHours: null,
				availabilityStatus: 'available',
				unavailableUntil: null,
				excludeFromOverride: false,
				excludeFromOrderLimits: false,
				position: 0,
				createdAt: new Date('2025-01-01'),
				updatedAt: new Date('2025-01-01'),
			},
		]
		left.items = [
			{
				id: 'item1',
				organizationId: 'org1',
				displayName: 'Steak',
				internalName: null,
				description: null,
				price: 20,
				imageKey: null,
				imageUrl: null,
				imageKeys: '[]',
				variations: '{"groups":[],"variants":[]}',
				isAlcohol: false,
				dietaryTags: '[]',
				orderTypePrices: null,
				isGlutenFree: false,
				isVegetarian: false,
				allergens: '[]',
				calorieMin: null,
				calorieMax: null,
				applySalesTax: true,
				excludeFromOverride: false,
				excludeFromDiscounts: false,
				excludeFromOrderLimits: false,
				dailySaleLimit: null,
				kitchenName: null,
				kitchenHighlight: null,
				isPopular: false,
				popularMode: 'auto',
				isUpsell: false,
				sitePageEnabled: false,
				siteSlug: null,
				availabilityStatus: 'available',
				unavailableUntil: null,
				channels: '["web","qr","pos","app"]',
				barcode: null,
				position: 0,
				createdAt: new Date('2025-01-01'),
				updatedAt: new Date('2025-01-01'),
			},
		]

		const right = emptySnapshot()
		right.menus = [{ ...left.menus[0]!, channels: '["web","pos"]' }]
		right.categories = [{ ...left.categories[0]!, channels: '["qr","pos"]' }]
		right.items = [{ ...left.items[0]!, channels: '["pos"]' }]

		const diff = diffMenuSnapshots(left, right)
		expect(diff.changed).toHaveLength(3)
		expect(diff.changed.find((r) => r.id === 'menu1')?.changes).toEqual([
			{
				field: 'channels',
				before: '["web","qr","pos","app"]',
				after: '["web","pos"]',
			},
		])
		expect(diff.changed.find((r) => r.id === 'cat1')?.changes).toEqual([
			{
				field: 'channels',
				before: '["web","qr","pos","app"]',
				after: '["qr","pos"]',
			},
		])
		expect(diff.changed.find((r) => r.id === 'item1')?.changes).toEqual([
			{
				field: 'channels',
				before: '["web","qr","pos","app"]',
				after: '["pos"]',
			},
		])
	})
})
