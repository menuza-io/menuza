import { type SetupFinding, type SetupChecksResult } from '@repo/inventory'
import {
	invItemGroups,
	invItemPlaceAreas,
	invItemPlaces,
	invItems,
	invItemCosts,
	invRecipeLines,
	invRecipes,
	invSetupDismissals,
	invStorageAreas,
	invSupplierProducts,
	invSuppliers,
} from '@repo/tenant-db'
import { and, eq, isNull } from 'drizzle-orm'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryReader,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import { defaultCountUnit, wireUnit } from './inventory-common.ts'
import {
	type InventoryCaller,
	putItemPlace,
} from './inventory-items-service.ts'
import { updateSupplierProduct } from './inventory-purchasing-service.ts'
import { dishesWithoutRecipe } from './inventory-recipes-service.ts'

/**
 * "Check your setup" (#510): rule-based findings about stock data that is
 * probably a mistake, each with the evidence and one fix. No model, no
 * guessing beyond arithmetic. Fixes go through the same write functions (and
 * so the same checks and audit) as the screens they mirror. A dismissed
 * finding stays hidden while the data it rested on is the same: the stored
 * `fingerprint` is compared with the current one, so a change brings it back.
 */

const RATIO_OFF = 5
const UNIT_MISTAKE_TOLERANCE = 0.1
const MAX_FINDINGS = 200

function currencyExponent(currency: string): number {
	try {
		return (
			new Intl.NumberFormat('en', {
				style: 'currency',
				currency,
			}).resolvedOptions().maximumFractionDigits ?? 2
		)
	} catch {
		return 2
	}
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const middle = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1
		? sorted[middle]!
		: (sorted[middle - 1]! + sorted[middle]!) / 2
}

const KIND_ORDER: Record<SetupFinding['kind'], number> = {
	price_placeholder: 0,
	unit_off_1000x: 1,
	price_out_of_line: 2,
	recipe_archived_item: 3,
	made_item_no_recipe: 4,
	recipe_no_lines: 5,
	dish_no_recipe: 6,
	item_no_area: 7,
}

