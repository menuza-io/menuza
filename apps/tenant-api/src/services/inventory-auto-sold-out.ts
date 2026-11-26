import {
	FEW_LEFT_DEFAULT_THRESHOLD,
	portionsLeft,
} from '@repo/common/few-left'
import {
	AUTO_SOLD_OUT_MAX_COUNT_AGE_MS,
	type InventoryAvailabilityRequest,
	type InventoryNotifyEvent,
	type SoldOutEntityType,
} from '@repo/inventory'
import {
	getTenantDb,
	invCountEntries,
	invCounts,
	invItemGroupMembers,
	invItemPlaces,
	invItems,
	invLocationSettings,
	invMovements,
	invRecipeLines,
	invRecipes,
	invSoldOut,
	runTenantTransaction,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, inArray, isNull, max } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { errorLogFields } from '../lib/error-log.ts'
import {
	postInventoryAvailability,
	type InventoryAvailabilityOutcome,
} from '../lib/inventory-availability.ts'
import { getInventoryFlagState } from '../lib/inventory-context.ts'
import { type InventoryNotifyOutcome } from '../lib/inventory-notify.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { onHandByItem } from './inventory-common.ts'
import {
	dispatchSoldOutAlerts,
	queueSoldOutAlerts,
	type QueuedSoldOutAlert,
} from './inventory-sold-out-alerts.ts'
import { runExclusive } from './order-service.ts'

/**
 * Auto sold out: dishes and options come off the menu while an ingredient the
 * owner marked ("Mark dishes sold out when this runs out") is at zero and was
 * counted in the last seven days, and come back when stock does.
 *
 * `syncAutoSoldOut` is the one place that decides. It reads the stock ledger,
 * works out which menu entities need an item that is out, compares that with
 * `inv_sold_out` and tells the App about the difference
 * (`postInventoryAvailability`). The App confirms what it really changed and
 * only that is recorded, so an outage never leaves a row claiming a dish is
 * off the menu. It runs after every inventory write that commits, in the
 * hourly tick, and for an undo; each run is idempotent, and a run asked for
 * while another is going is folded into one more run.
 *
 * Rules the sync keeps:
 * - Only recipes decide what an item feeds: a dish (menu item) or option
 *   whose current recipe lists the item, directly or through a made item that
 *   is not counted in batches. A size (variant) is not taken off by itself.
 * - A dish already unavailable (taken off by hand) is never overruled: the App
 *   answers that it applied nothing, and the entity is recorded as `undone`
 *   (not ours) until the stock is back.
 * - A manager can put a dish back with stock still at zero (`undone`): it is
 *   not sold out again until the item has been in stock.
 * - Switched off (flags, item switch off, archived) gives the dishes back.
 */

export type AutoSoldOutOptions = {
	now?: number
	/** Posts a sold-out alert to the App (tests replace it). */
	notify?: (event: InventoryNotifyEvent) => Promise<InventoryNotifyOutcome>
	/** Posts to the App (tests replace it). */
	post?: (
		request: InventoryAvailabilityRequest,
	) => Promise<InventoryAvailabilityOutcome>
}

export type AutoSoldOutResult = {
	/** Entities taken off the menu this run. */
	soldOut: number
	/** Entities given back this run. */
	restored: number
	/** The App could not be reached; the next run asks again. */
	deferred: boolean
	/** When a held-back or failed sold-out alert should be tried again (#478). */
	alertDueAt: number | null
}

type Owner = {
	kind: 'menu_item' | 'variant' | 'option' | 'made_item'
	id: string
}

/**
 * Menu entities (dishes and options) that need any of `outItemIds`, through
 * current recipes. A made item that is not counted in batches passes its
 * ingredients on to the dishes that use it.
 */
