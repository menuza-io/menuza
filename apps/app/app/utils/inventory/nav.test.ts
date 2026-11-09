import {
	foldInventoryFeatures,
	INVENTORY_FEATURES_OFF,
	INVENTORY_PERMISSIONS as P,
} from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	computeInventoryNavAccess,
	HIDDEN_INVENTORY_NAV,
	inventoryCountReviewPath,
	inventoryTabFromPath,
	isInventoryFullPage,
} from './nav.ts'

const ON = foldInventoryFeatures({ enabled: true })

describe('computeInventoryNavAccess', () => {
	it('hides everything while inventory.enabled is off, whatever the grants', () => {
		expect(
			computeInventoryNavAccess(INVENTORY_FEATURES_OFF, [
				P.READ_INVENTORY,
				P.UPDATE_INVENTORY,
			]),
		).toEqual(HIDDEN_INVENTORY_NAV)
	})

	it('hides everything without read:inventory:any', () => {
		expect(computeInventoryNavAccess(ON, [])).toEqual(HIDDEN_INVENTORY_NAV)
		// Raw grants are expected to be expanded first; an unexpanded update
		// grant alone does not open the sidebar.
		expect(computeInventoryNavAccess(ON, [P.UPDATE_INVENTORY])).toEqual(
			HIDDEN_INVENTORY_NAV,
		)
	})

	it('shows the five tabs to a reader', () => {
		expect(computeInventoryNavAccess(ON, new Set([P.READ_INVENTORY]))).toEqual({
			visible: true,
			recipes: false,
			editRecipes: false,
			seeCost: false,
			today: true,
			stock: true,
			counts: true,
			purchasing: true,
			waste: true,
		})
	})
})

describe('computeInventoryNavAccess recipes', () => {
	const WITH_RECIPES = foldInventoryFeatures({ enabled: true, recipes: true })

	it('shows recipes to a reader only while the recipes flag is on', () => {
		const grants = new Set([P.READ_INVENTORY])
		expect(computeInventoryNavAccess(ON, grants).recipes).toBe(false)
		expect(computeInventoryNavAccess(WITH_RECIPES, grants).recipes).toBe(true)
		expect(computeInventoryNavAccess(WITH_RECIPES, grants).editRecipes).toBe(
			false,
		)
	})

	it('lets only the recipe grant save, and only the cost grant type a cost', () => {
		const nav = computeInventoryNavAccess(
			WITH_RECIPES,
			new Set([P.READ_INVENTORY, P.UPDATE_INVENTORY_RECIPE]),
		)
		expect(nav.editRecipes).toBe(true)
		expect(nav.seeCost).toBe(false)
		expect(
			computeInventoryNavAccess(
				WITH_RECIPES,
				new Set([P.READ_INVENTORY, P.READ_INVENTORY_COST]),
			).seeCost,
		).toBe(true)
	})

	it('never edits recipes while the flag is off', () => {
		expect(
			computeInventoryNavAccess(
				ON,
				new Set([P.READ_INVENTORY, P.UPDATE_INVENTORY_RECIPE]),
			).editRecipes,
		).toBe(false)
	})
})

describe('inventoryTabFromPath', () => {
	it('reads the tab from the path', () => {
		expect(inventoryTabFromPath('/acme/inventory/counts', 'acme')).toBe(
			'counts',
		)
		expect(inventoryTabFromPath('/acme/inventory/stock/abc', 'acme')).toBe(
			'stock',
		)
		expect(inventoryTabFromPath('/acme/inventory', 'acme')).toBeNull()
		expect(inventoryTabFromPath('/acme/inventory/settings', 'acme')).toBeNull()
		expect(inventoryTabFromPath('/other/inventory/stock', 'acme')).toBeNull()
	})
})

describe('isInventoryFullPage', () => {
	it('takes the whole screen for counting, review and a new delivery', () => {
		for (const path of [
			'/acme/inventory/counts/c1',
			'/acme/inventory/counts/c1/review',
			'/acme/inventory/purchasing/deliveries/new',
			'/acme/inventory/purchasing/orders/o1',
		]) {
			expect([path, isInventoryFullPage(path, 'acme')]).toEqual([path, true])
		}
	})

	it('keeps the chrome on the tabs and their sheets', () => {
		for (const path of [
			'/acme/inventory/counts',
			'/acme/inventory/counts/',
			'/acme/inventory/purchasing',
			'/acme/inventory/purchasing/suppliers/new',
			'/acme/inventory/purchasing/deliveries/d1',
			'/acme/inventory/stock/new',
			'/acme/inventory',
			'/other/inventory/counts/c1',
		]) {
			expect([path, isInventoryFullPage(path, 'acme')]).toEqual([path, false])
		}
	})

	it('builds the review path', () => {
		expect(inventoryCountReviewPath('acme', 'c 1')).toBe(
			'/acme/inventory/counts/c%201/review',
		)
	})
})
