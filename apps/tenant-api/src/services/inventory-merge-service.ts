import {
	inventoryValueMinor,
	MERGE_UNDO_WINDOW_MS,
	type Blocker,
	type MergeCandidate,
	type MergeItemPreview,
	type MergeLink,
	type MergeResult,
} from '@repo/inventory'
import {
	invCountListItems,
	invDeliveries,
	invItemCosts,
	invItemPlaceAreas,
	invItemPlaces,
	invItems,
	invMerges,
	invMovements,
	invOrders,
	invPrepItems,
	invPrepLevels,
	invRecipeLines,
	invRecipes,
	invSoldOut,
	invSupplierProducts,
	invSuppliers,
} from '@repo/tenant-db'
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryReader,
	type InventoryTx,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import { itemBlockers } from './inventory-blockers.ts'
import {
	assertVersion,
	locationBusinessDate,
	newId,
	notFound,
	onHandByLocation,
} from './inventory-common.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import { supplierStats } from './inventory-purchasing-service.ts'
import { currentRow, writeVersion } from './inventory-recipes-service.ts'

/**
 * Merge duplicates (#493). The item to keep takes over the duplicate's
 * recipes, supplier products, places, levels, count lists and prep levels; its
 * stock becomes the sum (two movements, out of the duplicate and into the kept
 * item, so the ledger shows a "merged" line); the duplicate is archived with a
 * `merged_into_id` link.
 *
 * History is NOT rewritten: the ledger, waste, counts and deliveries are
 * append-only, so the duplicate keeps its rows and readers that show history
 * follow the link (the movement log of the kept item lists them too). That is
 * what keeps every original quantity as it was. An undo within 24 hours puts
 * everything back from the snapshot stored in `inv_merges`.
 *
 * Items must share a base unit (change the unit first, #494). Blocked while
 * either item is in an open count, open transfer or an order that is not
 * closed, and while either is part of an ingredient group (#495): merging is
 * for true duplicates, groups are substitutes that stay separate.
 */

type Json = Record<string, unknown>

async function loadItem(db: InventoryReader, id: string) {
	const item = await db.select().from(invItems).where(eq(invItems.id, id)).get()
	if (!item) throw notFound()
	return item
}

function activeOrThrow(item: typeof invItems.$inferSelect) {
	if (item.archivedAt !== null || item.mergedIntoId !== null) throw notFound()
}

export async function previewItemMerge(
	db: InventoryReader,
	input: {
		itemId: string
		intoItemId: string
		caller: Pick<InventoryCaller, 'recipe'>
	},
): Promise<MergeItemPreview> {
	if (input.itemId === input.intoItemId) {
		throw new InventoryError('merge_same_item', 400)
	}
	const [dup, kept] = await Promise.all([
		loadItem(db, input.itemId),
		loadItem(db, input.intoItemId),
	])
	activeOrThrow(dup)
	activeOrThrow(kept)
	const blockers: Blocker[] = [
		...(await itemBlockers(db, dup.id, { groups: true })),
		...(await itemBlockers(db, kept.id, { groups: true })),
	]
	const recipeHits = await recipeRowsUsing(db, dup.id)
	const [products, places, lists, prep, dupHand, keptHand] = await Promise.all([
		db
			.select({ id: invSupplierProducts.id })
			.from(invSupplierProducts)
			.where(eq(invSupplierProducts.itemId, dup.id)),
		db.select().from(invItemPlaces).where(eq(invItemPlaces.itemId, dup.id)),
		db
			.select()
			.from(invCountListItems)
			.where(eq(invCountListItems.itemId, dup.id)),
		db.select().from(invPrepLevels).where(eq(invPrepLevels.itemId, dup.id)),
		onHandByLocation(db, dup.id),
		onHandByLocation(db, kept.id),
	])
	const locations = [...new Set([...dupHand.keys(), ...keptHand.keys()])].sort()
	const needsRecipeGrant = recipeHits.length > 0 && input.caller.recipe !== true
	const unitMismatch = dup.baseUnit !== kept.baseUnit
	return {
		itemId: dup.id,
		itemName: dup.name,
		itemVersion: dup.version,
		intoItemId: kept.id,
		intoItemName: kept.name,
		intoItemVersion: kept.version,
		blockers,
		unitMismatch,
		moves: {
			recipes: recipeHits.length,
			supplierProducts: products.length,
			places: places.length,
			countLists: lists.length,
			prepLevels: prep.length,
		},
		onHand: locations.map((locationId) => {
			const duplicate = dupHand.get(locationId) ?? 0
			const keptQty = keptHand.get(locationId) ?? 0
			return {
				locationId,
				duplicate,
				kept: keptQty,
				after: duplicate + keptQty,
			}
		}),
		needsRecipeGrant,
		canApply: blockers.length === 0 && !unitMismatch && !needsRecipeGrant,
	}
}

/** Current recipes with a line (or a replaced ingredient) naming the item. */
async function recipeRowsUsing(db: InventoryReader, itemId: string) {
	const hits = await db
		.select({ recipeId: invRecipeLines.recipeId })
		.from(invRecipeLines)
		.innerJoin(invRecipes, eq(invRecipes.id, invRecipeLines.recipeId))
		.where(
			and(
				or(
					eq(invRecipeLines.itemId, itemId),
					eq(invRecipeLines.replacesItemId, itemId),
				),
				isNull(invRecipes.supersededAt),
			),
		)
	return [...new Set(hits.map((hit) => hit.recipeId))]
}