export async function dependentsOfItems(
	db: TenantDatabase,
	outItemIds: readonly string[],
): Promise<Map<string, Set<string>>> {
	// item id → the entities `item:<id>` / `modifier_option:<id>` it takes off.
	const result = new Map<string, Set<string>>()
	if (outItemIds.length === 0) return result
	const recipes = await db
		.select({
			id: invRecipes.id,
			ownerKind: invRecipes.ownerKind,
			ownerId: invRecipes.ownerId,
		})
		.from(invRecipes)
		.where(isNull(invRecipes.supersededAt))
	if (recipes.length === 0) return result
	const lines = await queryInChunks(
		recipes.map((recipe) => recipe.id),
		(chunk) =>
			db
				.select({
					recipeId: invRecipeLines.recipeId,
					itemId: invRecipeLines.itemId,
				})
				.from(invRecipeLines)
				.where(inArray(invRecipeLines.recipeId, chunk)),
	)
	const ownerByRecipe = new Map<string, Owner>(
		recipes.map((recipe) => [
			recipe.id,
			{ kind: recipe.ownerKind, id: recipe.ownerId },
		]),
	)
	const usedBy = new Map<string, Owner[]>()
	for (const line of lines) {
		const owner = ownerByRecipe.get(line.recipeId)
		if (!owner) continue
		const list = usedBy.get(line.itemId)
		if (list) list.push(owner)
		else usedBy.set(line.itemId, [owner])
	}
	const made = await db
		.select({ id: invItems.id, batchCounted: invItems.batchCounted })
		.from(invItems)
		.where(eq(invItems.kind, 'made'))
	const batchCounted = new Set(
		made.filter((item) => item.batchCounted).map((item) => item.id),
	)
	for (const start of outItemIds) {
		const entities = new Set<string>()
		const seen = new Set<string>([start])
		let frontier = [start]
		// Made items nest a few levels at most (the engine refuses deeper).
		for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
			const next: string[] = []
			for (const itemId of frontier) {
				for (const owner of usedBy.get(itemId) ?? []) {
					if (owner.kind === 'menu_item') entities.add(`item:${owner.id}`)
					else if (owner.kind === 'option') {
						entities.add(`modifier_option:${owner.id}`)
					} else if (
						owner.kind === 'made_item' &&
						!batchCounted.has(owner.id) &&
						!seen.has(owner.id)
					) {
						seen.add(owner.id)
						next.push(owner.id)
					}
				}
			}
			frontier = next
		}
		result.set(start, entities)
	}
	return result
}

/** When each item was last in an approved count at a location. */
async function lastCountedAt(
	db: TenantDatabase,
	locationId: string,
	itemIds: readonly string[],
): Promise<Map<string, number>> {
	const rows = await queryInChunks(itemIds, (chunk) =>
		db
			.select({
				itemId: invCountEntries.itemId,
				at: max(invCounts.approvedAt),
			})
			.from(invCountEntries)
			.innerJoin(invCounts, eq(invCounts.id, invCountEntries.countId))
			.where(
				and(
					eq(invCounts.locationId, locationId),
					eq(invCounts.status, 'approved'),
					inArray(invCountEntries.itemId, chunk),
				),
			)
			.groupBy(invCountEntries.itemId),
	)
	return new Map(
		rows.filter((row) => row.at !== null).map((row) => [row.itemId, row.at!]),
	)
}

/**
 * Ingredient groups (#495) have no stock of their own: a group is at zero only
 * when every member is, so its on hand is the members' total in group units
 * and it was counted when any member was.
 */
export async function groupMembersOf(
	db: TenantDatabase,
	groupIds: readonly string[],
) {
	if (groupIds.length === 0)
		return new Map<string, (typeof invItemGroupMembers.$inferSelect)[]>()
	const rows = await queryInChunks(groupIds, (chunk) =>
		db
			.select()
			.from(invItemGroupMembers)
			.where(inArray(invItemGroupMembers.groupItemId, chunk))
			.orderBy(invItemGroupMembers.rank),
	)
	const byGroup = new Map<string, typeof rows>()
	for (const row of rows) {
		const list = byGroup.get(row.groupItemId) ?? []
		list.push(row)
		byGroup.set(row.groupItemId, list)
	}
	return byGroup
}

