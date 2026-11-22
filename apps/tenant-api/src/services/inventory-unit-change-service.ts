import {
	conversionFactor,
	convertCostMicro,
	convertQuantity,
	MAX_ENTRY_QUANTITY,
	standardUnitsFor,
	type Blocker,
	type Fraction,
	type UnitChangeBody,
	type UnitChangePlan,
} from '@repo/inventory'
import {
	invCountEntries,
	invCounts,
	invItemCosts,
	invItemPlaces,
	invItemUnits,
	invItems,
	invMovements,
	invPrepLevels,
	invPrepTasks,
	invRecipeLines,
	invRecipes,
	invSaleUsage,
	invSupplierProducts,
	invUnitChanges,
} from '@repo/tenant-db'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { chunkIds } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryReader,
	type InventoryTx,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { itemBlockers } from './inventory-blockers.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertVersion,
	locationBusinessDate,
	locationVisible,
	newId,
	notFound,
	onHandByLocation,
} from './inventory-common.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import { currentRow, writeVersion } from './inventory-recipes-service.ts'

/**
 * Change an item's unit (#494): "1 piece = 180 g". One plan reads everything
 * the item's unit touches and works out the new numbers; the preview answers
 * the plan, the apply writes that same plan, so what the person saw is what
 * happens.
 *
 * - The stock ledger and the other history stay as written (append-only);
 *   `inv_unit_changes` records the conversion and readers convert older rows
 *   on read (`quantityInCurrentUnit`), so reports before and after show the
 *   same money. One adjustment movement per location carries the difference
 *   (new on hand minus old) so "on hand is the sum of the ledger" stays true.
 * - On hand, cost per unit, named units, supplier packs, levels, prep levels
 *   and open prep tasks, and settled sale usage are converted in place.
 * - Recipes that use the item get a NEW version (never edited in place); a
 *   made item's own recipe gets one for its batch size.
 * - Blocked while the item is in an open count, open transfer or an order
 *   that is not closed.
 */

type Plan = {
	view: UnitChangePlan
	factor: Fraction
	item: typeof invItems.$inferSelect
	onHandOld: Map<string, number>
	costRow: typeof invItemCosts.$inferSelect | null
	unitRows: (typeof invItemUnits.$inferSelect)[]
	productRows: (typeof invSupplierProducts.$inferSelect)[]
	placeRows: (typeof invItemPlaces.$inferSelect)[]
	prepLevelRows: (typeof invPrepLevels.$inferSelect)[]
	prepTaskRows: (typeof invPrepTasks.$inferSelect)[]
	usageRows: (typeof invSaleUsage.$inferSelect)[]
	recipes: {
		row: typeof invRecipes.$inferSelect
		lines: (typeof invRecipeLines.$inferSelect)[]
		newLines: Map<string, number>
		newMakes: number | null
	}[]
}

function inRange(quantity: number): boolean {
	return quantity >= 1 && quantity <= MAX_ENTRY_QUANTITY
}

async function lastCountOf(
	db: InventoryReader,
	itemId: string,
	factor: Fraction,
): Promise<UnitChangePlan['lastCount']> {
	const latest = await db
		.select({
			countId: invCounts.id,
			locationId: invCounts.locationId,
			at: invCounts.approvedAt,
		})
		.from(invCountEntries)
		.innerJoin(invCounts, eq(invCounts.id, invCountEntries.countId))
		.where(
			and(eq(invCountEntries.itemId, itemId), eq(invCounts.status, 'approved')),
		)
		.orderBy(desc(invCounts.approvedAt))
		.limit(1)
		.get()
	if (!latest || latest.at === null) return null
	const entries = await db
		.select()
		.from(invCountEntries)
		.where(
			and(
				eq(invCountEntries.countId, latest.countId),
				eq(invCountEntries.itemId, itemId),
			),
		)
		.orderBy(invCountEntries.createdAt)
	// The live entry per (area, counter, unit) is the latest one.
	const live = new Map<string, number>()
	for (const entry of entries) {
		live.set(
			JSON.stringify([
				entry.areaId,
				entry.counterKind,
				entry.counterId,
				entry.enteredUnit,
			]),
			entry.quantity,
		)
	}
	const before = [...live.values()].reduce((sum, value) => sum + value, 0)
	return {
		locationId: latest.locationId,
		at: latest.at,
		before,
		after: (() => {
			try {
				return convertQuantity(before, factor)
			} catch {
				return before
			}
		})(),
	}
}

