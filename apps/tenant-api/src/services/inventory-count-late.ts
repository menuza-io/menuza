import { type CountLateEntry, inventoryValueMinor } from '@repo/inventory'
import { invCountLateEntries, invItems, invMovements } from '@repo/tenant-db'
import { and, asc, eq, gt, inArray, ne } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryIdempotency,
	type InventoryReader,
	type InventoryTx,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import {
	CLEARED,
	type CountRow,
	expectedAsOf,
	firstPass,
	liveEntries,
	loadAllowedCount,
	loadEntries,
	unitSlot,
} from './inventory-count-core.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import { newId, stateConflict } from './inventory-common.ts'
import {
	loadLocationStock,
	type InventoryCaller,
} from './inventory-items-service.ts'

/**
 * Entries that reach a count after it was approved (#474). They are stored, not
 * dropped and not merged: a manager sees them listed and adds one to a
 * correction in one tap (a stock adjustment with the reason "correction") or
 * dismisses it. The count's own figures never change.
 */

type LateRow = typeof invCountLateEntries.$inferSelect

export type LateEntryInput = {
	countId: string
	itemId: string
	areaId: string | null
	quantity: number
	enteredAmount: string
	enteredUnit: string
	counterKind: 'operator' | 'staff' | 'system'
	counterId: string | null
	deviceId: string | null
	clientId: string
	countedAt: number
	receivedAt: number
}

export async function storeLateEntries(
	tx: InventoryTx,
	rows: readonly LateEntryInput[],
): Promise<void> {
	for (const row of rows) {
		await tx.insert(invCountLateEntries).values({ id: newId(), ...row })
	}
}

/** Which of these client ids already sit in the late table. */
export async function lateClientIds(
	db: InventoryReader,
	clientIds: readonly string[],
): Promise<Set<string>> {
	const rows = await queryInChunks(clientIds, (chunk) =>
		db
			.select({ clientId: invCountLateEntries.clientId })
			.from(invCountLateEntries)
			.where(inArray(invCountLateEntries.clientId, chunk)),
	)
	return new Set(rows.map((row) => row.clientId))
}

export async function countOpenLateEntries(
	db: InventoryReader,
	countIds: readonly string[],
): Promise<Map<string, number>> {
	const rows = await queryInChunks(countIds, (chunk) =>
		db
			.select({
				countId: invCountLateEntries.countId,
				status: invCountLateEntries.status,
			})
			.from(invCountLateEntries)
			.where(inArray(invCountLateEntries.countId, chunk)),
	)
	const result = new Map<string, number>()
	for (const row of rows) {
		if (row.status === 'open') {
			result.set(row.countId, (result.get(row.countId) ?? 0) + 1)
		}
	}
	return result
}

type Plan = {
	adjustment: number
	superseded: boolean
	avgCostMicro: number | null
	currency: string | null
}

/**
 * What adding a late entry would change. When the item was counted in the
 * approved count, the entry is one more person's figure on top of it (minus
 * what the same person typed in the same slot before): the difference is the
 * entry's quantity. When nobody counted the item, the entry is the measurement:
 * the difference is its quantity against the ledger as of the moment it was
 * counted. An item a later approved count measured is left alone.
 */
async function planAdjustment(
	db: InventoryReader,
	count: CountRow,
	entry: LateRow,
): Promise<Plan> {
	const [entries, stock, later, appliedLate] = await Promise.all([
		loadEntries(db, [count.id]),
		loadLocationStock(db, count.locationId),
		db
			.select({ id: invMovements.id })
			.from(invMovements)
			.where(
				and(
					eq(invMovements.locationId, count.locationId),
					eq(invMovements.itemId, entry.itemId),
					eq(invMovements.kind, 'count'),
					gt(invMovements.createdAt, entry.countedAt),
					ne(invMovements.sourceId, count.id),
				),
			)
			.limit(1),
		db
			.select()
			.from(invCountLateEntries)
			.where(
				and(
					eq(invCountLateEntries.countId, count.id),
					eq(invCountLateEntries.itemId, entry.itemId),
					eq(invCountLateEntries.status, 'applied'),
				),
			),
	])
	const row = stock.find((candidate) => candidate.item.id === entry.itemId)
	const avg = row?.cost?.avgCostMicro ?? null
	const currency = row?.cost?.currency ?? null
	if (later.length > 0) {
		return { adjustment: 0, superseded: true, avgCostMicro: avg, currency }
	}
	const live = liveEntries(firstPass(entries.get(count.id) ?? [])).filter(
		(candidate) => candidate.itemId === entry.itemId,
	)
	const hadEntries = live.length > 0 || appliedLate.length > 0
	if (hadEntries) {
		const prior =
			live.find(
				(candidate) =>
					(candidate.areaId ?? '') === (entry.areaId ?? '') &&
					candidate.counterKind === entry.counterKind &&
					(candidate.counterId ?? '') === (entry.counterId ?? '') &&
					unitSlot(candidate.enteredUnit) === unitSlot(entry.enteredUnit) &&
					candidate.enteredAmount !== CLEARED,
			)?.quantity ?? 0
		return {
			adjustment: entry.quantity - prior,
			superseded: false,
			avgCostMicro: avg,
			currency,
		}
	}
	if (!row) {
		return {
			adjustment: entry.quantity,
			superseded: false,
			avgCostMicro: avg,
			currency,
		}
	}
	const asOf = await expectedAsOf(
		db,
		count.locationId,
		[row],
		new Map([[entry.itemId, entry.countedAt]]),
	)
	const expected = asOf.get(entry.itemId)?.expected ?? row.onHand
	return {
		adjustment: entry.quantity - expected,
		superseded: false,
		avgCostMicro: avg,
		currency,
	}
}