export function applyGroupTotals(
	onHand: Map<string, number>,
	counted: Map<string, number>,
	groups: ReadonlyMap<
		string,
		readonly (typeof invItemGroupMembers.$inferSelect)[]
	>,
): void {
	for (const [groupId, members] of groups) {
		let total = 0
		let at: number | undefined
		for (const member of members) {
			total += Math.round(
				((onHand.get(member.memberItemId) ?? 0) * member.groupQuantity) /
					member.memberQuantity,
			)
			const memberAt = counted.get(member.memberItemId)
			if (memberAt !== undefined && (at === undefined || memberAt > at)) {
				at = memberAt
			}
		}
		onHand.set(groupId, total)
		if (at !== undefined) counted.set(groupId, at)
	}
}

const running = new Map<string, { again: boolean }>()

function entityOf(key: string): { type: SoldOutEntityType; id: string } {
	const index = key.indexOf(':')
	return {
		type: key.slice(0, index) as SoldOutEntityType,
		id: key.slice(index + 1),
	}
}

async function syncOnce(
	orgId: string,
	options: AutoSoldOutOptions,
): Promise<AutoSoldOutResult> {
	const out: AutoSoldOutResult = {
		soldOut: 0,
		restored: 0,
		deferred: false,
		alertDueAt: null,
	}
	const now = options.now ?? Date.now()
	const post = options.post ?? postInventoryAvailability
	const db = await getTenantDb(orgId)

	const [autoItems, rows] = await Promise.all([
		db
			.select({ id: invItems.id })
			.from(invItems)
			.where(and(eq(invItems.autoSoldOut, true), isNull(invItems.archivedAt))),
		db.select().from(invSoldOut),
	])
	// Nothing to do for the many organizations that never switch an item on:
	// no flag lookup, no App call.
	if (autoItems.length === 0 && rows.length === 0) return out
	const flags = await getInventoryFlagState(orgId, { now })
	// Flags that cannot be read (or the kill switch) change nothing; flags that
	// are off give back every dish this took off the menu.
	if (flags.status === 'unknown' || flags.status === 'stopped') return out
	const active = flags.status === 'on' && flags.features.recipes
	const autoIds = new Set(active ? autoItems.map((item) => item.id) : [])

	// Locations to look at: where an auto item has a place or moved, and
	// wherever something is recorded as sold out.
	const locationIds = new Set(rows.map((row) => row.locationId))
	// A group's stock is its members': look where they have places or moved.
	const groupMembers = await groupMembersOf(db, [...autoIds])
	if (autoIds.size > 0) {
		const ids = [
			...new Set([
				...autoIds,
				...[...groupMembers.values()].flatMap((list) =>
					list.map((member) => member.memberItemId),
				),
			]),
		]
		const [places, moved] = await Promise.all([
			queryInChunks(ids, (chunk) =>
				db
					.selectDistinct({ locationId: invItemPlaces.locationId })
					.from(invItemPlaces)
					.where(inArray(invItemPlaces.itemId, chunk)),
			),
			queryInChunks(ids, (chunk) =>
				db
					.selectDistinct({ locationId: invMovements.locationId })
					.from(invMovements)
					// bounded: its own statement, one chunk of at most 90 ids
					.where(inArray(invMovements.itemId, chunk)),
			),
		])
		for (const row of [...places, ...moved]) locationIds.add(row.locationId)
	}

	const dependents = await dependentsOfItems(db, [...autoIds])
	for (const locationId of [...locationIds].sort()) {
		const itemIds = [...autoIds]
		const memberIds = [
			...new Set(
				[...groupMembers.values()].flatMap((list) =>
					list.map((member) => member.memberItemId),
				),
			),
		]
		const [onHand, counted] = await Promise.all([
			onHandByItem(db, locationId),
			lastCountedAt(db, locationId, [...itemIds, ...memberIds]),
		])
		applyGroupTotals(onHand, counted, groupMembers)
		// Entities that must be off the menu now, with the item that ran out.
		// A dish is only newly taken off when the ingredient was counted in the
		// last 7 days, so an abandoned count does not suddenly clear the menu;
		// once taken off, it stays off until stock is above zero again.
		const newlyOut = new Map<string, string>()
		const stillOut = new Map<string, string>()
		for (const itemId of itemIds.sort()) {
			if ((onHand.get(itemId) ?? 0) > 0) continue
			const countedAt = counted.get(itemId)
			const recentlyCounted =
				countedAt !== undefined &&
				countedAt >= now - AUTO_SOLD_OUT_MAX_COUNT_AGE_MS
			for (const key of dependents.get(itemId) ?? []) {
				if (!stillOut.has(key)) stillOut.set(key, itemId)
				if (recentlyCounted && !newlyOut.has(key)) newlyOut.set(key, itemId)
			}
		}
		const desired = newlyOut
		const here = rows.filter((row) => row.locationId === locationId)
		const known = new Map(
			here.map((row) => [`${row.entityType}:${row.entityId}`, row]),
		)
		const toAdd = [...desired.keys()].filter((key) => !known.has(key))
		const toRestore = here.filter(
			(row) =>
				row.state === 'out' &&
				!stillOut.has(`${row.entityType}:${row.entityId}`),
		)
		const toForget = here.filter(
			(row) =>
				row.state === 'undone' &&
				!stillOut.has(`${row.entityType}:${row.entityId}`),
		)

		const asked: { add: string[]; restore: typeof toRestore } = {
			add: toAdd,
			restore: toRestore,
		}
		const changes: InventoryAvailabilityRequest['changes'] = [
			...toAdd.map((key) => {
				const entity = entityOf(key)
				return {
					entityType: entity.type,
					entityId: entity.id,
					available: false,
				}
			}),
			...toRestore.map((row) => ({
				entityType: row.entityType,
				entityId: row.entityId,
				available: true,
				since: row.soldAt,
			})),
		]
		const confirmed = new Set<string>()
		// Entities whose request the App answered (a later chunk may not be).
		const answered = new Set<string>()
		for (let start = 0; start < changes.length; start += 100) {
			const chunk = changes.slice(start, start + 100)
			const outcome = await post({ orgId, locationId, changes: chunk })
			if (outcome.status !== 'applied') {
				out.deferred = outcome.status === 'retry'
				if (outcome.status === 'rejected') {
					console.error('Inventory availability was refused', {
						orgId,
						locationId,
						code: outcome.code,
					})
				}
				break
			}
			for (const change of chunk) answered.add(change.entityId)
			for (const id of outcome.applied) confirmed.add(id)
		}

		// Only the write takes the organization lock: the App call above can be
		// slow and must never hold up an order.
		await runExclusive(orgId, () =>
			retryOnSqliteBusy(() =>
				runTenantTransaction(db, async (tx) => {
					const alerts: QueuedSoldOutAlert[] = []
					for (const row of toForget) {
						await tx.delete(invSoldOut).where(eq(invSoldOut.id, row.id))
					}
					for (const key of asked.add) {
						const entity = entityOf(key)
						if (!answered.has(entity.id)) continue
						const ours = confirmed.has(entity.id)
						await tx
							.insert(invSoldOut)
							.values({
								locationId,
								entityType: entity.type,
								entityId: entity.id,
								causeItemId: desired.get(key)!,
								// An entity the App did not change was already off (by
								// hand) or is gone: remember it, never give it back.
								state: ours ? 'out' : 'undone',
								soldAt: now,
								updatedAt: now,
							})
							.onConflictDoNothing()
						if (ours) {
							out.soldOut += 1
							alerts.push({
								locationId,
								kind: 'out',
								entityType: entity.type,
								entityId: entity.id,
								causeItemId: desired.get(key)!,
							})
						}
					}
					for (const row of asked.restore) {
						if (!answered.has(row.entityId)) continue
						await tx.delete(invSoldOut).where(eq(invSoldOut.id, row.id))
						if (confirmed.has(row.entityId)) {
							out.restored += 1
							alerts.push({
								locationId,
								kind: 'back',
								entityType: row.entityType,
								entityId: row.entityId,
								causeItemId: row.causeItemId,
							})
						}
					}
					await queueSoldOutAlerts(tx, alerts, now)
				}),
			),
		)
	}
	return out
}