async function buildPlan(
	db: InventoryReader,
	input: {
		itemId: string
		body: UnitChangeBody
		cost: boolean
		recipeGrant: boolean
	},
): Promise<Plan> {
	const item = await db
		.select()
		.from(invItems)
		.where(eq(invItems.id, input.itemId))
		.get()
	if (!item || item.archivedAt !== null) throw notFound()
	assertVersion(item.version, input.body.expectedVersion)
	if (item.baseUnit === input.body.toUnit) {
		throw new InventoryError('unit_not_changeable', 400)
	}
	const converted = conversionFactor(input.body.oldAmount, input.body.newAmount)
	if (!converted.ok) {
		throw new InventoryError('invalid_request', 400, {
			reason: converted.reason,
		})
	}
	const factor = converted.factor
	const blockers: Blocker[] = await itemBlockers(db, item.id, { groups: true })

	const [
		onHandOld,
		costRow,
		unitRows,
		productRows,
		placeRows,
		prepLevelRows,
		prepTaskRows,
		usageRows,
	] = await Promise.all([
		onHandByLocation(db, item.id),
		db
			.select()
			.from(invItemCosts)
			.where(eq(invItemCosts.itemId, item.id))
			.get(),
		db.select().from(invItemUnits).where(eq(invItemUnits.itemId, item.id)),
		db
			.select()
			.from(invSupplierProducts)
			.where(eq(invSupplierProducts.itemId, item.id)),
		db.select().from(invItemPlaces).where(eq(invItemPlaces.itemId, item.id)),
		db.select().from(invPrepLevels).where(eq(invPrepLevels.itemId, item.id)),
		db
			.select()
			.from(invPrepTasks)
			.where(
				and(
					eq(invPrepTasks.itemId, item.id),
					inArray(invPrepTasks.status, ['todo', 'in_progress']),
				),
			),
		db.select().from(invSaleUsage).where(eq(invSaleUsage.itemId, item.id)),
	])

	let tooSmall = false
	// A value too big for a safe integer is as unusable as one rounded to
	// nothing: the change is refused with the same answer, never a 500.
	const convert = (quantity: number): number => {
		try {
			return convertQuantity(quantity, factor)
		} catch {
			tooSmall = true
			return quantity
		}
	}
	const convertCost = (cost: number): number => {
		try {
			return convertCostMicro(cost, factor)
		} catch {
			tooSmall = true
			return cost
		}
	}
	const check = (before: number, after: number): number => {
		if (before !== 0 && !inRange(after)) tooSmall = true
		return after
	}

	// Recipes: the current version of every recipe with a line for the item,
	// and the item's own recipe when it is a made item (its batch size).
	const lineHits = await db
		.select({ recipeId: invRecipeLines.recipeId })
		.from(invRecipeLines)
		.innerJoin(invRecipes, eq(invRecipes.id, invRecipeLines.recipeId))
		.where(
			and(eq(invRecipeLines.itemId, item.id), isNull(invRecipes.supersededAt)),
		)
	const ownRecipe =
		item.kind === 'made'
			? await currentRow(db, { ownerKind: 'made_item', ownerId: item.id })
			: null
	const recipeIds = [...new Set(lineHits.map((hit) => hit.recipeId))]
	const recipes: Plan['recipes'] = []
	for (const chunk of chunkIds(recipeIds, 90)) {
		const rows = await db
			.select()
			.from(invRecipes)
			.where(inArray(invRecipes.id, chunk))
		const lines = await db
			.select()
			.from(invRecipeLines)
			.where(inArray(invRecipeLines.recipeId, chunk))
		for (const row of rows) {
			const own = lines.filter((line) => line.recipeId === row.id)
			const newLines = new Map<string, number>()
			for (const line of own) {
				if (line.itemId !== item.id) continue
				newLines.set(line.id, check(line.quantity, convert(line.quantity)))
			}
			recipes.push({ row, lines: own, newLines, newMakes: null })
		}
	}
	if (ownRecipe) {
		const lines = await db
			.select()
			.from(invRecipeLines)
			.where(eq(invRecipeLines.recipeId, ownRecipe.id))
		const makes =
			ownRecipe.makesQuantity === null
				? null
				: check(ownRecipe.makesQuantity, convert(ownRecipe.makesQuantity))
		recipes.push({
			row: ownRecipe,
			lines,
			newLines: new Map(),
			newMakes: makes,
		})
	}
	recipes.sort((a, b) =>
		a.row.ownerKind !== b.row.ownerKind
			? a.row.ownerKind < b.row.ownerKind
				? -1
				: 1
			: a.row.ownerId < b.row.ownerId
				? -1
				: a.row.ownerId > b.row.ownerId
					? 1
					: 0,
	)

	const view: UnitChangePlan = {
		itemId: item.id,
		itemName: item.name,
		fromUnit: item.baseUnit,
		toUnit: input.body.toUnit,
		factor,
		blockers,
		onHand: [...onHandOld.entries()]
			.filter(([, quantity]) => quantity !== 0)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([locationId, before]) => ({
				locationId,
				before,
				// On hand may be negative or tiny: it converts like any quantity.
				after: convert(before),
			})),
		packs: [
			...productRows.map((row) => ({
				kind: 'supplier_product' as const,
				id: row.id,
				name: row.packName,
				before: row.packBaseQuantity,
				after: check(row.packBaseQuantity, convert(row.packBaseQuantity)),
			})),
			...unitRows.map((row) => ({
				kind: 'named_unit' as const,
				id: row.id,
				name: row.name,
				before: row.baseQuantity,
				after: check(row.baseQuantity, convert(row.baseQuantity)),
			})),
		],
		recipes: recipes.map((entry) => ({
			ownerKind: entry.row.ownerKind,
			ownerId: entry.row.ownerId,
			lines: [...entry.newLines.entries()].map(([lineId, after]) => ({
				lineId,
				before: entry.lines.find((line) => line.id === lineId)!.quantity,
				after,
			})),
			makes:
				entry.newMakes !== null && entry.row.makesQuantity !== null
					? { before: entry.row.makesQuantity, after: entry.newMakes }
					: null,
		})),
		levels: placeRows
			.filter(
				(row) =>
					row.orderBelowQuantity !== null || row.fillUpToQuantity !== null,
			)
			.map((row) => ({
				locationId: row.locationId,
				orderBelow:
					row.orderBelowQuantity === null
						? null
						: {
								before: row.orderBelowQuantity,
								after: convert(row.orderBelowQuantity),
							},
				fillUpTo:
					row.fillUpToQuantity === null
						? null
						: {
								before: row.fillUpToQuantity,
								after: convert(row.fillUpToQuantity),
							},
			})),
		lastCount: await lastCountOf(db, item.id, factor),
		tooSmall: false,
		canApply: false,
	}
	if (input.cost && costRow) {
		view.cost = {
			currency: costRow.currency,
			avg:
				costRow.avgCostMicro === null
					? null
					: {
							before: costRow.avgCostMicro,
							after: convertCost(costRow.avgCostMicro),
						},
			last:
				costRow.lastCostMicro === null
					? null
					: {
							before: costRow.lastCostMicro,
							after: convertCost(costRow.lastCostMicro),
						},
		}
	}
	// What apply converts without showing it: prep levels, open prep tasks and
	// settled sale usage must stay in range too.
	for (const row of prepLevelRows) {
		check(row.fillUpToQuantity, convert(row.fillUpToQuantity))
	}
	for (const row of prepTaskRows) {
		check(row.plannedQuantity, convert(row.plannedQuantity))
		check(row.fillUpToQuantity, convert(row.fillUpToQuantity))
		check(row.onHandQuantity, convert(row.onHandQuantity))
	}
	for (const row of usageRows) check(row.quantity, convert(row.quantity))
	view.tooSmall = tooSmall
	// Rewriting recipes (new versions) needs the recipe grant.
	view.needsRecipeGrant = recipes.length > 0 && !input.recipeGrant
	view.canApply = blockers.length === 0 && !tooSmall && !view.needsRecipeGrant
	return {
		view,
		factor,
		item,
		onHandOld,
		costRow: costRow ?? null,
		unitRows,
		productRows,
		placeRows,
		prepLevelRows,
		prepTaskRows,
		usageRows,
		recipes,
	}
}