/** Suggestions for "Merge into...": the same name words and the same supplier product first. */
export async function mergeCandidates(
	db: InventoryReader,
	input: { itemId: string },
): Promise<{ candidates: MergeCandidate[] }> {
	const item = await loadItem(db, input.itemId)
	const [items, products] = await Promise.all([
		db
			.select()
			.from(invItems)
			.where(and(isNull(invItems.archivedAt), isNull(invItems.mergedIntoId))),
		db.select().from(invSupplierProducts),
	])
	const words = (name: string) =>
		new Set(
			name
				.toLowerCase()
				.split(/[^\p{L}\p{N}]+/u)
				.filter((word) => word.length > 1),
		)
	const mine = words(item.name)
	const myProducts = products.filter((row) => row.itemId === item.id)
	const scored = items
		.filter((other) => other.id !== item.id && other.baseUnit === item.baseUnit)
		.map((other) => {
			const reasons: MergeCandidate['reasons'] = []
			const theirs = words(other.name)
			const shared = [...mine].filter((word) => theirs.has(word)).length
			if (
				shared > 0 &&
				(shared === mine.size ||
					shared === theirs.size ||
					other.name.toLowerCase().includes(item.name.toLowerCase()) ||
					item.name.toLowerCase().includes(other.name.toLowerCase()))
			) {
				reasons.push('name')
			}
			const sameProduct = products.some(
				(row) =>
					row.itemId === other.id &&
					myProducts.some(
						(mineRow) =>
							mineRow.supplierId === row.supplierId &&
							((mineRow.sku && mineRow.sku === row.sku) ||
								mineRow.packName.toLowerCase() === row.packName.toLowerCase()),
					),
			)
			if (sameProduct) reasons.push('supplier_product')
			return { other, reasons, score: reasons.length * 100 + shared }
		})
		.sort(
			(a, b) =>
				b.score - a.score ||
				a.other.name.toLowerCase().localeCompare(b.other.name.toLowerCase()),
		)
	return {
		candidates: scored.slice(0, 50).map(({ other, reasons }) => ({
			id: other.id,
			name: other.name,
			baseUnit: other.baseUnit,
			reasons,
		})),
	}
}

type RecipeSnapshot = {
	ownerKind: string
	ownerId: string
	fromRecipeId: string
	toRecipeId: string
}

/** Rewrites current recipes so every reference to the duplicate names the kept item. */
async function moveRecipes(
	tx: InventoryTx,
	caller: InventoryCaller,
	now: number,
	dupId: string,
	keptId: string,
): Promise<RecipeSnapshot[]> {
	const ids = await recipeRowsUsing(tx, dupId)
	const snapshots: RecipeSnapshot[] = []
	for (const recipeId of ids) {
		const previous = (
			await tx.select().from(invRecipes).where(eq(invRecipes.id, recipeId))
		)[0]!
		const lines = await tx
			.select()
			.from(invRecipeLines)
			.where(eq(invRecipeLines.recipeId, recipeId))
		const out = new Map<string, typeof invRecipeLines.$inferInsert>()
		for (const line of lines.sort(
			(a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1),
		)) {
			const itemId = line.itemId === dupId ? keptId : line.itemId
			let replaces =
				line.replacesItemId === dupId ? keptId : line.replacesItemId
			let mode = line.mode
			if (replaces === itemId) {
				// An option that replaced the duplicate with the kept item: just an add.
				replaces = null
				mode = 'add'
			}
			const existing = out.get(itemId)
			if (existing) {
				// Both items were in this recipe: one line with the same raw amount.
				const raw = (q: number, bp: number) => (q * 10_000) / bp
				const total =
					raw(existing.quantity!, existing.usableBp ?? 10_000) +
					raw(line.quantity, line.usableBp)
				existing.quantity = Math.min(
					9_000_000_000,
					Math.max(
						1,
						Math.round((total * (existing.usableBp ?? 10_000)) / 10_000),
					),
				)
				continue
			}
			out.set(itemId, {
				id: newId(),
				recipeId: '',
				itemId,
				quantity: line.quantity,
				usableBp: line.usableBp,
				mode,
				replacesItemId: replaces,
				sortOrder: out.size,
			})
		}
		const written = await writeVersion(tx, {
			previous,
			owner: { ownerKind: previous.ownerKind, ownerId: previous.ownerId },
			now,
			effectiveFrom: Math.max(now, previous.effectiveFrom),
			caller,
			values: {
				makesQuantity: previous.makesQuantity,
				multiplierBp: previous.multiplierBp,
				typedCostMinor: previous.typedCostMinor,
				typedCostCurrency: previous.typedCostCurrency,
				method: previous.method,
			},
			lines: [...out.values()],
		})
		snapshots.push({
			ownerKind: previous.ownerKind,
			ownerId: previous.ownerId,
			fromRecipeId: previous.id,
			toRecipeId: written.id,
		})
	}
	return snapshots
}