/**
 * Brings the menu in line with stock for one organization. Never throws.
 * Calls that overlap are folded: the second waits for the first and runs once
 * more after it, so the last change in stock is always seen.
 */
export async function syncAutoSoldOut(
	orgId: string,
	options: AutoSoldOutOptions = {},
): Promise<AutoSoldOutResult> {
	const total: AutoSoldOutResult = {
		soldOut: 0,
		restored: 0,
		deferred: false,
		alertDueAt: null,
	}
	const active = running.get(orgId)
	if (active) {
		active.again = true
		return total
	}
	const state = { again: false }
	running.set(orgId, state)
	try {
		for (let pass = 0; pass < 3; pass++) {
			state.again = false
			try {
				const result = await syncOnce(orgId, options)
				total.soldOut += result.soldOut
				total.restored += result.restored
				total.deferred = result.deferred
			} catch (error) {
				console.error('Inventory auto sold out failed', {
					orgId,
					...errorLogFields(error),
				})
				break
			}
			if (!state.again) break
		}
		// Tell managers (one grouped alert per location per 15 minutes).
		try {
			const alerts = await dispatchSoldOutAlerts(orgId, {
				now: options.now,
				post: options.notify,
			})
			total.alertDueAt = alerts.dueAt
		} catch (error) {
			console.error('Inventory sold-out alert failed', {
				orgId,
				...errorLogFields(error),
			})
		}
	} finally {
		running.delete(orgId)
	}
	return total
}

