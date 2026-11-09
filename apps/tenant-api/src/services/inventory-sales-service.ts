import {
	applyUsageDeltas,
	desiredUsage,
	diffUsage,
	inventoryValueMinor,
	type PosVoidInput,
	parseSaleLines,
	POS_VOID_REASONS,
	type RecipeOwnerKind,
	type SaleLine,
	type SaleSource,
	type UsageDelta,
	type UsageEntry,
} from '@repo/inventory'
import {
	getTenantDb,
	invMovements,
	invOutbox,
	invRecipes,
	invSaleUsage,
	invWaste,
	posOrders,
	qrTabs,
	restaurantOrders,
} from '@repo/tenant-db'
import { and, asc, eq, isNull, lt, lte, isNotNull } from 'drizzle-orm'
import { errorLogFields } from '../lib/error-log.ts'
import { getInventoryFlagState } from '../lib/inventory-context.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryTx,
	type InventoryWriteContext,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { locationBusinessDate, newId } from './inventory-common.ts'
import { buildRecipeStore, loadItemCosts } from './inventory-recipe-store.ts'
import { orderCountsTowardSales } from './report-records.ts'

/**
 * Used by sales (phase 3b-2): what each sale takes out of stock.
 *
 * The queue copies loyalty's: the sale's own transaction queues
 * `(source kind, source id)` in `inv_outbox` (`queueInventorySaleInTx`), and
 * right after it commits the source is settled (`settleInventorySales`). The
 * hourly tick, the Node interval and the Durable Object alarm retry what
 * failed (`processInventoryOutbox`). A paid sale is never refused or held up
 * because of inventory: queueing never throws, settling never throws.
 *
 * Settling re-reads the source and works out the usage it SHOULD have from its
 * current lines and the recipes in force at the sale's time (`desiredUsage`),
 * diffs that against what `inv_sale_usage` says it already took out
 * (`diffUsage`) and posts only the difference, as `sale` movements. A replayed
 * queue entry, a revised Station upload, a cancelled order or a tab rung up on
 * a till therefore converge and never double count. Station voids with reason
 * `quality` are the dish thrown away: each is its own `pos_void` source and
 * becomes waste (an `inv_waste` row and a `waste` movement), once.
 *
 * Money: every movement is valued at the item's weighted average cost when it
 * has one (null otherwise), so the ledger carries food cost without a second
 * pass. Counts and ids only are ever logged.
 */

/** Sources inventory settles from the sale side (`pos_void` is derived from `pos_order`). */
export type InventorySaleSourceType = 'restaurant_order' | 'pos_order'

export type InventorySaleSource = {
	type: InventorySaleSourceType
	id: string
	locationId: string
}

export const INVENTORY_OUTBOX_BATCH = 50
const OUTBOX_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 60 * 60 * 1000

/** 30 s, 1 min, 2 min ... capped at an hour. */
export function inventoryOutboxBackoffMs(attempts: number): number {
	const exponent = Math.min(Math.max(attempts - 1, 0), 12)
	return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS)
}

// ── Queue ───────────────────────────────────────────────────────────────────

/**
 * Queues a source whose sale changed, inside the sale's transaction. Only
 * organizations that use recipes (some recipe exists) or whose source already
 * took stock out are queued, so everyone else pays one cheap read. A source
 * queued again before it settled coalesces into the same row. Never throws:
 * inventory must never refuse a sale.
 */
export async function queueInventorySaleInTx(
	tx: InventoryTx,
	source: InventorySaleSource,
	at: number,
): Promise<boolean> {
	try {
		const usage = await tx
			.select({ itemId: invSaleUsage.itemId })
			.from(invSaleUsage)
			.where(
				and(
					eq(invSaleUsage.sourceType, source.type),
					eq(invSaleUsage.sourceId, source.id),
				),
			)
			.limit(1)
			.get()
		if (!usage) {
			const recipe = await tx
				.select({ id: invRecipes.id })
				.from(invRecipes)
				.limit(1)
				.get()
			if (!recipe) return false
		}
		const waiting = await tx
			.select({ id: invOutbox.id })
			.from(invOutbox)
			.where(
				and(
					eq(invOutbox.sourceType, source.type),
					eq(invOutbox.sourceId, source.id),
					isNull(invOutbox.settledAt),
				),
			)
			.get()
		if (waiting) {
			await tx
				.update(invOutbox)
				.set({ nextAttemptAt: at, attempts: 0, lastError: null })
				.where(eq(invOutbox.id, waiting.id))
		} else {
			await tx.insert(invOutbox).values({
				sourceType: source.type,
				sourceId: source.id,
				locationId: source.locationId,
				queuedAt: at,
				nextAttemptAt: at,
			})
		}
		return true
	} catch (error) {
		console.error('Inventory did not queue a sale', {
			sourceType: source.type,
			sourceId: source.id,
			...errorLogFields(error),
		})
		return false
	}
}