/** The plan a change would carry out, without writing anything. */
export async function previewUnitChange(
	db: InventoryReader,
	input: {
		itemId: string
		body: UnitChangeBody
		caller: Pick<InventoryCaller, 'cost' | 'recipe' | 'locationIds'>
	},
): Promise<UnitChangePlan> {
	const { view } = await buildPlan(db, {
		itemId: input.itemId,
		body: input.body,
		cost: input.caller.cost,
		recipeGrant: input.caller.recipe === true,
	})
	// A token limited to some places sees stock and levels there only.
	const visible = (locationId: string) =>
		locationVisible(input.caller.locationIds, locationId)
	return {
		...view,
		onHand: view.onHand.filter((row) => visible(row.locationId)),
		levels: view.levels.filter((row) => visible(row.locationId)),
		lastCount:
			view.lastCount && visible(view.lastCount.locationId)
				? view.lastCount
				: null,
	}
}

async function writeRecipes(
	tx: InventoryTx,
	plan: Plan,
	caller: InventoryCaller,
	now: number,
): Promise<void> {
	for (const entry of plan.recipes) {
		const previous = entry.row
		const lines = entry.lines
			.slice()
			.sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1))
			.map((line) => ({
				id: newId(),
				itemId: line.itemId,
				quantity: entry.newLines.get(line.id) ?? line.quantity,
				usableBp: line.usableBp,
				mode: line.mode,
				replacesItemId: line.replacesItemId,
				sortOrder: line.sortOrder,
			})) as (typeof invRecipeLines.$inferInsert)[]
		await writeVersion(tx, {
			previous,
			owner: { ownerKind: previous.ownerKind, ownerId: previous.ownerId },
			now,
			effectiveFrom: Math.max(now, previous.effectiveFrom),
			caller,
			values: {
				makesQuantity: entry.newMakes ?? previous.makesQuantity,
				multiplierBp: previous.multiplierBp,
				typedCostMinor: previous.typedCostMinor,
				typedCostCurrency: previous.typedCostCurrency,
				method: previous.method,
			},
			lines,
		})
	}
}