export async function computeFindings(
	db: InventoryReader,
	input: {
		locationId: string
		cost: boolean
		recipes: boolean
		caller: Pick<InventoryCaller, 'orgId' | 'region' | 'actor' | 'cost'>
	},
): Promise<SetupFinding[]> {
	const findings: SetupFinding[] = []

	// Prices (money: the cost grant only).
	const [items, productRows, costs] = await Promise.all([
		db.select().from(invItems),
		db
			.select({ product: invSupplierProducts, supplier: invSuppliers })
			.from(invSupplierProducts)
			.innerJoin(
				invSuppliers,
				eq(invSuppliers.id, invSupplierProducts.supplierId),
			)
			.where(
				and(
					isNull(invSupplierProducts.archivedAt),
					isNull(invSuppliers.archivedAt),
				),
			),
		db.select().from(invItemCosts),
	])
	const itemById = new Map(items.map((item) => [item.id, item]))
	const costById = new Map(costs.map((row) => [row.itemId, row]))
	if (input.cost) {
		const priced = productRows.filter(
			(row) => row.product.priceMinor !== null && row.product.currency,
		)
		for (const { product, supplier } of priced) {
			const item = itemById.get(product.itemId)
			if (!item || item.archivedAt !== null) continue
			const currency = product.currency!
			const price = product.priceMinor!
			const evidence = {
				supplierProductId: product.id,
				supplierId: supplier.id,
				supplierName: supplier.name,
				itemId: item.id,
				itemName: item.name,
				packName: product.packName,
				packBaseQuantity: product.packBaseQuantity,
				baseUnit: item.baseUnit,
				priceMinor: price,
				currency,
			}
			if (price === 0 || price === 10 ** currencyExponent(currency)) {
				findings.push({
					kind: 'price_placeholder',
					key: `price_placeholder:${product.id}`,
					fingerprint: `${price}:${product.packBaseQuantity}`,
					fix: {
						kind: 'open_supplier_product',
						supplierId: supplier.id,
						supplierProductId: product.id,
					},
					...evidence,
				})
				continue
			}
			// What the item's other suppliers charge per base unit, else its last price.
			const others = priced
				.filter(
					(other) =>
						other.product.itemId === item.id &&
						other.product.id !== product.id &&
						other.product.currency === currency &&
						other.product.priceMinor! > 0,
				)
				.map(
					(other) => other.product.priceMinor! / other.product.packBaseQuantity,
				)
			const last = costById.get(item.id)
			const reference =
				others.length > 0
					? median(others)
					: last?.lastCostMicro && last.currency === currency
						? last.lastCostMicro / 1e9
						: null
			if (reference === null || reference <= 0) continue
			const perUnit = price / product.packBaseQuantity
			const ratio = perUnit / reference
			const fingerprint = `${price}:${product.packBaseQuantity}:${Math.round(reference * 1e9)}`
			const off1000 =
				Math.abs(ratio - 1000) / 1000 <= UNIT_MISTAKE_TOLERANCE
					? product.packBaseQuantity * 1000
					: Math.abs(ratio - 0.001) / 0.001 <= UNIT_MISTAKE_TOLERANCE &&
						  product.packBaseQuantity >= 1000
						? Math.round(product.packBaseQuantity / 1000)
						: null
			if (off1000 !== null && off1000 >= 1 && off1000 <= 9_000_000_000) {
				findings.push({
					kind: 'unit_off_1000x',
					key: `unit_off_1000x:${product.id}`,
					fingerprint,
					fix: { kind: 'apply' },
					suggestedPackBaseQuantity: off1000,
					...evidence,
				})
			} else if (ratio >= RATIO_OFF || ratio <= 1 / RATIO_OFF) {
				findings.push({
					kind: 'price_out_of_line',
					key: `price_out_of_line:${product.id}`,
					fingerprint,
					fix: { kind: 'apply' },
					suggestedPriceMinor: Math.max(
						0,
						Math.round(reference * product.packBaseQuantity),
					),
					...evidence,
				})
			}
		}
	}

	// Recipes.
	if (input.recipes) {
		const [recipeRows, lineRows] = await Promise.all([
			db.select().from(invRecipes).where(isNull(invRecipes.supersededAt)),
			db.select().from(invRecipeLines),
		])
		const linesByRecipe = new Map<string, (typeof lineRows)[number][]>()
		for (const line of lineRows) {
			const list = linesByRecipe.get(line.recipeId) ?? []
			list.push(line)
			linesByRecipe.set(line.recipeId, list)
		}
		const withRecipe = new Set<string>()
		for (const recipe of recipeRows) {
			const lines = linesByRecipe.get(recipe.id) ?? []
			const owner = `${recipe.ownerKind}:${recipe.ownerId}`
			if (
				lines.length === 0 &&
				recipe.typedCostMinor === null &&
				recipe.multiplierBp === null &&
				recipe.version === 1
			) {
				findings.push({
					kind: 'recipe_no_lines',
					key: `recipe_no_lines:${owner}`,
					fingerprint: recipe.id,
					fix: {
						kind: 'open_recipe',
						ownerKind: recipe.ownerKind,
						ownerId: recipe.ownerId,
						lineItemId: null,
					},
					ownerKind: recipe.ownerKind,
					ownerId: recipe.ownerId,
				})
			}
			if (
				recipe.ownerKind === 'made_item' &&
				(lines.length > 0 || recipe.typedCostMinor !== null)
			) {
				withRecipe.add(recipe.ownerId)
			}
			for (const line of lines) {
				const item = itemById.get(line.itemId)
				if (!item || item.archivedAt === null) continue
				findings.push({
					kind: 'recipe_archived_item',
					key: `recipe_archived_item:${owner}:${item.id}`,
					fingerprint: `${recipe.id}:${item.archivedAt}`,
					fix: {
						kind: 'open_recipe',
						ownerKind: recipe.ownerKind,
						ownerId: recipe.ownerId,
						lineItemId: item.id,
					},
					ownerKind: recipe.ownerKind,
					ownerId: recipe.ownerId,
					itemId: item.id,
					itemName: item.name,
				})
			}
		}
		for (const item of items) {
			if (item.kind !== 'made' || item.archivedAt !== null) continue
			if (withRecipe.has(item.id)) continue
			findings.push({
				kind: 'made_item_no_recipe',
				key: `made_item_no_recipe:${item.id}`,
				fingerprint: `${item.id}:${item.version}`,
				fix: {
					kind: 'open_recipe',
					ownerKind: 'made_item',
					ownerId: item.id,
					lineItemId: null,
				},
				itemId: item.id,
				itemName: item.name,
			})
		}
		const dishes = await dishesWithoutRecipe(
			db,
			{
				orgId: input.caller.orgId,
				region: input.caller.region,
				actor: input.caller.actor,
				cost: false,
			},
			{ locationId: input.locationId, days: 7, limit: 50 },
		)
		for (const dish of dishes.dishes) {
			findings.push({
				kind: 'dish_no_recipe',
				key: `dish_no_recipe:${dish.itemId}:${input.locationId}`,
				fingerprint: `${dish.itemId}`,
				fix: {
					kind: 'open_recipe',
					ownerKind: 'menu_item',
					ownerId: dish.itemId,
					lineItemId: null,
				},
				menuItemId: dish.itemId,
				soldCount: dish.quantity,
			})
		}
	}

	// Items in no storage area at this location, so they are never counted.
	const [areas, places, placeAreas, groups] = await Promise.all([
		db
			.select()
			.from(invStorageAreas)
			.where(
				and(
					eq(invStorageAreas.locationId, input.locationId),
					isNull(invStorageAreas.archivedAt),
				),
			)
			.orderBy(invStorageAreas.sortOrder, invStorageAreas.name),
		db
			.select()
			.from(invItemPlaces)
			.where(eq(invItemPlaces.locationId, input.locationId)),
		db
			.select()
			.from(invItemPlaceAreas)
			.where(eq(invItemPlaceAreas.locationId, input.locationId)),
		db.select({ itemId: invItemGroups.itemId }).from(invItemGroups),
	])
	if (areas.length > 0) {
		const groupIds = new Set(groups.map((row) => row.itemId))
		const placed = new Set(placeAreas.map((row) => row.itemId))
		const areaIds = new Set(areas.map((area) => area.id))
		const countByCategory = new Map<string, Map<string, number>>()
		for (const row of placeAreas) {
			if (!areaIds.has(row.areaId)) continue
			const category = itemById.get(row.itemId)?.category
			if (!category) continue
			const counts = countByCategory.get(category) ?? new Map<string, number>()
			counts.set(row.areaId, (counts.get(row.areaId) ?? 0) + 1)
			countByCategory.set(category, counts)
		}
		for (const place of places) {
			const item = itemById.get(place.itemId)
			if (!item || item.archivedAt !== null || groupIds.has(item.id)) continue
			if (placed.has(item.id)) continue
			// The area most items of its category are kept in, else the first.
			const counts = countByCategory.get(item.category)
			let suggested = areas[0]!
			if (counts) {
				const best = [...counts.entries()].sort(
					(a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
				)[0]
				suggested = areas.find((area) => area.id === best![0]) ?? suggested
			}
			findings.push({
				kind: 'item_no_area',
				key: `item_no_area:${item.id}:${input.locationId}`,
				fingerprint: `${place.version}:${areas.length}`,
				fix: { kind: 'apply' },
				itemId: item.id,
				itemName: item.name,
				locationId: input.locationId,
				suggestedAreaId: suggested.id,
				suggestedAreaName: suggested.name,
			})
		}
	}

	return findings
		.sort(
			(a, b) =>
				KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
				(a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
		)
		.slice(0, MAX_FINDINGS)
}

export async function listSetupChecks(
	db: InventoryReader,
	input: {
		locationId: string
		caller: InventoryCaller
	},
): Promise<SetupChecksResult> {
	const [findings, dismissals] = await Promise.all([
		computeFindings(db, {
			locationId: input.locationId,
			cost: input.caller.cost,
			recipes: input.caller.recipesEnabled === true,
			caller: input.caller,
		}),
		db.select().from(invSetupDismissals),
	])
	const hidden = new Map(
		dismissals.map((row) => [row.key, row.fingerprint] as const),
	)
	const shown = findings.filter(
		(finding) => hidden.get(finding.key) !== finding.fingerprint,
	)
	return { findings: shown, dismissed: findings.length - shown.length }
}

type FindingRef = { locationId: string; key: string; fingerprint: string }

async function currentFinding(
	db: InventoryReader,
	caller: InventoryCaller,
	ref: FindingRef,
): Promise<SetupFinding> {
	const findings = await computeFindings(db, {
		locationId: ref.locationId,
		cost: caller.cost,
		recipes: caller.recipesEnabled === true,
		caller,
	})
	const found = findings.find((finding) => finding.key === ref.key)
	// The data moved on since the owner looked: nothing to dismiss or fix.
	if (!found || found.fingerprint !== ref.fingerprint) {
		throw new InventoryError('stale_version', 409)
	}
	return found
}

export async function dismissFinding(
	caller: InventoryCaller,
	input: { body: FindingRef },
): Promise<{ dismissed: true }> {
	return withInventoryWrite(
		{ orgId: caller.orgId, skipAutoSoldOut: true },
		async (tx, ctx) => {
			const finding = await currentFinding(tx, caller, input.body)
			await tx
				.insert(invSetupDismissals)
				.values({
					key: finding.key,
					fingerprint: finding.fingerprint,
					dismissedByKind: caller.actor.kind,
					dismissedById: caller.actor.id,
					dismissedAt: ctx.now,
				})
				.onConflictDoUpdate({
					target: invSetupDismissals.key,
					set: {
						fingerprint: finding.fingerprint,
						dismissedByKind: caller.actor.kind,
						dismissedById: caller.actor.id,
						dismissedAt: ctx.now,
					},
				})
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'setup_check.dismiss',
				resourceType: 'setup_check',
				resourceId: finding.kind,
				detail: { kind: finding.kind },
				at: ctx.now,
			})
			return { dismissed: true as const }
		},
	)
}