export async function mergeItems(
	caller: InventoryCaller,
	input: {
		itemId: string
		body: {
			intoItemId: string
			expectedVersion: number
			intoExpectedVersion: number
		}
	},
): Promise<MergeResult> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const preview = await previewItemMerge(tx, {
			itemId: input.itemId,
			intoItemId: input.body.intoItemId,
			caller,
		})
		const dup = await loadItem(tx, input.itemId)
		const kept = await loadItem(tx, input.body.intoItemId)
		assertVersion(dup.version, input.body.expectedVersion)
		assertVersion(kept.version, input.body.intoExpectedVersion)
		if (preview.unitMismatch)
			throw new InventoryError('merge_unit_mismatch', 409)
		if (preview.needsRecipeGrant) {
			throw new InventoryError('needs_recipe_grant', 403)
		}
		if (preview.blockers.length > 0) {
			throw new InventoryError('change_blocked', 409, {
				blockers: preview.blockers,
			})
		}
		const mergeId = newId()
		const snapshot: Json = {}

		snapshot.recipes = await moveRecipes(tx, caller, ctx.now, dup.id, kept.id)

		// Supplier products follow the item (one preferred way to buy each item).
		const products = await tx
			.select()
			.from(invSupplierProducts)
			.where(eq(invSupplierProducts.itemId, dup.id))
		const keptPreferred = await tx
			.select({ id: invSupplierProducts.id })
			.from(invSupplierProducts)
			.where(
				and(
					eq(invSupplierProducts.itemId, kept.id),
					eq(invSupplierProducts.preferred, true),
					isNull(invSupplierProducts.archivedAt),
				),
			)
			.get()
		const productSnapshot: { id: string; wasPreferred: boolean }[] = []
		for (const product of products) {
			const demote = product.preferred && !!keptPreferred
			productSnapshot.push({ id: product.id, wasPreferred: product.preferred })
			await tx
				.update(invSupplierProducts)
				.set({
					itemId: kept.id,
					preferred: demote ? false : product.preferred,
					version: product.version + 1,
					updatedAt: ctx.now,
				})
				.where(eq(invSupplierProducts.id, product.id))
		}
		snapshot.supplierProducts = productSnapshot

		// Places, levels and storage areas.
		const dupPlaces = await tx
			.select()
			.from(invItemPlaces)
			.where(eq(invItemPlaces.itemId, dup.id))
		const keptPlaces = await tx
			.select()
			.from(invItemPlaces)
			.where(eq(invItemPlaces.itemId, kept.id))
		const placeSnapshot: Json[] = []
		for (const place of dupPlaces) {
			const areas = await tx
				.select()
				.from(invItemPlaceAreas)
				.where(
					and(
						eq(invItemPlaceAreas.itemId, dup.id),
						eq(invItemPlaceAreas.locationId, place.locationId),
					),
				)
			const keptPlace = keptPlaces.find(
				(row) => row.locationId === place.locationId,
			)
			if (!keptPlace) {
				await tx
					.update(invItemPlaces)
					.set({ itemId: kept.id })
					.where(
						and(
							eq(invItemPlaces.itemId, dup.id),
							eq(invItemPlaces.locationId, place.locationId),
						),
					)
				await tx
					.update(invItemPlaceAreas)
					.set({ itemId: kept.id })
					.where(
						and(
							eq(invItemPlaceAreas.itemId, dup.id),
							eq(invItemPlaceAreas.locationId, place.locationId),
						),
					)
				placeSnapshot.push({ locationId: place.locationId, moved: true })
				continue
			}
			// Both keep it here: the kept place wins, taking the duplicate's levels
			// only where it has none.
			const levels = {
				orderBelowQuantity:
					keptPlace.orderBelowQuantity ?? place.orderBelowQuantity,
				fillUpToQuantity: keptPlace.fillUpToQuantity ?? place.fillUpToQuantity,
			}
			await tx
				.update(invItemPlaces)
				.set({ ...levels, version: keptPlace.version + 1, updatedAt: ctx.now })
				.where(
					and(
						eq(invItemPlaces.itemId, kept.id),
						eq(invItemPlaces.locationId, place.locationId),
					),
				)
			await tx
				.delete(invItemPlaceAreas)
				.where(
					and(
						eq(invItemPlaceAreas.itemId, dup.id),
						eq(invItemPlaceAreas.locationId, place.locationId),
					),
				)
			await tx
				.delete(invItemPlaces)
				.where(
					and(
						eq(invItemPlaces.itemId, dup.id),
						eq(invItemPlaces.locationId, place.locationId),
					),
				)
			placeSnapshot.push({
				locationId: place.locationId,
				moved: false,
				dupPlace: place,
				areas,
				keptLevels: {
					orderBelowQuantity: keptPlace.orderBelowQuantity,
					fillUpToQuantity: keptPlace.fillUpToQuantity,
					version: keptPlace.version,
				},
			})
		}
		snapshot.places = placeSnapshot

		// Count lists.
		const dupLists = await tx
			.select()
			.from(invCountListItems)
			.where(eq(invCountListItems.itemId, dup.id))
		const keptLists = new Set(
			(
				await tx
					.select({ listId: invCountListItems.listId })
					.from(invCountListItems)
					.where(eq(invCountListItems.itemId, kept.id))
			).map((row) => row.listId),
		)
		const listSnapshot: Json[] = []
		for (const row of dupLists) {
			if (keptLists.has(row.listId)) {
				await tx
					.delete(invCountListItems)
					.where(
						and(
							eq(invCountListItems.listId, row.listId),
							eq(invCountListItems.itemId, dup.id),
						),
					)
				listSnapshot.push({
					listId: row.listId,
					sortOrder: row.sortOrder,
					dropped: true,
				})
			} else {
				await tx
					.update(invCountListItems)
					.set({ itemId: kept.id })
					.where(
						and(
							eq(invCountListItems.listId, row.listId),
							eq(invCountListItems.itemId, dup.id),
						),
					)
				listSnapshot.push({
					listId: row.listId,
					sortOrder: row.sortOrder,
					dropped: false,
				})
			}
		}
		snapshot.countLists = listSnapshot

		// Prep levels and stations.
		const dupPrep = await tx
			.select()
			.from(invPrepLevels)
			.where(eq(invPrepLevels.itemId, dup.id))
		const keptPrep = await tx
			.select()
			.from(invPrepLevels)
			.where(eq(invPrepLevels.itemId, kept.id))
		const prepSnapshot: Json[] = []
		for (const row of dupPrep) {
			const clash = keptPrep.some(
				(other) =>
					other.locationId === row.locationId && other.weekday === row.weekday,
			)
			if (clash) {
				await tx
					.delete(invPrepLevels)
					.where(
						and(
							eq(invPrepLevels.itemId, dup.id),
							eq(invPrepLevels.locationId, row.locationId),
							eq(invPrepLevels.weekday, row.weekday),
						),
					)
			} else {
				await tx
					.update(invPrepLevels)
					.set({ itemId: kept.id })
					.where(
						and(
							eq(invPrepLevels.itemId, dup.id),
							eq(invPrepLevels.locationId, row.locationId),
							eq(invPrepLevels.weekday, row.weekday),
						),
					)
			}
			prepSnapshot.push({ row, dropped: clash })
		}
		snapshot.prepLevels = prepSnapshot
		const dupStations = await tx
			.select()
			.from(invPrepItems)
			.where(eq(invPrepItems.itemId, dup.id))
		const keptStations = await tx
			.select()
			.from(invPrepItems)
			.where(eq(invPrepItems.itemId, kept.id))
		const stationSnapshot: Json[] = []
		for (const row of dupStations) {
			const clash = keptStations.some(
				(other) => other.locationId === row.locationId,
			)
			if (clash) {
				await tx
					.delete(invPrepItems)
					.where(
						and(
							eq(invPrepItems.itemId, dup.id),
							eq(invPrepItems.locationId, row.locationId),
						),
					)
			} else {
				await tx
					.update(invPrepItems)
					.set({ itemId: kept.id })
					.where(
						and(
							eq(invPrepItems.itemId, dup.id),
							eq(invPrepItems.locationId, row.locationId),
						),
					)
			}
			stationSnapshot.push({ row, dropped: clash })
		}
		snapshot.prepStations = stationSnapshot

		// Sold-out rows caused by the duplicate now name the kept item.
		const sold = await tx
			.select({ id: invSoldOut.id })
			.from(invSoldOut)
			.where(eq(invSoldOut.causeItemId, dup.id))
		if (sold.length > 0) {
			await tx
				.update(invSoldOut)
				.set({ causeItemId: kept.id })
				.where(eq(invSoldOut.causeItemId, dup.id))
		}
		snapshot.soldOut = sold.map((row) => row.id)

		// Stock: out of the duplicate, into the kept item, valued at the duplicate's cost.
		const [dupCost, keptCost] = await Promise.all([
			tx
				.select()
				.from(invItemCosts)
				.where(eq(invItemCosts.itemId, dup.id))
				.get(),
			tx
				.select()
				.from(invItemCosts)
				.where(eq(invItemCosts.itemId, kept.id))
				.get(),
		])
		const dupHand = await onHandByLocation(tx, dup.id)
		const keptHand = await onHandByLocation(tx, kept.id)
		const moved: { locationId: string; quantity: number }[] = []
		let markerLocation: string | null = null
		for (const [locationId, quantity] of [...dupHand.entries()].sort(
			([a], [b]) => (a < b ? -1 : 1),
		)) {
			markerLocation ??= locationId
			if (quantity === 0) continue
			const value =
				dupCost && dupCost.avgCostMicro !== null
					? inventoryValueMinor(quantity, dupCost.avgCostMicro)
					: null
			const businessDate = await locationBusinessDate(tx, locationId, ctx.now)
			for (const [id, sign] of [
				[dup.id, -1],
				[kept.id, 1],
			] as const) {
				await tx.insert(invMovements).values({
					id: newId(),
					locationId,
					itemId: id,
					quantity: sign * quantity,
					valueMinor: value === null ? null : sign * value,
					currency: value === null ? null : dupCost!.currency,
					kind: 'adjustment',
					reason: 'merged',
					sourceType: 'item_merge',
					sourceId: mergeId,
					eventKey: `merge:${mergeId}:${sign > 0 ? 'in' : 'out'}:${locationId}`,
					businessDate,
					actorKind: caller.actor.kind,
					actorId: caller.actor.id,
					createdAt: ctx.now,
				})
			}
			moved.push({ locationId, quantity })
		}
		if (moved.length === 0) {
			// Nothing to carry over: still leave the "merged" line on the kept item.
			const locationId = markerLocation ?? dupPlaces[0]?.locationId ?? null
			if (locationId) {
				await tx.insert(invMovements).values({
					id: newId(),
					locationId,
					itemId: kept.id,
					quantity: 0,
					kind: 'adjustment',
					reason: 'merged',
					sourceType: 'item_merge',
					sourceId: mergeId,
					eventKey: `merge:${mergeId}:in:${locationId}`,
					businessDate: await locationBusinessDate(tx, locationId, ctx.now),
					actorKind: caller.actor.kind,
					actorId: caller.actor.id,
					createdAt: ctx.now,
				})
			}
		}
		snapshot.moved = moved
		// The kept item's average cost is weighted by what each held.
		snapshot.costs = { dup: dupCost ?? null, kept: keptCost ?? null }
		const dupQty = [...dupHand.values()].reduce(
			(sum, q) => sum + Math.max(0, q),
			0,
		)
		const keptQty = [...keptHand.values()].reduce(
			(sum, q) => sum + Math.max(0, q),
			0,
		)
		if (dupCost && dupCost.avgCostMicro !== null) {
			if (!keptCost) {
				await tx.insert(invItemCosts).values({
					itemId: kept.id,
					currency: dupCost.currency,
					lastCostMicro: dupCost.lastCostMicro,
					lastPricedAt: dupCost.lastPricedAt,
					avgCostMicro: dupCost.avgCostMicro,
					updatedAt: ctx.now,
				})
			} else if (
				keptCost.avgCostMicro !== null &&
				keptCost.currency === dupCost.currency &&
				dupQty + keptQty > 0
			) {
				const avg = Math.round(
					(keptQty * keptCost.avgCostMicro + dupQty * dupCost.avgCostMicro) /
						(dupQty + keptQty),
				)
				await tx
					.update(invItemCosts)
					.set({
						avgCostMicro: avg,
						version: keptCost.version + 1,
						updatedAt: ctx.now,
					})
					.where(eq(invItemCosts.itemId, kept.id))
			} else if (keptCost.avgCostMicro === null) {
				await tx
					.update(invItemCosts)
					.set({
						avgCostMicro: dupCost.avgCostMicro,
						lastCostMicro: keptCost.lastCostMicro ?? dupCost.lastCostMicro,
						currency: dupCost.currency,
						version: keptCost.version + 1,
						updatedAt: ctx.now,
					})
					.where(eq(invItemCosts.itemId, kept.id))
			}
		}

		await tx
			.update(invItems)
			.set({
				archivedAt: ctx.now,
				mergedIntoId: kept.id,
				version: dup.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invItems.id, dup.id))
		await tx
			.update(invItems)
			.set({ version: kept.version + 1, updatedAt: ctx.now })
			.where(eq(invItems.id, kept.id))
		const undoUntil = ctx.now + MERGE_UNDO_WINDOW_MS
		await tx.insert(invMerges).values({
			id: mergeId,
			kind: 'item',
			keptId: kept.id,
			mergedId: dup.id,
			snapshot,
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			createdAt: ctx.now,
			undoUntil,
		})
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'item.merge',
			resourceType: 'item',
			resourceId: kept.id,
			detail: {
				mergedId: dup.id,
				recipes: preview.moves.recipes,
				supplierProducts: preview.moves.supplierProducts,
			},
			at: ctx.now,
		})
		return {
			mergeId,
			kind: 'item' as const,
			keptId: kept.id,
			mergedId: dup.id,
			undoUntil,
			moves: { ...preview.moves },
		}
	})
}

