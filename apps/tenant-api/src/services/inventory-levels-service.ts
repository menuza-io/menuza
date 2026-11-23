import {
	parseUnitRef,
	suggestLevelsFromHistory,
	thousandthsPerUnit,
	type LevelRow,
	type LevelSuggestions,
} from '@repo/inventory'
import { daysBetween } from '@repo/reservations'
import { invItemPlaces, invItems, invMovements } from '@repo/tenant-db'
import { and, eq, sql } from 'drizzle-orm'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryIdempotency,
	type InventoryReader,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	decodeOffsetCursor,
	defaultCountUnit,
	locationClock,
	wireUnit,
} from './inventory-common.ts'
import {
	type LevelSuggestionsQuery,
	type ListLevelsQuery,
	type PutLevelsInput,
} from './inventory-contract-types.ts'
import { loadUseHistory } from './inventory-days-left.ts'
import {
	type InventoryCaller,
	itemStatus,
	loadLocationStock,
	toItemUnit,
} from './inventory-items-service.ts'
import {
	chooseSupplierProduct,
	loadProductChoices,
	supplierSchedule,
} from './inventory-orders-service.ts'
import { getInventorySettings } from './inventory-settings-service.ts'

/**
 * Levels ("order more when below", "fill up to") for every item at one
 * location, in one table, and suggestions from what was used. Quantities
 * only: no money anywhere in this file.
 */

export async function listLevels(
	db: InventoryReader,
	input: { query: ListLevelsQuery },
) {
	const { query } = input
	const [rows, choices] = await Promise.all([
		loadLocationStock(db, query.locationId),
		loadProductChoices(db),
	])
	const needle = query.q?.toLowerCase()
	const filtered = rows
		.filter((row) => {
			if (needle && !row.item.name.toLowerCase().includes(needle)) return false
			if (query.category && row.item.category !== query.category) return false
			if (query.supplierId) {
				const sold = choices.get(row.item.id) ?? []
				if (!sold.some((entry) => entry.supplier.id === query.supplierId)) {
					return false
				}
			}
			const set =
				row.place !== null &&
				(row.place.orderBelowQuantity !== null ||
					row.place.fillUpToQuantity !== null)
			if (query.filter === 'set') return set
			if (query.filter === 'unset') return !set
			return true
		})
		.sort(
			(a, b) =>
				a.item.name.toLowerCase().localeCompare(b.item.name.toLowerCase()) ||
				(a.item.id < b.item.id ? -1 : 1),
		)
	const offset = decodeOffsetCursor(query.cursor)
	const page = filtered.slice(offset, offset + query.limit)
	const next = offset + query.limit
	const levels = page.map((row): LevelRow => {
		const choice = chooseSupplierProduct(choices.get(row.item.id) ?? [])
		return {
			itemId: row.item.id,
			name: row.item.name,
			category: row.item.category,
			baseUnit: row.item.baseUnit,
			countUnit: row.place?.countUnit ? wireUnit(row.place.countUnit) : null,
			units: row.units.map(toItemUnit),
			onHand: row.onHand,
			orderBelowQuantity: row.place?.orderBelowQuantity ?? null,
			fillUpToQuantity: row.place?.fillUpToQuantity ?? null,
			placeVersion: row.place?.version ?? 0,
			status: itemStatus(row.onHand, row.place),
			supplierId: choice?.supplier.id ?? null,
			supplierName: choice?.supplier.name ?? null,
			packName: choice?.product.packName ?? null,
			packBaseQuantity: choice?.product.packBaseQuantity ?? null,
		}
	})
	return {
		levels,
		total: filtered.length,
		nextCursor: next < filtered.length ? String(next) : null,
	}
}

/**
 * Sets levels for up to 200 items at one location. Rows are independent: one
 * that cannot be applied (`stale_version`, `not_found`) is reported in
 * `refused` and the others are saved. `placeVersion` 0 creates the place row
 * with the item's default count unit.
 */
export async function putLevels(
	caller: InventoryCaller,
	input: { body: PutLevelsInput; idempotency: InventoryIdempotency },
) {
	const { body } = input
	assertLocationAllowed(caller.locationIds, body.locationId)
	const itemIds = body.levels.map((row) => row.itemId)
	if (new Set(itemIds).size !== itemIds.length) {
		throw new InventoryError('invalid_request', 400, {
			reason: 'duplicate_item',
		})
	}
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			const settings = await getInventorySettings(tx, caller.region)
			const [items, places] = await Promise.all([
				tx.select().from(invItems),
				tx
					.select()
					.from(invItemPlaces)
					.where(eq(invItemPlaces.locationId, body.locationId)),
			])
			const itemById = new Map(items.map((item) => [item.id, item]))
			const placeById = new Map(places.map((place) => [place.itemId, place]))
			const updated: Array<{
				itemId: string
				version: number
				orderBelowQuantity: number | null
				fillUpToQuantity: number | null
			}> = []
			const refused: Array<{ itemId: string; code: string }> = []
			for (const row of body.levels) {
				const item = itemById.get(row.itemId)
				if (!item || item.archivedAt !== null) {
					refused.push({ itemId: row.itemId, code: 'not_found' })
					continue
				}
				const place = placeById.get(row.itemId)
				if ((place?.version ?? 0) !== row.expectedVersion) {
					refused.push({ itemId: row.itemId, code: 'stale_version' })
					continue
				}
				const version = (place?.version ?? 0) + 1
				if (place) {
					await tx
						.update(invItemPlaces)
						.set({
							orderBelowQuantity: row.orderBelowQuantity,
							fillUpToQuantity: row.fillUpToQuantity,
							version,
							updatedAt: ctx.now,
						})
						.where(
							and(
								eq(invItemPlaces.itemId, row.itemId),
								eq(invItemPlaces.locationId, body.locationId),
							),
						)
				} else {
					await tx.insert(invItemPlaces).values({
						itemId: row.itemId,
						locationId: body.locationId,
						countUnit: defaultCountUnit(item.baseUnit, settings.unitSystem),
						orderBelowQuantity: row.orderBelowQuantity,
						fillUpToQuantity: row.fillUpToQuantity,
						version,
						createdAt: ctx.now,
						updatedAt: ctx.now,
					})
				}
				updated.push({
					itemId: row.itemId,
					version,
					orderBelowQuantity: row.orderBelowQuantity,
					fillUpToQuantity: row.fillUpToQuantity,
				})
			}
			if (updated.length > 0) {
				await recordInventoryAudit(tx, {
					actorKind: caller.actor.kind,
					actorId: caller.actor.id,
					action: 'levels.bulk',
					resourceType: 'levels',
					resourceId: body.locationId,
					locationId: body.locationId,
					detail: { updated: updated.length, refused: refused.length },
					at: ctx.now,
				})
			}
			return { updated, refused }
		},
	)
}