/**
 * Applies a finding's suggested change by calling the write function of the
 * screen that makes the same change (so its checks, grants and audit apply).
 */
export async function fixFinding(
	caller: InventoryCaller,
	input: { body: FindingRef; db: InventoryReader },
): Promise<{ fixed: true }> {
	const finding = await currentFinding(input.db, caller, input.body)
	if (finding.fix.kind !== 'apply') {
		throw new InventoryError('invalid_request', 400, { reason: 'open_only' })
	}
	if (
		finding.kind === 'price_out_of_line' ||
		finding.kind === 'unit_off_1000x'
	) {
		if (!caller.purchasing) {
			throw new InventoryError('purchasing_required', 403)
		}
		const product = await input.db
			.select()
			.from(invSupplierProducts)
			.where(eq(invSupplierProducts.id, finding.supplierProductId))
			.get()
		if (!product) throw new InventoryError('not_found', 404)
		await updateSupplierProduct(caller, {
			id: product.id,
			body:
				finding.kind === 'price_out_of_line'
					? {
							expectedVersion: product.version,
							priceMinor: finding.suggestedPriceMinor,
						}
					: {
							expectedVersion: product.version,
							packBaseQuantity: finding.suggestedPackBaseQuantity,
						},
		})
		return { fixed: true }
	}
	if (finding.kind === 'item_no_area') {
		const place = await input.db
			.select()
			.from(invItemPlaces)
			.where(
				and(
					eq(invItemPlaces.itemId, finding.itemId),
					eq(invItemPlaces.locationId, finding.locationId),
				),
			)
			.get()
		if (!place) throw new InventoryError('not_found', 404)
		await putItemPlace(caller, {
			itemId: finding.itemId,
			locationId: finding.locationId,
			body: {
				countUnit: wireUnit(
					place.countUnit ??
						defaultCountUnit(
							(await input.db
								.select({ baseUnit: invItems.baseUnit })
								.from(invItems)
								.where(eq(invItems.id, finding.itemId))
								.get())!.baseUnit,
							'metric',
						),
				),
				areaIds: [finding.suggestedAreaId],
				orderBelowQuantity: place.orderBelowQuantity,
				fillUpToQuantity: place.fillUpToQuantity,
				expectedVersion: place.version,
			},
		})
		return { fixed: true }
	}
	throw new InventoryError('invalid_request', 400)
}