type StoredMerge = typeof invMerges.$inferSelect

async function loadUndoableMerge(
	tx: InventoryTx,
	mergeId: string,
	now: number,
	kind: 'item' | 'supplier',
): Promise<StoredMerge> {
	const merge = await tx
		.select()
		.from(invMerges)
		.where(eq(invMerges.id, mergeId))
		.get()
	if (!merge || merge.kind !== kind) throw notFound()
	if (merge.status === 'undone') throw new InventoryError('already_undone', 409)
	if (now > merge.undoUntil) throw new InventoryError('undo_expired', 409)
	return merge
}

/** Puts both items back as they were (within 24 hours of the merge). */
export async function undoItemMerge(
	caller: InventoryCaller,
	input: { mergeId: string },
): Promise<{ undone: true; recipesKept: number }> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const merge = await loadUndoableMerge(tx, input.mergeId, ctx.now, 'item')
		const snapshot = merge.snapshot as {
			recipes: RecipeSnapshot[]
			supplierProducts: { id: string; wasPreferred: boolean }[]
			places: Json[]
			countLists: { listId: string; sortOrder: number; dropped: boolean }[]
			prepLevels: { row: typeof invPrepLevels.$inferSelect; dropped: boolean }[]
			prepStations: {
				row: typeof invPrepItems.$inferSelect
				dropped: boolean
			}[]
			soldOut: string[]
			moved: { locationId: string; quantity: number }[]
			costs: {
				dup: typeof invItemCosts.$inferSelect | null
				kept: typeof invItemCosts.$inferSelect | null
			}
		}
		const dup = await loadItem(tx, merge.mergedId)
		const kept = await loadItem(tx, merge.keptId)
		// The duplicate's name may have been taken since: a person decides.
		const clash = await tx
			.select({ id: invItems.id })
			.from(invItems)
			.where(and(isNull(invItems.archivedAt), eq(invItems.name, dup.name)))
			.get()
		if (clash) throw new InventoryError('name_taken', 409)

		let recipesKept = 0
		for (const entry of snapshot.recipes) {
			const current = await currentRow(tx, {
				ownerKind: entry.ownerKind as 'menu_item',
				ownerId: entry.ownerId,
			})
			if (!current || current.id !== entry.toRecipeId) {
				// Someone edited the recipe since: keep their version.
				recipesKept += 1
				continue
			}
			const lines = await tx
				.select()
				.from(invRecipeLines)
				.where(eq(invRecipeLines.recipeId, entry.fromRecipeId))
			await writeVersion(tx, {
				previous: current,
				owner: { ownerKind: current.ownerKind, ownerId: current.ownerId },
				now: ctx.now,
				effectiveFrom: Math.max(ctx.now, current.effectiveFrom),
				caller,
				values: {
					makesQuantity: current.makesQuantity,
					multiplierBp: current.multiplierBp,
					typedCostMinor: current.typedCostMinor,
					typedCostCurrency: current.typedCostCurrency,
					method: current.method,
				},
				lines: lines
					.sort((a, b) => a.sortOrder - b.sortOrder)
					.map((line) => ({
						id: newId(),
						recipeId: '',
						itemId: line.itemId,
						quantity: line.quantity,
						usableBp: line.usableBp,
						mode: line.mode,
						replacesItemId: line.replacesItemId,
						sortOrder: line.sortOrder,
					})),
			})
		}
		for (const product of snapshot.supplierProducts) {
			const row = await tx
				.select()
				.from(invSupplierProducts)
				.where(eq(invSupplierProducts.id, product.id))
				.get()
			if (!row) continue
			await tx
				.update(invSupplierProducts)
				.set({
					itemId: dup.id,
					preferred: product.wasPreferred,
					version: row.version + 1,
					updatedAt: ctx.now,
				})
				.where(eq(invSupplierProducts.id, product.id))
		}
		for (const entry of snapshot.places) {
			const locationId = entry.locationId as string
			if (entry.moved) {
				await tx
					.update(invItemPlaces)
					.set({ itemId: dup.id })
					.where(
						and(
							eq(invItemPlaces.itemId, kept.id),
							eq(invItemPlaces.locationId, locationId),
						),
					)
				await tx
					.update(invItemPlaceAreas)
					.set({ itemId: dup.id })
					.where(
						and(
							eq(invItemPlaceAreas.itemId, kept.id),
							eq(invItemPlaceAreas.locationId, locationId),
						),
					)
				continue
			}
			const dupPlace = entry.dupPlace as typeof invItemPlaces.$inferSelect
			const areas = entry.areas as (typeof invItemPlaceAreas.$inferSelect)[]
			const keptLevels = entry.keptLevels as {
				orderBelowQuantity: number | null
				fillUpToQuantity: number | null
				version: number
			}
			await tx.insert(invItemPlaces).values(dupPlace)
			for (const area of areas) await tx.insert(invItemPlaceAreas).values(area)
			await tx
				.update(invItemPlaces)
				.set({
					orderBelowQuantity: keptLevels.orderBelowQuantity,
					fillUpToQuantity: keptLevels.fillUpToQuantity,
					updatedAt: ctx.now,
				})
				.where(
					and(
						eq(invItemPlaces.itemId, kept.id),
						eq(invItemPlaces.locationId, locationId),
					),
				)
		}
		for (const row of snapshot.countLists) {
			if (row.dropped) {
				await tx.insert(invCountListItems).values({
					listId: row.listId,
					itemId: dup.id,
					sortOrder: row.sortOrder,
				})
			} else {
				await tx
					.update(invCountListItems)
					.set({ itemId: dup.id })
					.where(
						and(
							eq(invCountListItems.listId, row.listId),
							eq(invCountListItems.itemId, kept.id),
						),
					)
			}
		}
		for (const entry of snapshot.prepLevels) {
			if (entry.dropped) await tx.insert(invPrepLevels).values(entry.row)
			else {
				await tx
					.update(invPrepLevels)
					.set({ itemId: dup.id })
					.where(
						and(
							eq(invPrepLevels.itemId, kept.id),
							eq(invPrepLevels.locationId, entry.row.locationId),
							eq(invPrepLevels.weekday, entry.row.weekday),
						),
					)
			}
		}
		for (const entry of snapshot.prepStations) {
			if (entry.dropped) await tx.insert(invPrepItems).values(entry.row)
			else {
				await tx
					.update(invPrepItems)
					.set({ itemId: dup.id })
					.where(
						and(
							eq(invPrepItems.itemId, kept.id),
							eq(invPrepItems.locationId, entry.row.locationId),
						),
					)
			}
		}
		if (snapshot.soldOut.length > 0) {
			await tx
				.update(invSoldOut)
				.set({ causeItemId: dup.id })
				.where(inArray(invSoldOut.id, snapshot.soldOut))
		}
		// Stock back: the opposite movements.
		for (const entry of snapshot.moved) {
			const value =
				snapshot.costs.dup && snapshot.costs.dup.avgCostMicro !== null
					? inventoryValueMinor(entry.quantity, snapshot.costs.dup.avgCostMicro)
					: null
			const businessDate = await locationBusinessDate(
				tx,
				entry.locationId,
				ctx.now,
			)
			for (const [id, sign] of [
				[kept.id, -1],
				[dup.id, 1],
			] as const) {
				await tx.insert(invMovements).values({
					id: newId(),
					locationId: entry.locationId,
					itemId: id,
					quantity: sign * entry.quantity,
					valueMinor: value === null ? null : sign * value,
					currency: value === null ? null : snapshot.costs.dup!.currency,
					kind: 'adjustment',
					reason: 'merge_undone',
					sourceType: 'item_merge',
					sourceId: merge.id,
					eventKey: `merge_undo:${merge.id}:${sign > 0 ? 'in' : 'out'}:${entry.locationId}`,
					businessDate,
					actorKind: caller.actor.kind,
					actorId: caller.actor.id,
					createdAt: ctx.now,
				})
			}
		}
		// Costs as they were.
		if (snapshot.costs.kept) {
			await tx
				.update(invItemCosts)
				.set({
					avgCostMicro: snapshot.costs.kept.avgCostMicro,
					lastCostMicro: snapshot.costs.kept.lastCostMicro,
					currency: snapshot.costs.kept.currency,
					updatedAt: ctx.now,
				})
				.where(eq(invItemCosts.itemId, kept.id))
		} else if (snapshot.costs.dup) {
			await tx.delete(invItemCosts).where(eq(invItemCosts.itemId, kept.id))
		}
		await tx
			.update(invItems)
			.set({
				archivedAt: null,
				mergedIntoId: null,
				version: dup.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invItems.id, dup.id))
		await tx
			.update(invItems)
			.set({ version: kept.version + 1, updatedAt: ctx.now })
			.where(eq(invItems.id, kept.id))
		await tx
			.update(invMerges)
			.set({ status: 'undone', undoneAt: ctx.now })
			.where(eq(invMerges.id, merge.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'item.merge_undo',
			resourceType: 'item',
			resourceId: kept.id,
			detail: { mergedId: dup.id, recipesKept },
			at: ctx.now,
		})
		return { undone: true as const, recipesKept }
	})
}