/** Queues every round of a QR tab (its void, close or station mark changes what they count). */
export async function queueInventoryTabRoundsInTx(
	tx: InventoryTx,
	tabId: string,
	at: number,
	queue: InventorySaleQueue,
): Promise<void> {
	try {
		const rounds = await tx
			.select({
				id: restaurantOrders.id,
				locationId: restaurantOrders.locationId,
			})
			.from(restaurantOrders)
			.where(eq(restaurantOrders.tabId, tabId))
			.limit(500)
		for (const round of rounds) {
			await queue.queue(
				tx,
				{
					type: 'restaurant_order',
					id: round.id,
					locationId: round.locationId,
				},
				at,
			)
		}
	} catch (error) {
		console.error('Inventory did not queue the rounds of a tab', {
			tabId,
			...errorLogFields(error),
		})
	}
}

export type InventorySaleQueue = {
	/** `queueInventorySaleInTx`, remembering the source for `settle`. */
	queue(
		tx: InventoryTx,
		source: InventorySaleSource,
		at: number,
	): Promise<boolean>
	/** Call once the sale's transaction committed and the org lock is free. */
	settle(orgId: string, options?: { now?: number }): Promise<void>
}

/**
 * Collects the sources one sale transaction queued, to settle them right after
 * it commits. A busy retry may queue a source again, or one a rolled-back
 * attempt queued: settling re-reads the sale, so either is harmless.
 */
export function inventorySaleQueue(): InventorySaleQueue {
	const sources = new Map<string, InventorySaleSource>()
	return {
		async queue(tx, source, at) {
			const queued = await queueInventorySaleInTx(tx, source, at)
			if (queued) sources.set(`${source.type}:${source.id}`, source)
			return queued
		},
		async settle(orgId, options) {
			if (sources.size === 0) return
			const pending = [...sources.values()]
			sources.clear()
			await settleInventorySales(orgId, pending, options)
		},
	}
}

// ── Reading a source ────────────────────────────────────────────────────────

type LoadedSource = {
	locationId: string
	/** The sale's time, epoch ms: picks the recipe versions in force. */
	at: number
	businessDate: string
	/** The till that owns a Station sale (a void's waste is logged against it). */
	deviceId: string | null
	source: SaleSource
	/** Item, variant and option ids the lines name, to load their recipes. */
	owners: Partial<Record<RecipeOwnerKind, string[]>>
}

function isVoidReason(value: unknown): value is PosVoidInput['reason'] {
	return (POS_VOID_REASONS as readonly string[]).includes(String(value))
}

/** Station line voids as engine input: ids, quantity, reason (the money and names stay on the sale). */
export function parsePosVoids(raw: unknown): PosVoidInput[] {
	let value = raw
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value)
		} catch {
			return []
		}
	}
	if (!Array.isArray(value)) return []
	const voids: PosVoidInput[] = []
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') continue
		const row = entry as Record<string, unknown>
		const quantity = row.quantity
		if (
			typeof row.id !== 'string' ||
			row.id.length === 0 ||
			typeof row.itemId !== 'string' ||
			row.itemId.length === 0 ||
			typeof quantity !== 'number' ||
			!Number.isInteger(quantity) ||
			quantity < 1 ||
			!isVoidReason(row.reason)
		) {
			continue
		}
		voids.push({
			id: row.id,
			itemId: row.itemId,
			quantity,
			reason: row.reason,
		})
	}
	return voids
}