/**
 * Dishes with a few portions left (#473). Uses the same on-hand ledger and
 * the same "counted in the last 7 days" rule as auto sold-out. A dish that
 * was not counted recently is omitted.
 */
export async function listFewLeft(
	db: TenantDatabase,
	locationId: string,
	now = Date.now(),
): Promise<{
	threshold: number
	dishes: Array<{ id: string; left: number }>
}> {
	const [settings] = await db
		.select({ threshold: invLocationSettings.fewLeftThreshold })
		.from(invLocationSettings)
		.where(eq(invLocationSettings.locationId, locationId))
		.limit(1)
	const threshold = settings?.threshold ?? FEW_LEFT_DEFAULT_THRESHOLD
	const recipes = await db
		.select({
			id: invRecipes.id,
			ownerId: invRecipes.ownerId,
		})
		.from(invRecipes)
		.where(
			and(eq(invRecipes.ownerKind, 'menu_item'), isNull(invRecipes.supersededAt)),
		)
	if (recipes.length === 0) return { threshold, dishes: [] }
	const lines = await queryInChunks(
		recipes.map((recipe) => recipe.id),
		(chunk) =>
			db
				.select({
					recipeId: invRecipeLines.recipeId,
					itemId: invRecipeLines.itemId,
					quantity: invRecipeLines.quantity,
					mode: invRecipeLines.mode,
				})
				.from(invRecipeLines)
				.where(inArray(invRecipeLines.recipeId, chunk)),
	)
	const linesByRecipe = new Map<string, FewLeftLine[]>()
	for (const line of lines) {
		if (line.mode !== 'add' || line.quantity <= 0) continue
		const list = linesByRecipe.get(line.recipeId) ?? []
		list.push({ itemId: line.itemId, quantity: line.quantity })
		linesByRecipe.set(line.recipeId, list)
	}
	const itemIds = [...new Set(lines.map((line) => line.itemId))]
	const [onHand, countedAt] = await Promise.all([
		onHandByItem(db, locationId),
		lastCountedAt(db, locationId, itemIds),
	])
	const dishes: Array<{ id: string; left: number }> = []
	for (const recipe of recipes) {
		const left = portionsLeft({
			lines: linesByRecipe.get(recipe.id) ?? [],
			onHand,
			countedAt,
			now,
		})
		if (left == null || left <= 0 || left > threshold) continue
		dishes.push({ id: recipe.ownerId, left })
	}
	return { threshold, dishes }
}

type FewLeftLine = { itemId: string; quantity: number }