// ── Suppliers ───────────────────────────────────────────────────────────────

export async function previewSupplierMerge(
	db: InventoryReader,
	input: { supplierId: string; intoSupplierId: string; cost: boolean },
) {
	if (input.supplierId === input.intoSupplierId) {
		throw new InventoryError('merge_same_item', 400)
	}
	const [dup, kept] = await Promise.all([
		db
			.select()
			.from(invSuppliers)
			.where(eq(invSuppliers.id, input.supplierId))
			.get(),
		db
			.select()
			.from(invSuppliers)
			.where(eq(invSuppliers.id, input.intoSupplierId))
			.get(),
	])
	if (!dup || !kept) throw notFound()
	for (const supplier of [dup, kept]) {
		if (supplier.archivedAt !== null || supplier.mergedIntoId !== null) {
			throw notFound()
		}
	}
	const [products, orders, deliveries] = await Promise.all([
		db
			.select({ id: invSupplierProducts.id })
			.from(invSupplierProducts)
			.where(eq(invSupplierProducts.supplierId, dup.id)),
		db.select().from(invOrders).where(eq(invOrders.supplierId, dup.id)),
		db.select().from(invDeliveries).where(eq(invDeliveries.supplierId, dup.id)),
	])
	const blockers: Blocker[] = orders
		.filter((order) =>
			['draft', 'sent', 'partly_received'].includes(order.status),
		)
		.map((order) => ({
			kind: 'open_order' as const,
			id: order.id,
			locationId: null,
			reference: String(order.number),
		}))
	const out = {
		supplierId: dup.id,
		supplierName: dup.name,
		supplierVersion: dup.version,
		intoSupplierId: kept.id,
		intoSupplierName: kept.name,
		intoSupplierVersion: kept.version,
		blockers,
		moves: {
			products: products.length,
			orders: orders.length,
			deliveries: deliveries.length,
		},
		canApply: blockers.length === 0,
	} as {
		supplierId: string
		supplierName: string
		supplierVersion: number
		intoSupplierId: string
		intoSupplierName: string
		intoSupplierVersion: number
		blockers: Blocker[]
		moves: { products: number; orders: number; deliveries: number }
		unpaidMinor?: number
		currency?: string
		canApply: boolean
	}
	if (input.cost) {
		const unpaid = deliveries.filter(
			(row) => row.status === 'received' && row.paidAt === null,
		)
		out.unpaidMinor =
			(await supplierStats(db, null)).unpaidMinor.get(dup.id) ?? 0
		const currency = unpaid[0]?.currency ?? dup.currency
		if (currency) out.currency = currency
	}
	return out
}