/** The span a count unit measures: a standard unit's size, or a named unit's base quantity. */
function roundingFor(
	countUnit: string | null,
	units: ReadonlyArray<{ id: string; baseQuantity: number }>,
	baseUnit: 'g' | 'ml' | 'piece',
): number {
	if (!countUnit) return 1000
	const parsed = parseUnitRef(wireUnit(countUnit))
	try {
		if (parsed.kind === 'standard') {
			return Math.max(
				1,
				Math.round(
					thousandthsPerUnit({ kind: 'standard', unit: parsed.unit }, baseUnit),
				),
			)
		}
		const named = units.find((unit) => unit.id === parsed.id)
		return named ? Math.max(1, named.baseQuantity) : 1000
	} catch {
		return 1000
	}
}

/**
 * Suggests "order more when below" and "fill up to" from the last 28 days of
 * usage (`loadUseHistory`) and the chosen supplier's delivery schedule & pack
 * size (falling back to a 7-day cycle and count-unit rounding when unsourced).
 * Suggestions are never applied here.
 */
export async function suggestLevels(
	db: InventoryReader,
	input: { query: LevelSuggestionsQuery; now: number },
): Promise<LevelSuggestions> {
	const { query } = input
	const clock = await locationClock(db, query.locationId, input.now)
	const today = clock.local.date
	const [first, historyByItem, stock, choices] = await Promise.all([
		db
			.select({ at: sql<string | null>`min(${invMovements.businessDate})` })
			.from(invMovements)
			.where(eq(invMovements.locationId, query.locationId))
			.get(),
		loadUseHistory(db, query.locationId, today),
		loadLocationStock(db, query.locationId),
		loadProductChoices(db),
	])
	const daysObserved = first?.at
		? Math.max(1, Math.min(query.days, daysBetween(first.at, today) + 1))
		: 0
	const suggestions: LevelSuggestions['suggestions'] = []
	for (const entry of stock) {
		if (entry.item.archivedAt !== null) continue
		const history = historyByItem.get(entry.item.id) ?? []
		if (history.length === 0) continue
		const choice = chooseSupplierProduct(choices.get(entry.item.id) ?? [])
		const roundTo = choice
			? choice.product.packBaseQuantity
			: roundingFor(
					entry.place?.countUnit ?? null,
					entry.units,
					entry.item.baseUnit,
				)
		const result = suggestLevelsFromHistory({
			now: clock.local,
			history,
			schedule: choice ? supplierSchedule(choice.supplier) : null,
			roundTo,
		})
		const supplierName = choice?.supplier.name ?? null
		const packName = choice?.product.packName ?? null
		const packBaseQuantity = choice?.product.packBaseQuantity ?? null
		if (result.state === 'not_enough_history') {
			suggestions.push({
				itemId: entry.item.id,
				state: 'not_enough_history',
				useDays: result.useDays,
				usedQuantity: result.usedQuantity,
				dailyUseQuantity: 0,
				weeklyUseQuantity: 0,
				orderBelowQuantity: 0,
				fillUpToQuantity: 0,
				deliveryDays: [],
				cycleDays: null,
				supplierName,
				packName,
				packBaseQuantity,
			})
			continue
		}
		suggestions.push({
			itemId: entry.item.id,
			state: 'ok',
			useDays: result.useDays,
			usedQuantity: result.usedQuantity,
			dailyUseQuantity: result.dailyUseQuantity,
			weeklyUseQuantity: result.weeklyUseQuantity,
			orderBelowQuantity: result.orderBelowQuantity,
			fillUpToQuantity: result.fillUpToQuantity,
			deliveryDays: result.deliveryDays,
			cycleDays: result.cycleDays,
			supplierName,
			packName,
			packBaseQuantity,
		})
	}
	suggestions.sort((a, b) => (a.itemId < b.itemId ? -1 : 1))
	return {
		locationId: query.locationId,
		days: query.days,
		daysObserved,
		suggestions,
	}
}