function ownersOf(
	lines: readonly SaleLine[],
	voids: readonly PosVoidInput[],
): LoadedSource['owners'] {
	const items = new Set<string>()
	const variants = new Set<string>()
	const options = new Set<string>()
	for (const line of lines) {
		items.add(line.itemId)
		if (line.variantId) variants.add(line.variantId)
		for (const option of line.options ?? []) options.add(option.optionId)
	}
	for (const voided of voids) items.add(voided.itemId)
	return {
		menu_item: [...items],
		variant: [...variants],
		option: [...options],
	}
}

async function loadSource(
	tx: InventoryTx,
	row: {
		sourceType: InventorySaleSourceType
		sourceId: string
		locationId: string
	},
): Promise<LoadedSource> {
	if (row.sourceType === 'restaurant_order') {
		const order = await tx
			.select({
				status: restaurantOrders.status,
				paymentMethod: restaurantOrders.paymentMethod,
				paymentStatus: restaurantOrders.paymentStatus,
				locationId: restaurantOrders.locationId,
				createdAt: restaurantOrders.createdAt,
				lines: restaurantOrders.lines,
				rungUpOnStation: qrTabs.rungUpOnStation,
			})
			.from(restaurantOrders)
			.leftJoin(qrTabs, eq(qrTabs.id, restaurantOrders.tabId))
			.where(eq(restaurantOrders.id, row.sourceId))
			.get()
		if (!order) {
			// Gone (erased): it uses nothing.
			return {
				locationId: row.locationId,
				at: 0,
				businessDate: await locationBusinessDate(
					tx,
					row.locationId,
					Date.now(),
				),
				deviceId: null,
				source: { kind: 'restaurant_order', state: 'cancelled', lines: [] },
				owners: {},
			}
		}
		// The rounds of a tab rung up on a Station till are that till's sale.
		const counted =
			orderCountsTowardSales(order) && order.rungUpOnStation !== true
		const state = counted
			? ('counted' as const)
			: order.status === 'cancelled'
				? ('cancelled' as const)
				: order.status === 'expired'
					? ('expired' as const)
					: ('awaiting_payment' as const)
		const lines = parseSaleLines(order.lines, 'restaurant')
		const at = order.createdAt?.getTime() ?? Date.now()
		return {
			locationId: order.locationId,
			at,
			businessDate: await locationBusinessDate(tx, order.locationId, at),
			deviceId: null,
			source: { kind: 'restaurant_order', state, lines },
			owners: ownersOf(lines, []),
		}
	}
	const sale = await tx
		.select({
			status: posOrders.status,
			deviceId: posOrders.deviceId,
			locationId: posOrders.locationId,
			businessDate: posOrders.businessDate,
			rungUpAt: posOrders.rungUpAt,
			lines: posOrders.lines,
			lineVoids: posOrders.lineVoids,
		})
		.from(posOrders)
		.where(eq(posOrders.id, row.sourceId))
		.get()
	if (!sale) {
		return {
			locationId: row.locationId,
			at: 0,
			businessDate: await locationBusinessDate(tx, row.locationId, Date.now()),
			deviceId: null,
			source: { kind: 'pos_order', status: 'void', lines: [] },
			owners: {},
		}
	}
	const lines = parseSaleLines(sale.lines, 'pos')
	const lineVoids = parsePosVoids(sale.lineVoids)
	return {
		locationId: sale.locationId,
		at: sale.rungUpAt,
		businessDate: sale.businessDate,
		deviceId: sale.deviceId,
		source: { kind: 'pos_order', status: sale.status, lines, lineVoids },
		owners: ownersOf(lines, lineVoids),
	}
}

// ── Settling ────────────────────────────────────────────────────────────────

async function appliedUsage(
	tx: InventoryTx,
	sourceType: 'restaurant_order' | 'pos_order' | 'pos_void',
	sourceId: string,
): Promise<UsageEntry[]> {
	const rows = await tx
		.select({
			itemId: invSaleUsage.itemId,
			locationId: invSaleUsage.locationId,
			quantity: invSaleUsage.quantity,
		})
		.from(invSaleUsage)
		.where(
			and(
				eq(invSaleUsage.sourceType, sourceType),
				eq(invSaleUsage.sourceId, sourceId),
			),
		)
	return rows
}