export async function mergeSuppliers(
	caller: InventoryCaller,
	input: {
		supplierId: string
		body: {
			intoSupplierId: string
			expectedVersion: number
			intoExpectedVersion: number
		}
	},
): Promise<MergeResult> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const preview = await previewSupplierMerge(tx, {
			supplierId: input.supplierId,
			intoSupplierId: input.body.intoSupplierId,
			cost: false,
		})
		const [dup, kept] = await Promise.all([
			tx
				.select()
				.from(invSuppliers)
				.where(eq(invSuppliers.id, input.supplierId))
				.get(),
			tx
				.select()
				.from(invSuppliers)
				.where(eq(invSuppliers.id, input.body.intoSupplierId))
				.get(),
		])
		assertVersion(dup!.version, input.body.expectedVersion)
		assertVersion(kept!.version, input.body.intoExpectedVersion)
		if (preview.blockers.length > 0) {
			throw new InventoryError('change_blocked', 409, {
				blockers: preview.blockers,
			})
		}
		const products = await tx
			.select()
			.from(invSupplierProducts)
			.where(eq(invSupplierProducts.supplierId, dup!.id))
		for (const product of products) {
			await tx
				.update(invSupplierProducts)
				.set({
					supplierId: kept!.id,
					version: product.version + 1,
					updatedAt: ctx.now,
				})
				.where(eq(invSupplierProducts.id, product.id))
		}
		await tx
			.update(invSuppliers)
			.set({
				archivedAt: ctx.now,
				mergedIntoId: kept!.id,
				version: dup!.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invSuppliers.id, dup!.id))
		await tx
			.update(invSuppliers)
			.set({ version: kept!.version + 1, updatedAt: ctx.now })
			.where(eq(invSuppliers.id, kept!.id))
		const mergeId = newId()
		const undoUntil = ctx.now + MERGE_UNDO_WINDOW_MS
		await tx.insert(invMerges).values({
			id: mergeId,
			kind: 'supplier',
			keptId: kept!.id,
			mergedId: dup!.id,
			snapshot: { productIds: products.map((row) => row.id) },
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			createdAt: ctx.now,
			undoUntil,
		})
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'supplier.merge',
			resourceType: 'supplier',
			resourceId: kept!.id,
			detail: { mergedId: dup!.id, products: products.length },
			at: ctx.now,
		})
		return {
			mergeId,
			kind: 'supplier' as const,
			keptId: kept!.id,
			mergedId: dup!.id,
			undoUntil,
			moves: { ...preview.moves },
		}
	})
}

