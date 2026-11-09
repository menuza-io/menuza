import {
	PICKABLE_WASTE_REASONS,
	type StationCatalog,
	type StationCountSummary,
} from '@repo/inventory'
import { type StockApi } from './api.ts'

/**
 * Demo mode's Stock: a sample kitchen and a count that live in this tab, like
 * the Kitchen demo. It answers every call itself, so nothing leaves the
 * tablet and no pairing or connection is needed.
 */

const DEMO_LOCATION = 'demo'
const NOW = () => Date.now()

function demoCatalog(
	locationId: string,
	counts: StationCountSummary[],
): StationCatalog {
	return {
		contractVersion: 1,
		version: 'demo-catalog-v1',
		generatedAt: NOW(),
		locationId,
		settings: {
			receiveRequiresManager: false,
			photoMaxBytes: 5 * 1024 * 1024,
			ordersEnabled: true,
		},
		items: [
			{
				id: 'demo_tomato',
				name: 'Tomatoes',
				category: 'produce',
				kind: 'bought',
				baseUnit: 'g',
				countUnit: 'kg',
				units: [],
				areaIds: ['demo_walkin'],
			},
			{
				id: 'demo_chicken',
				name: 'Chicken thigh',
				category: 'meat',
				kind: 'bought',
				baseUnit: 'g',
				countUnit: 'kg',
				units: [
					{
						id: 'demo_box',
						name: 'Box',
						baseQuantity: 10_000_000,
						used: false,
						archived: false,
					},
				],
				areaIds: ['demo_walkin'],
			},
			{
				id: 'demo_oil',
				name: 'Olive oil',
				category: 'dry_goods',
				kind: 'bought',
				baseUnit: 'ml',
				countUnit: 'l',
				units: [],
				areaIds: ['demo_dry'],
			},
			{
				id: 'demo_pita',
				name: 'Pita bread',
				category: 'bakery',
				kind: 'bought',
				baseUnit: 'piece',
				countUnit: 'piece',
				units: [],
				areaIds: ['demo_dry'],
			},
			{
				id: 'demo_lemon',
				name: 'Lemons',
				category: 'produce',
				kind: 'bought',
				baseUnit: 'piece',
				countUnit: 'piece',
				units: [],
				areaIds: [],
			},
		],
		areas: [
			{
				id: 'demo_walkin',
				name: 'Walk-in fridge',
				sortOrder: 1,
				itemIds: ['demo_chicken', 'demo_tomato'],
			},
			{
				id: 'demo_dry',
				name: 'Dry store',
				sortOrder: 2,
				itemIds: ['demo_pita', 'demo_oil'],
			},
		],
		countLists: [
			{
				id: 'demo_weekly',
				name: 'Weekly count',
				itemIds: [
					'demo_tomato',
					'demo_chicken',
					'demo_oil',
					'demo_pita',
					'demo_lemon',
				],
			},
		],
		counts,
		wasteReasons: [...PICKABLE_WASTE_REASONS],
		recentWasteItemIds: ['demo_tomato', 'demo_pita'],
		suppliers: [
			{
				id: 'demo_supplier',
				name: 'Fresh Produce Co',
				products: [
					{
						id: 'demo_sp_tomato',
						itemId: 'demo_tomato',
						packName: 'Crate 6 kg',
						packBaseQuantity: 6_000_000,
						pricedByWeight: false,
					},
					{
						id: 'demo_sp_chicken',
						itemId: 'demo_chicken',
						packName: 'Box',
						packBaseQuantity: 10_000_000,
						pricedByWeight: true,
					},
				],
			},
		],
		expectedDeliveries: [
			{
				orderId: 'demo_order',
				number: 12,
				supplierId: 'demo_supplier',
				supplierName: 'Fresh Produce Co',
				status: 'sent',
				expectedDate: null,
				lines: [
					{
						orderLineId: 'demo_ol_1',
						itemId: 'demo_tomato',
						itemName: 'Tomatoes',
						baseUnit: 'g',
						countUnit: 'kg',
						supplierProductId: 'demo_sp_tomato',
						packName: 'Crate 6 kg',
						packBaseQuantity: 6_000_000,
						pricedByWeight: false,
						orderedPacks: 3,
						orderedQuantity: 18_000_000,
						receivedQuantity: 0,
						outstandingQuantity: 18_000_000,
						outstandingPacks: 3,
					},
					{
						orderLineId: 'demo_ol_2',
						itemId: 'demo_chicken',
						itemName: 'Chicken thigh',
						baseUnit: 'g',
						countUnit: 'kg',
						supplierProductId: 'demo_sp_chicken',
						packName: 'Box',
						packBaseQuantity: 10_000_000,
						pricedByWeight: true,
						orderedPacks: 2,
						orderedQuantity: 20_000_000,
						receivedQuantity: 0,
						outstandingQuantity: 20_000_000,
						outstandingPacks: 2,
					},
				],
			},
		],
	}
}