/**
 * Applies a unit change in one transaction. Answers the plan it carried out
 * (identical to the preview of the same request).
 */
export async function applyUnitChange(
	caller: InventoryCaller,
	input: { itemId: string; body: UnitChangeBody },
): Promise<{ plan: UnitChangePlan; changeId: string }> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const plan = await buildPlan(tx, {
			itemId: input.itemId,
			body: input.body,
			cost: caller.cost,
			recipeGrant: caller.recipe === true,
		})
		if (plan.view.needsRecipeGrant) {
			throw new InventoryError('needs_recipe_grant', 403)
		}
		if (plan.view.blockers.length > 0) {
			throw new InventoryError('change_blocked', 409, {
				blockers: plan.view.blockers,
			})
		}
		if (plan.view.tooSmall)
			throw new InventoryError('unit_change_too_small', 400)
		const { item, factor } = plan
		const toUnit = input.body.toUnit
		const changeId = newId()
		await tx.insert(invUnitChanges).values({
			id: changeId,
			itemId: item.id,
			fromUnit: item.baseUnit,
			toUnit,
			factorNum: factor.num,
			factorDen: factor.den,
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			createdAt: ctx.now,
		})
		await tx
			.update(invItems)
			.set({ baseUnit: toUnit, version: item.version + 1, updatedAt: ctx.now })
			.where(eq(invItems.id, item.id))

		for (const row of plan.unitRows) {
			await tx
				.update(invItemUnits)
				.set({ baseQuantity: convertQuantity(row.baseQuantity, factor) })
				.where(eq(invItemUnits.id, row.id))
		}
		for (const row of plan.productRows) {
			await tx
				.update(invSupplierProducts)
				.set({
					packBaseQuantity: convertQuantity(row.packBaseQuantity, factor),
					version: row.version + 1,
					updatedAt: ctx.now,
				})
				.where(eq(invSupplierProducts.id, row.id))
		}
		const standard = new Set<string>(standardUnitsFor(toUnit))
		for (const row of plan.placeRows) {
			await tx
				.update(invItemPlaces)
				.set({
					orderBelowQuantity:
						row.orderBelowQuantity === null
							? null
							: convertQuantity(row.orderBelowQuantity, factor),
					fillUpToQuantity:
						row.fillUpToQuantity === null
							? null
							: convertQuantity(row.fillUpToQuantity, factor),
					// A standard count unit of the old base unit no longer applies.
					countUnit:
						row.countUnit !== null &&
						!row.countUnit.startsWith('unit:') &&
						!standard.has(row.countUnit)
							? null
							: row.countUnit,
					version: row.version + 1,
					updatedAt: ctx.now,
				})
				.where(
					and(
						eq(invItemPlaces.itemId, row.itemId),
						eq(invItemPlaces.locationId, row.locationId),
					),
				)
		}
		for (const row of plan.prepLevelRows) {
			await tx
				.update(invPrepLevels)
				.set({
					fillUpToQuantity: convertQuantity(row.fillUpToQuantity, factor),
					updatedAt: ctx.now,
				})
				.where(
					and(
						eq(invPrepLevels.itemId, row.itemId),
						eq(invPrepLevels.locationId, row.locationId),
						eq(invPrepLevels.weekday, row.weekday),
					),
				)
		}
		for (const row of plan.prepTaskRows) {
			await tx
				.update(invPrepTasks)
				.set({
					plannedQuantity: convertQuantity(row.plannedQuantity, factor),
					fillUpToQuantity: convertQuantity(row.fillUpToQuantity, factor),
					onHandQuantity: convertQuantity(row.onHandQuantity, factor),
					version: row.version + 1,
					updatedAt: ctx.now,
				})
				.where(eq(invPrepTasks.id, row.id))
		}
		for (const row of plan.usageRows) {
			await tx
				.update(invSaleUsage)
				.set({
					quantity: convertQuantity(row.quantity, factor),
					updatedAt: ctx.now,
				})
				.where(
					and(
						eq(invSaleUsage.sourceType, row.sourceType),
						eq(invSaleUsage.sourceId, row.sourceId),
						eq(invSaleUsage.itemId, row.itemId),
						eq(invSaleUsage.locationId, row.locationId),
					),
				)
		}
		if (plan.costRow) {
			await tx
				.update(invItemCosts)
				.set({
					avgCostMicro:
						plan.costRow.avgCostMicro === null
							? null
							: convertCostMicro(plan.costRow.avgCostMicro, factor),
					lastCostMicro:
						plan.costRow.lastCostMicro === null
							? null
							: convertCostMicro(plan.costRow.lastCostMicro, factor),
					version: plan.costRow.version + 1,
					updatedAt: ctx.now,
				})
				.where(eq(invItemCosts.itemId, item.id))
		}
		await writeRecipes(tx, plan, caller, ctx.now)

		// The difference per location, so the ledger sums to the new on hand.
		for (const [locationId, before] of [...plan.onHandOld.entries()].sort(
			([a], [b]) => (a < b ? -1 : 1),
		)) {
			const delta = convertQuantity(before, factor) - before
			if (delta === 0) continue
			await tx.insert(invMovements).values({
				id: newId(),
				locationId,
				itemId: item.id,
				quantity: delta,
				// The value does not change: the same stock at the converted cost.
				valueMinor: plan.costRow ? 0 : null,
				currency: plan.costRow ? plan.costRow.currency : null,
				kind: 'adjustment',
				reason: 'unit_changed',
				sourceType: 'unit_change',
				sourceId: changeId,
				eventKey: `unit_change:${changeId}:${locationId}`,
				businessDate: await locationBusinessDate(tx, locationId, ctx.now),
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				createdAt: ctx.now,
			})
		}
		await tx
			.update(invUnitChanges)
			.set({ completedAt: ctx.now })
			.where(eq(invUnitChanges.id, changeId))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'item.unit_change',
			resourceType: 'item',
			resourceId: item.id,
			detail: {
				from: item.baseUnit,
				to: toUnit,
				factorNum: factor.num,
				factorDen: factor.den,
				recipes: plan.recipes.length,
			},
			at: ctx.now,
		})
		return { plan: plan.view, changeId }
	})
}