export async function undoSupplierMerge(
	caller: InventoryCaller,
	input: { mergeId: string },
): Promise<{ undone: true }> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const merge = await loadUndoableMerge(
			tx,
			input.mergeId,
			ctx.now,
			'supplier',
		)
		const [dup, kept] = await Promise.all([
			tx
				.select()
				.from(invSuppliers)
				.where(eq(invSuppliers.id, merge.mergedId))
				.get(),
			tx
				.select()
				.from(invSuppliers)
				.where(eq(invSuppliers.id, merge.keptId))
				.get(),
		])
		if (!dup || !kept) throw notFound()
		const clash = await tx
			.select({ id: invSuppliers.id })
			.from(invSuppliers)
			.where(
				and(isNull(invSuppliers.archivedAt), eq(invSuppliers.name, dup.name)),
			)
			.get()
		if (clash) throw new InventoryError('name_taken', 409)
		const productIds = (merge.snapshot as { productIds: string[] }).productIds
		for (const id of productIds) {
			const row = await tx
				.select()
				.from(invSupplierProducts)
				.where(eq(invSupplierProducts.id, id))
				.get()
			if (!row) continue
			await tx
				.update(invSupplierProducts)
				.set({
					supplierId: dup.id,
					version: row.version + 1,
					updatedAt: ctx.now,
				})
				.where(eq(invSupplierProducts.id, id))
		}
		await tx
			.update(invSuppliers)
			.set({
				archivedAt: null,
				mergedIntoId: null,
				version: dup.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invSuppliers.id, dup.id))
		await tx
			.update(invSuppliers)
			.set({ version: kept.version + 1, updatedAt: ctx.now })
			.where(eq(invSuppliers.id, kept.id))
		await tx
			.update(invMerges)
			.set({ status: 'undone', undoneAt: ctx.now })
			.where(eq(invMerges.id, merge.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'supplier.merge_undo',
			resourceType: 'supplier',
			resourceId: kept.id,
			detail: { mergedId: dup.id },
			at: ctx.now,
		})
		return { undone: true as const }
	})
}