/** Writes the new `inv_sale_usage` rows of a source after `deltas` were posted. */
async function storeUsage(
	tx: InventoryTx,
	input: {
		sourceType: 'restaurant_order' | 'pos_order' | 'pos_void'
		sourceId: string
		applied: readonly UsageEntry[]
		deltas: readonly UsageDelta[]
		now: number
	},
): Promise<void> {
	const after = applyUsageDeltas(input.applied, input.deltas)
	const wanted = new Map(
		after.map((entry) => [`${entry.locationId}\u0000${entry.itemId}`, entry]),
	)
	for (const entry of input.applied) {
		const key = `${entry.locationId}\u0000${entry.itemId}`
		if (wanted.has(key)) continue
		await tx
			.delete(invSaleUsage)
			.where(
				and(
					eq(invSaleUsage.sourceType, input.sourceType),
					eq(invSaleUsage.sourceId, input.sourceId),
					eq(invSaleUsage.itemId, entry.itemId),
					eq(invSaleUsage.locationId, entry.locationId),
				),
			)
	}
	for (const entry of after) {
		await tx
			.insert(invSaleUsage)
			.values({
				sourceType: input.sourceType,
				sourceId: input.sourceId,
				itemId: entry.itemId,
				locationId: entry.locationId,
				quantity: entry.quantity,
				updatedAt: input.now,
			})
			.onConflictDoUpdate({
				target: [
					invSaleUsage.sourceType,
					invSaleUsage.sourceId,
					invSaleUsage.itemId,
					invSaleUsage.locationId,
				],
				set: { quantity: entry.quantity, updatedAt: input.now },
			})
	}
}

type Costs = Awaited<ReturnType<typeof loadItemCosts>>

function valueOf(
	costs: Costs,
	itemId: string,
	quantity: number,
): { valueMinor: number; currency: string } | null {
	const average = costs.average.get(itemId) ?? null
	if (average === null || !costs.currency) return null
	return {
		valueMinor: inventoryValueMinor(quantity, average),
		currency: costs.currency,
	}
}

type SettleOutcome = 'settled' | 'skipped' | 'nothing'

