import { type StockItem } from '@repo/inventory'

/** A stock item as the region lists it (quantities in base thousandths). */
export function stockItem(overrides: Partial<StockItem> = {}): StockItem {
	return {
		id: 'itm_1',
		name: 'Chicken thighs',
		category: 'meat',
		kind: 'bought',
		baseUnit: 'g',
		archived: false,
		version: 1,
		onHand: 6_000_000,
		countUnit: 'kg',
		units: [],
		areaIds: [],
		orderBelowQuantity: null,
		fillUpToQuantity: null,
		status: 'ok',
		lastCountedAt: null,
		...overrides,
	}
}