// ── Reading merges ──────────────────────────────────────────────────────────

/** What an item or supplier sheet shows: where it was merged and what was merged into it. */
export async function mergeLinksFor(
	db: InventoryReader,
	input: { kind: 'item' | 'supplier'; id: string },
): Promise<{ mergedInto: MergeLink | null; mergedFrom: MergeLink[] }> {
	const rows = await db
		.select()
		.from(invMerges)
		.where(
			and(
				eq(invMerges.kind, input.kind),
				or(eq(invMerges.keptId, input.id), eq(invMerges.mergedId, input.id)),
			),
		)
		.orderBy(desc(invMerges.createdAt))
		.limit(30)
	const otherIds = rows.map((row) =>
		row.keptId === input.id ? row.mergedId : row.keptId,
	)
	const names = new Map<string, string>()
	if (otherIds.length > 0) {
		const table = input.kind === 'item' ? invItems : invSuppliers
		const found = await db
			.select({ id: table.id, name: table.name })
			.from(table)
			.where(inArray(table.id, [...new Set(otherIds)]))
		for (const row of found) names.set(row.id, row.name)
	}
	const link = (row: StoredMerge, otherId: string): MergeLink => ({
		mergeId: row.id,
		id: otherId,
		name: names.get(otherId) ?? '',
		undoUntil: row.undoUntil,
		undone: row.status === 'undone',
	})
	const into = rows.find(
		(row) => row.mergedId === input.id && row.status === 'done',
	)
	return {
		mergedInto: into ? link(into, into.keptId) : null,
		mergedFrom: rows
			.filter((row) => row.keptId === input.id)
			.map((row) => link(row, row.mergedId)),
	}
}

/** Undoes a merge of either kind. */
export async function undoMerge(
	caller: InventoryCaller,
	input: { mergeId: string; kind: 'item' | 'supplier' },
) {
	return input.kind === 'item'
		? undoItemMerge(caller, { mergeId: input.mergeId })
		: undoSupplierMerge(caller, { mergeId: input.mergeId })
}

export async function mergeKind(
	db: InventoryReader,
	mergeId: string,
): Promise<'item' | 'supplier'> {
	const row = await db
		.select({ kind: invMerges.kind })
		.from(invMerges)
		.where(eq(invMerges.id, mergeId))
		.get()
	if (!row) throw notFound()
	return row.kind
}