function toWire(
	row: LateRow,
	itemName: string,
	plan: Plan | null,
	cost: boolean,
): CountLateEntry {
	const out: CountLateEntry = {
		id: row.id,
		countId: row.countId,
		itemId: row.itemId,
		itemName,
		areaId: row.areaId,
		quantity: row.quantity,
		counter: { kind: row.counterKind, id: row.counterId },
		countedAt: row.countedAt,
		receivedAt: row.receivedAt,
		status: row.status,
	}
	if (plan && row.status === 'open') {
		out.adjustment = plan.adjustment
		out.superseded = plan.superseded
		if (cost && plan.avgCostMicro !== null) {
			out.adjustmentValueMinor = inventoryValueMinor(
				plan.adjustment,
				plan.avgCostMicro,
			)
			if (plan.currency) out.currency = plan.currency
		}
	}
	return out
}

export async function listLateEntries(
	db: InventoryReader,
	input: { countId: string; caller: InventoryCaller },
): Promise<CountLateEntry[]> {
	const count = await loadAllowedCount(db, input.countId, input.caller)
	const rows = await db
		.select()
		.from(invCountLateEntries)
		.where(eq(invCountLateEntries.countId, count.id))
		.orderBy(asc(invCountLateEntries.receivedAt), asc(invCountLateEntries.id))
	if (rows.length === 0) return []
	const names = await queryInChunks(
		[...new Set(rows.map((row) => row.itemId))],
		(chunk) =>
			db
				.select({ id: invItems.id, name: invItems.name })
				.from(invItems)
				.where(inArray(invItems.id, chunk)),
	)
	const nameOf = new Map(names.map((row) => [row.id, row.name]))
	const out: CountLateEntry[] = []
	for (const row of rows) {
		const plan =
			row.status === 'open' ? await planAdjustment(db, count, row) : null
		out.push(toWire(row, nameOf.get(row.itemId) ?? '', plan, input.caller.cost))
	}
	return out
}

/**
 * "Add to a correction" (`apply`) posts one adjustment (reason: correction) for
 * the late entry and marks it applied; `dismiss` leaves stock alone. Both are
 * final and idempotent by `clientId`.
 */
export async function resolveLateEntry(
	caller: InventoryCaller,
	input: {
		countId: string
		entryId: string
		action: 'apply' | 'dismiss'
		note?: string
		idempotency?: InventoryIdempotency | null
	},
): Promise<{ entry: CountLateEntry; adjustment: number }> {
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			const count = await loadAllowedCount(tx, input.countId, caller)
			const row = await tx
				.select()
				.from(invCountLateEntries)
				.where(
					and(
						eq(invCountLateEntries.id, input.entryId),
						eq(invCountLateEntries.countId, count.id),
					),
				)
				.get()
			if (!row) throw new InventoryError('not_found', 404)
			if (row.status !== 'open') throw stateConflict('late_entry_resolved')
			let adjustment = 0
			let movementId: string | null = null
			if (input.action === 'apply') {
				const plan = await planAdjustment(tx, count, row)
				adjustment = plan.adjustment
				if (adjustment !== 0) {
					movementId = newId()
					const value =
						plan.avgCostMicro === null
							? null
							: inventoryValueMinor(adjustment, plan.avgCostMicro)
					await tx.insert(invMovements).values({
						id: movementId,
						locationId: count.locationId,
						itemId: row.itemId,
						quantity: adjustment,
						valueMinor: value,
						currency: value === null ? null : plan.currency,
						kind: 'adjustment',
						reason: 'correction',
						sourceType: 'count_late',
						sourceId: row.id,
						eventKey: `count_late:${row.id}`,
						businessDate: count.businessDate,
						actorKind: caller.actor.kind,
						actorId: caller.actor.id,
						note: input.note?.length ? input.note : null,
						createdAt: ctx.now,
					})
				}
			}
			await tx
				.update(invCountLateEntries)
				.set({
					status: input.action === 'apply' ? 'applied' : 'dismissed',
					resolvedAt: ctx.now,
					resolvedById: caller.actor.id,
					movementId,
				})
				.where(eq(invCountLateEntries.id, row.id))
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: `count.late_entry.${input.action}`,
				resourceType: 'count',
				resourceId: count.id,
				locationId: count.locationId,
				detail: { entryId: row.id, adjustment },
				at: ctx.now,
			})
			const updated = await tx
				.select()
				.from(invCountLateEntries)
				.where(eq(invCountLateEntries.id, row.id))
				.get()
			const item = await tx
				.select({ name: invItems.name })
				.from(invItems)
				.where(eq(invItems.id, row.itemId))
				.get()
			return {
				entry: toWire(updated!, item?.name ?? '', null, caller.cost),
				adjustment,
			}
		},
	)
}