async function settleInTx(
	tx: InventoryTx,
	ctx: InventoryWriteContext,
	source: { type: InventorySaleSourceType; id: string },
	flagsOn: boolean,
): Promise<SettleOutcome> {
	const row = await tx
		.select()
		.from(invOutbox)
		.where(
			and(
				eq(invOutbox.sourceType, source.type),
				eq(invOutbox.sourceId, source.id),
				isNull(invOutbox.settledAt),
			),
		)
		.get()
	// Another driver (the tick, the alarm) settled it first.
	if (!row) return 'nothing'

	const markSettled = async () => {
		await tx
			.update(invOutbox)
			.set({ settledAt: ctx.now, lastError: null })
			.where(eq(invOutbox.id, row.id))
	}

	const before = await appliedUsage(tx, source.type, source.id)
	if (!flagsOn && before.length === 0) {
		// Inventory (or recipes) is off: nothing was taken out before, and
		// stock is not counted from sales made while it was off.
		await markSettled()
		return 'skipped'
	}

	const loaded = await loadSource(tx, {
		sourceType: source.type,
		sourceId: source.id,
		locationId: row.locationId,
	})
	const { store } = await buildRecipeStore(tx, {
		at: loaded.at,
		owners: loaded.owners,
	})
	const desired = desiredUsage({
		store,
		locationId: loaded.locationId,
		at: loaded.at,
		source: loaded.source,
	})
	for (const error of desired.errors) {
		// A line whose recipes loop is left out; the sale is never refused.
		console.error('Inventory could not expand a sale line', {
			sourceType: source.type,
			sourceId: source.id,
			code: error.code,
			lineIndex: error.lineIndex,
		})
	}

	const deltas = diffUsage(before, desired.sale)
	const wasteDeltas: {
		voidId: string
		before: UsageEntry[]
		deltas: UsageDelta[]
	}[] = []
	for (const voided of desired.wasteVoids) {
		const applied = await appliedUsage(tx, 'pos_void', voided.voidId)
		wasteDeltas.push({
			voidId: voided.voidId,
			before: applied,
			deltas: diffUsage(applied, voided.usage),
		})
	}

	if (
		deltas.length > 0 ||
		wasteDeltas.some((entry) => entry.deltas.length > 0)
	) {
		const costs = await loadItemCosts(tx)
		for (const delta of deltas) {
			const value = valueOf(
				costs,
				delta.itemId,
				Math.abs(delta.movementQuantity),
			)
			const sign = delta.movementQuantity < 0 ? -1 : 1
			await tx.insert(invMovements).values({
				id: newId(),
				locationId: delta.locationId,
				itemId: delta.itemId,
				quantity: delta.movementQuantity,
				valueMinor: value ? sign * value.valueMinor : null,
				currency: value?.currency ?? null,
				kind: 'sale',
				sourceType: source.type,
				sourceId: source.id,
				eventKey: `sale:${row.id}:${delta.locationId}:${delta.itemId}`,
				businessDate: loaded.businessDate,
				actorKind: 'system',
				actorId: null,
				createdAt: ctx.now,
			})
		}
		if (deltas.length > 0) {
			await storeUsage(tx, {
				sourceType: source.type,
				sourceId: source.id,
				applied: before,
				deltas,
				now: ctx.now,
			})
		}
		for (const entry of wasteDeltas) {
			if (entry.deltas.length === 0) continue
			// A void is append-only, so its usage only ever grows from nothing.
			for (const delta of entry.deltas) {
				if (delta.usageDelta <= 0) continue
				const value = valueOf(costs, delta.itemId, delta.usageDelta)
				const wasteId = newId()
				await tx.insert(invWaste).values({
					id: wasteId,
					locationId: delta.locationId,
					itemId: delta.itemId,
					quantity: delta.usageDelta,
					reason: 'cancelled_after_cooking',
					valueMinor: value?.valueMinor ?? null,
					currency: value?.currency ?? null,
					actorKind: 'system',
					actorId: null,
					clientId: `void:${entry.voidId}:${delta.itemId}`,
					businessDate: loaded.businessDate,
					source: loaded.deviceId ? 'station' : 'operator',
					deviceId: loaded.deviceId,
					createdAt: ctx.now,
				})
				await tx.insert(invMovements).values({
					id: newId(),
					locationId: delta.locationId,
					itemId: delta.itemId,
					quantity: -delta.usageDelta,
					valueMinor: value ? -value.valueMinor : null,
					currency: value?.currency ?? null,
					kind: 'waste',
					reason: 'cancelled_after_cooking',
					sourceType: 'waste',
					sourceId: wasteId,
					eventKey: `waste:${wasteId}`,
					businessDate: loaded.businessDate,
					actorKind: 'system',
					actorId: null,
					createdAt: ctx.now,
				})
			}
			await storeUsage(tx, {
				sourceType: 'pos_void',
				sourceId: entry.voidId,
				applied: entry.before,
				deltas: entry.deltas.filter((delta) => delta.usageDelta > 0),
				now: ctx.now,
			})
		}
	}
	await markSettled()
	return 'settled'
}

/** A short machine reason for `last_error`: never a message (it can quote a row). */
function failureCode(error: unknown): string {
	if (error instanceof InventoryError) return error.code.slice(0, 60)
	if (error instanceof Error) return error.name.slice(0, 60)
	return 'unknown'
}

async function recordFailure(
	orgId: string,
	source: { type: InventorySaleSourceType; id: string },
	error: unknown,
	now: number,
): Promise<number | null> {
	try {
		const db = await getTenantDb(orgId)
		const row = await db
			.select()
			.from(invOutbox)
			.where(
				and(
					eq(invOutbox.sourceType, source.type),
					eq(invOutbox.sourceId, source.id),
					isNull(invOutbox.settledAt),
				),
			)
			.get()
		if (!row) return null
		const attempts = row.attempts + 1
		const nextAttemptAt = now + inventoryOutboxBackoffMs(attempts)
		await db
			.update(invOutbox)
			.set({ attempts, nextAttemptAt, lastError: failureCode(error) })
			.where(eq(invOutbox.id, row.id))
		return nextAttemptAt
	} catch (inner) {
		console.error('Inventory could not record a sale failure', {
			orgId,
			sourceType: source.type,
			sourceId: source.id,
			...errorLogFields(inner),
		})
		return null
	}
}

export type SettleSourceResult =
	| { status: 'settled' | 'skipped' | 'nothing' }
	| { status: 'deferred' }
	| { status: 'failed'; nextAttemptAt: number | null }