/** A fresh in-memory region. Each call is independent (tests make their own). */
export function createDemoStockApi(): StockApi {
	const counts = new Map<string, StationCountSummary>()
	const counted = new Map<string, Set<string>>()
	let serial = 0
	const summary = (
		id: string,
		listId: string | null,
		listName: string | null,
	): StationCountSummary => ({
		id,
		locationId: DEMO_LOCATION,
		listId,
		listName,
		status: 'counting',
		businessDate: new Date().toISOString().slice(0, 10),
		startedBy: { kind: 'staff', id: 'demo-staff' },
		itemTotal: 5,
		itemsCounted: 0,
		counters: [],
		sentForReviewAt: null,
		approvedAt: null,
		approvedBy: null,
		cancelledAt: null,
		createdAt: NOW(),
		version: 1,
	})
	const open = () =>
		[...counts.values()].filter((count) => count.status === 'counting')
	return {
		async catalog(locationId) {
			return {
				status: 'ok',
				catalog: demoCatalog(locationId, open()),
			}
		},
		async startCount(body) {
			const existing = open().find((count) => count.listId === body.listId)
			if (existing) return { count: existing, joined: true }
			const count = summary(
				`demo-count-${++serial}`,
				body.listId,
				body.listId ? 'Weekly count' : null,
			)
			counts.set(count.id, count)
			return { count, joined: false }
		},
		async countSheet(id) {
			const count = counts.get(id)
			if (!count) throw new Error('not_found')
			return { count, areas: [] }
		},
		async countEntries(id, body) {
			const count = counts.get(id)
			const accepted = body.entries.map((entry) => ({
				clientId: entry.clientId,
				quantity: null,
			}))
			if (count) {
				const items = counted.get(id) ?? new Set<string>()
				for (const entry of body.entries)
					if (entry.amount !== null) items.add(entry.itemId)
				counted.set(id, items)
				counts.set(id, { ...count, itemsCounted: items.size })
			}
			return { accepted, duplicates: [], refused: [] }
		},
		async sendCount(id) {
			const count = counts.get(id)
			if (!count) throw new Error('not_found')
			const next: StationCountSummary = {
				...count,
				status: 'in_review',
				sentForReviewAt: NOW(),
			}
			counts.set(id, next)
			return next
		},
		async waste(body) {
			return {
				accepted: body.entries.map((entry) => ({
					clientId: entry.clientId,
					id: `demo-waste-${++serial}`,
					quantity: 1000,
				})),
				duplicates: [],
				refused: [],
				lateSync: [],
			}
		},
		async dishWaste(body) {
			// The demo has no recipes: nothing is taken out, nothing is sent.
			return { logged: 0, withoutRecipe: body.lines.length, duplicate: false }
		},
		async undoWaste() {
			return { id: `demo-undo-${++serial}` }
		},
		async delivery(body) {
			return {
				id: `demo-delivery-${++serial}`,
				lineCount: body.lines.length,
				receivedAt: NOW(),
				pricesPending: true,
				lateSync: false,
				duplicate: false,
				order: null,
				orderLinkIgnored: null,
			}
		},
		async photoRequest(_id, body) {
			return {
				key: 'demo/invoice',
				method: 'PUT',
				uploadUrl: 'demo://invoice',
				headers: { 'Content-Type': body.contentType },
				expiresAt: NOW() + 300_000,
				maxBytes: 5 * 1024 * 1024,
			}
		},
		async putPhoto() {},
		async photoConfirm() {},
	}
}

let shared: StockApi | null = null
/** One demo region for the tab, so a count started in Stock is still there when Kitchen opens. */
export function demoStockApi(): StockApi {
	shared ??= createDemoStockApi()
	return shared
}
