import { describe, expect, it } from 'vitest'
import { diffMenuSnapshots } from './snapshot-diff.ts'
import { MENU_SNAPSHOT_VERSION, type MenuSnapshotContent } from './snapshot-types.ts'

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
				isGlutenFree: false,
				isVegetarian: false,
				allergens: '[]',
				calorieMin: null,
				calorieMax: null,
				applySalesTax: true,
				excludeFromOverride: false,
				excludeFromDiscounts: false,
				isPopular: false,
				isUpsell: false,
				availabilityStatus: 'available',
				unavailableUntil: null,
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
})