/**
 * Settles one source. Flags unreadable or the node kill switch on: left
 * queued, untouched, and settled once inventory is back. Flags off: queued
 * rows that never took stock out are closed without effect (stock is not
 * counted from sales made while inventory was off). Never throws.
 */
export async function settleInventorySource(
	orgId: string,
	source: { type: InventorySaleSourceType; id: string },
	options: { now?: number } = {},
): Promise<SettleSourceResult> {
	const now = options.now ?? Date.now()
	try {
		const flags = await getInventoryFlagState(orgId, { now })
		if (flags.status === 'unknown' || flags.status === 'stopped') {
			return { status: 'deferred' }
		}
		const flagsOn = flags.status === 'on' && flags.features.recipes
		const status = await withInventoryWrite({ orgId, now }, (tx, ctx) =>
			settleInTx(tx, ctx, source, flagsOn),
		)
		return { status }
	} catch (error) {
		console.error('Inventory sale settle deferred', {
			orgId,
			sourceType: source.type,
			sourceId: source.id,
			error: failureCode(error),
		})
		const nextAttemptAt = await recordFailure(orgId, source, error, now)
		return { status: 'failed', nextAttemptAt }
	}
}

/** Settles sources right after the sale's transaction committed. Never throws. */
export async function settleInventorySales(
	orgId: string,
	sources: readonly InventorySaleSource[],
	options: { now?: number } = {},
): Promise<void> {
	for (const source of sources) {
		await settleInventorySource(orgId, source, options)
	}
}

export type InventoryOutboxResult = {
	/** Rows closed (settled or skipped). */
	processed: number
	/** Rows that failed this time and wait for a retry. */
	failed: number
	/** When the earliest row still waiting is due; null when none. */
	nextDueAt: number | null
	/** More rows were due than one batch takes. */
	more: boolean
}

/**
 * Works through due sources, oldest first (the hourly tick, the alarm and the
 * Node interval). Each source runs on its own, so one poison row never blocks
 * the others; a row is claimed implicitly by the settle transaction, which
 * only acts on a row still unsettled.
 */
export async function processInventoryOutbox(
	orgId: string,
	options: { now?: number; limit?: number } = {},
): Promise<InventoryOutboxResult> {
	const now = options.now ?? Date.now()
	const limit = Math.min(
		Math.max(options.limit ?? INVENTORY_OUTBOX_BATCH, 1),
		200,
	)
	const db = await getTenantDb(orgId)
	const due = await db
		.select({
			sourceType: invOutbox.sourceType,
			sourceId: invOutbox.sourceId,
		})
		.from(invOutbox)
		.where(and(isNull(invOutbox.settledAt), lte(invOutbox.nextAttemptAt, now)))
		.orderBy(asc(invOutbox.nextAttemptAt), asc(invOutbox.id))
		.limit(limit)
	const result: InventoryOutboxResult = {
		processed: 0,
		failed: 0,
		nextDueAt: null,
		more: due.length === limit,
	}
	for (const row of due) {
		if (row.sourceType === 'pos_void') continue
		const outcome = await settleInventorySource(
			orgId,
			{ type: row.sourceType, id: row.sourceId },
			{ now },
		)
		if (outcome.status === 'settled' || outcome.status === 'skipped') {
			result.processed += 1
		} else if (outcome.status === 'failed') {
			result.failed += 1
		}
	}
	const next = await db
		.select({ at: invOutbox.nextAttemptAt })
		.from(invOutbox)
		.where(isNull(invOutbox.settledAt))
		.orderBy(asc(invOutbox.nextAttemptAt))
		.limit(1)
		.get()
	result.nextDueAt = next ? Math.max(next.at, now) : null
	return result
}

/** Drops settled queue rows past their retention. Returns how many. */
export async function pruneInventoryOutbox(
	orgId: string,
	now: number,
): Promise<number> {
	const db = await getTenantDb(orgId)
	const removed = await db
		.delete(invOutbox)
		.where(
			and(
				isNotNull(invOutbox.settledAt),
				lt(invOutbox.settledAt, now - OUTBOX_RETENTION_MS),
			),
		)
		.returning({ id: invOutbox.id })
	return removed.length
}
