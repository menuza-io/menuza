import {
	foldInventoryFeatures,
	INVENTORY_FEATURES_OFF,
	INVENTORY_PERMISSIONS as P,
} from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	computeInventoryNavAccess,
	HIDDEN_INVENTORY_NAV,
	inventoryTabFromPath,
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
			today: true,
			stock: true,
			counts: true,
			purchasing: true,
			waste: true,
		})
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
