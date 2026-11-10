import {
	EDITABLE_TRANSFER_STATUSES,
	inventoryValueMinor,
	type CreateTransfer,
	type ListTransfersResult,
	type TransferDetail,
	type TransferLine,
	type TransferLineInput,
	type TransferSummary,
} from '@repo/inventory'
import {
	getTenantDb,
	invItemPlaces,
	invItems,
	invMovements,
	invTransferLines,
	invTransfers,
} from '@repo/tenant-db'
import { and, desc, eq, inArray, max, or } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryIdempotency,
	type InventoryReader,
	type InventoryTx,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	assertVersion,
	badRequest,
	defaultCountUnit,
	loadItemUnits,
	locationBusinessDate,
	markUnitsUsed,
	newId,
	notFound,
	onHandByItem,
	typedToBase,
	wireUnit,
} from './inventory-common.ts'
import { toItemUnit, type InventoryCaller } from './inventory-items-service.ts'
import { getLocationCurrency } from './inventory-location-settings.ts'
import { loadItemCosts } from './inventory-recipe-store.ts'
import { getInventorySettings } from './inventory-settings-service.ts'

/**
 * Transfers and branch requests (phase 5). See `contract/transfers.ts` for the
 * rules; the ledger side is: sending takes stock out of the sender
 * (`transfer_out`, valued at the item's average cost, which is kept on the line
 * so what arrives is valued at what left), receiving puts what arrived into the
 * receiver (`transfer_in`). Sending and receiving are idempotent by version
 * (a second tap is a stale version, never a second movement) and their
 * movements carry unique event keys.
 */

type TransferRow = typeof invTransfers.$inferSelect
type LineRow = typeof invTransferLines.$inferSelect

/** Whether the token may act at either end. */
function allowedAt(
	caller: InventoryCaller,
	row: Pick<TransferRow, 'fromLocationId' | 'toLocationId'>,
): boolean {
	if (caller.locationIds === null) return true
	return (
		caller.locationIds.includes(row.fromLocationId) ||
		caller.locationIds.includes(row.toLocationId)
	)
}

/** A token covering neither end is refused like any record of another location. */
function assertSeesTransfer(caller: InventoryCaller, row: TransferRow): void {
	if (allowedAt(caller, row)) return
	assertLocationAllowed(caller.locationIds, row.fromLocationId)
}

const editable = (status: TransferRow['status']): boolean =>
	(EDITABLE_TRANSFER_STATUSES as readonly string[]).includes(status)

async function nextNumber(tx: InventoryTx): Promise<number> {
	const row = await tx
		.select({ highest: max(invTransfers.number) })
		.from(invTransfers)
		.get()
	return (row?.highest ?? 0) + 1
}

/** Lines as typed, converted to base thousandths and checked against the catalogue. */
async function linesToBase(
	tx: InventoryTx,
	inputs: readonly TransferLineInput[],
	now: number,
): Promise<{ itemId: string; quantity: number }[]> {
	const itemIds = [...new Set(inputs.map((line) => line.itemId))]
	const items = await queryInChunks(itemIds, (chunk) =>
		tx.select().from(invItems).where(inArray(invItems.id, chunk)),
	)
	const byId = new Map(items.map((item) => [item.id, item]))
	const units = await loadItemUnits(tx, itemIds)
	const usedUnits: string[] = []
	const lines = inputs.map((line) => {
		const item = byId.get(line.itemId)
		if (!item || item.archivedAt !== null) throw badRequest('item')
		const typed = typedToBase(
			line.amount,
			line.unit,
			item.baseUnit,
			units.get(item.id) ?? [],
		)
		if (typed.quantity <= 0) throw badRequest('amount')
		if (typed.named) usedUnits.push(typed.named.id)
		return { itemId: item.id, quantity: typed.quantity }
	})
	await markUnitsUsed(tx, usedUnits, now)
	return lines
}

async function loadLines(
	db: InventoryReader,
	transferIds: readonly string[],
): Promise<Map<string, LineRow[]>> {
	const rows = await queryInChunks(transferIds, (chunk) =>
		db
			.select()
			.from(invTransferLines)
			.where(inArray(invTransferLines.transferId, chunk)),
	)
	const byTransfer = new Map<string, LineRow[]>()
	for (const row of rows) {
		const list = byTransfer.get(row.transferId)
		if (list) list.push(row)
		else byTransfer.set(row.transferId, [row])
	}
	for (const list of byTransfer.values()) {
		list.sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1))
	}
	return byTransfer
}

function lineValue(line: LineRow, quantity: number | null): number | null {
	if (quantity === null || line.unitCostMicro === null) return null
	return inventoryValueMinor(quantity, line.unitCostMicro)
}

function summaryOf(
	row: TransferRow,
	lines: readonly LineRow[],
	cost: boolean,
): TransferSummary {
	let value = 0
	let priced = false
	let currency: string | null = null
	let missingLines = 0
	for (const line of lines) {
		const moved = line.sentQuantity ?? line.requestedQuantity
		const amount = lineValue(line, moved)
		if (amount !== null) {
			value += amount
			priced = true
			currency ??= line.costCurrency
		}
		if (
			row.status === 'received' &&
			(line.sentQuantity ?? 0) > (line.receivedQuantity ?? 0)
		) {
			missingLines += 1
		}
	}
	const summary: TransferSummary = {
		id: row.id,
		number: row.number,
		kind: row.kind,
		status: row.status,
		fromLocationId: row.fromLocationId,
		toLocationId: row.toLocationId,
		lineCount: lines.length,
		note: row.note,
		createdAt: row.createdAt,
		sentAt: row.sentAt,
		receivedAt: row.receivedAt,
		missingLines,
		version: row.version,
	}
	if (cost && priced) {
		summary.valueMinor = value
		if (currency) summary.currency = currency
	}
	return summary
}

async function detailOf(
	db: InventoryReader,
	caller: InventoryCaller,
	row: TransferRow,
	lines: readonly LineRow[],
): Promise<TransferDetail> {
	const itemIds = lines.map((line) => line.itemId)
	const [items, units, places, onHand, settings] = await Promise.all([
		queryInChunks(itemIds, (chunk) =>
			db.select().from(invItems).where(inArray(invItems.id, chunk)),
		),
		loadItemUnits(db, itemIds),
		queryInChunks(itemIds, (chunk) =>
			db
				.select()
				.from(invItemPlaces)
				.where(
					and(
						eq(invItemPlaces.locationId, row.fromLocationId),
						// bounded: its own statement, one chunk of at most 90 ids
						inArray(invItemPlaces.itemId, chunk),
					),
				),
		),
		onHandByItem(db, row.fromLocationId),
		getInventorySettings(db, caller.region),
	])
	const itemById = new Map(items.map((item) => [item.id, item]))
	const placeOf = new Map(places.map((place) => [place.itemId, place]))
	const detailLines: TransferLine[] = lines.map((line) => {
		const item = itemById.get(line.itemId)
		const place = placeOf.get(line.itemId)
		const baseUnit = item?.baseUnit ?? 'g'
		const value = lineValue(line, line.sentQuantity ?? line.requestedQuantity)
		const out: TransferLine = {
			itemId: line.itemId,
			itemName: item?.name ?? '',
			baseUnit,
			countUnit: place?.countUnit
				? wireUnit(place.countUnit)
				: wireUnit(defaultCountUnit(baseUnit, settings.unitSystem)),
			units: (units.get(line.itemId) ?? []).map(toItemUnit),
			requestedQuantity: line.requestedQuantity,
			sentQuantity: line.sentQuantity,
			receivedQuantity: line.receivedQuantity,
			missingQuantity:
				row.status === 'received' && line.sentQuantity !== null
					? Math.max(0, line.sentQuantity - (line.receivedQuantity ?? 0))
					: null,
			onHandAtSender: onHand.get(line.itemId) ?? 0,
		}
		if (caller.cost && value !== null) out.valueMinor = value
		return out
	})
	return { ...summaryOf(row, lines, caller.cost), lines: detailLines }
}

async function loadTransfer(
	tx: InventoryReader,
	id: string,
	caller: InventoryCaller,
): Promise<{ row: TransferRow; lines: LineRow[] }> {
	const row = await tx
		.select()
		.from(invTransfers)
		.where(eq(invTransfers.id, id))
		.get()
	if (!row) throw notFound()
	assertSeesTransfer(caller, row)
	const lines = (await loadLines(tx, [row.id])).get(row.id) ?? []
	return { row, lines }
}

async function viewOf(
	caller: InventoryCaller,
	id: string,
): Promise<TransferDetail> {
	const db = await getTenantDb(caller.orgId)
	const { row, lines } = await loadTransfer(db, id, caller)
	return detailOf(db, caller, row, lines)
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function listTransfers(
	db: InventoryReader,
	input: {
		caller: InventoryCaller
		locationId: string
		direction: 'in' | 'out' | 'all'
		status: string
		limit: number
	},
): Promise<ListTransfersResult> {
	assertLocationAllowed(input.caller.locationIds, input.locationId)
	const place =
		input.direction === 'in'
			? eq(invTransfers.toLocationId, input.locationId)
			: input.direction === 'out'
				? eq(invTransfers.fromLocationId, input.locationId)
				: or(
						eq(invTransfers.toLocationId, input.locationId),
						eq(invTransfers.fromLocationId, input.locationId),
					)
	const status =
		input.status === 'all'
			? undefined
			: input.status === 'open'
				? inArray(invTransfers.status, ['requested', 'draft', 'sent'])
				: eq(invTransfers.status, input.status as TransferRow['status'])
	const rows = await db
		.select()
		.from(invTransfers)
		.where(and(place, status))
		.orderBy(desc(invTransfers.number))
		.limit(input.limit)
	const lines = await loadLines(
		db,
		rows.map((row) => row.id),
	)
	return {
		transfers: rows.map((row) =>
			summaryOf(row, lines.get(row.id) ?? [], input.caller.cost),
		),
	}
}

export async function getTransfer(
	caller: InventoryCaller,
	input: { id: string },
): Promise<TransferDetail> {
	return viewOf(caller, input.id)
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** The place that makes a record is the one that may edit it: a branch for its request, the sender for its transfer. */
function creatingLocation(
	row: Pick<TransferRow, 'kind' | 'fromLocationId' | 'toLocationId'>,
): string {
	return row.kind === 'request' ? row.toLocationId : row.fromLocationId
}

/**
 * Places that keep their money in different currencies cannot move stock
 * between them: the cost of what leaves one is not a cost at the other.
 * 409 `currency_mismatch`. (A place with no currency yet cannot conflict.)
 */
async function assertSameCurrency(
	tx: InventoryTx,
	fromLocationId: string,
	toLocationId: string,
): Promise<void> {
	const [from, to] = await Promise.all([
		getLocationCurrency(tx, fromLocationId),
		getLocationCurrency(tx, toLocationId),
	])
	if (from !== null && to !== null && from !== to) {
		throw new InventoryError('currency_mismatch', 409, {
			reason: 'currency_mismatch',
		})
	}
}

export async function createTransfer(
	caller: InventoryCaller,
	input: { body: CreateTransfer; idempotency: InventoryIdempotency },
): Promise<TransferDetail> {
	const { body } = input
	assertLocationAllowed(
		caller.locationIds,
		creatingLocation({
			kind: body.kind,
			fromLocationId: body.fromLocationId,
			toLocationId: body.toLocationId,
		}),
	)
	const id = await withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			const existing = await tx
				.select({
					id: invTransfers.id,
					kind: invTransfers.kind,
					fromLocationId: invTransfers.fromLocationId,
					toLocationId: invTransfers.toLocationId,
				})
				.from(invTransfers)
				.where(eq(invTransfers.clientId, body.clientId))
				.get()
			if (existing) {
				// The same id for a different transfer is a client bug, not a replay.
				if (
					existing.kind !== body.kind ||
					existing.fromLocationId !== body.fromLocationId ||
					existing.toLocationId !== body.toLocationId
				) {
					throw new InventoryError('idempotency_conflict', 409)
				}
				return existing.id
			}
			await assertSameCurrency(tx, body.fromLocationId, body.toLocationId)
			const open = await tx
				.select({ id: invTransfers.id })
				.from(invTransfers)
				.where(
					and(
						inArray(invTransfers.status, ['requested', 'draft', 'sent']),
						or(
							eq(invTransfers.fromLocationId, body.fromLocationId),
							eq(invTransfers.toLocationId, body.toLocationId),
						),
					),
				)
				.limit(101)
			if (open.length > 100) throw new InventoryError('limit_reached', 409)
			const lines = await linesToBase(tx, body.lines, ctx.now)
			const transferId = newId()
			await tx.insert(invTransfers).values({
				id: transferId,
				number: await nextNumber(tx),
				kind: body.kind,
				status: body.kind === 'request' ? 'requested' : 'draft',
				fromLocationId: body.fromLocationId,
				toLocationId: body.toLocationId,
				note: body.note?.length ? body.note : null,
				clientId: body.clientId,
				createdByKind: caller.actor.kind,
				createdById: caller.actor.id,
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})
			for (const [index, line] of lines.entries()) {
				await tx.insert(invTransferLines).values({
					transferId,
					itemId: line.itemId,
					requestedQuantity: line.quantity,
					sortOrder: index,
				})
			}
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action:
					body.kind === 'request' ? 'transfer.request' : 'transfer.create',
				resourceType: 'transfer',
				resourceId: transferId,
				locationId: creatingLocation(body),
				detail: { lines: lines.length },
				at: ctx.now,
			})
			return transferId
		},
	)
	return viewOf(caller, id)
}

export async function patchTransfer(
	caller: InventoryCaller,
	input: {
		id: string
		expectedVersion: number
		lines?: readonly TransferLineInput[]
		note?: string | null
	},
): Promise<TransferDetail> {
	await withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const { row } = await loadTransfer(tx, input.id, caller)
		assertLocationAllowed(caller.locationIds, creatingLocation(row))
		assertVersion(row.version, input.expectedVersion)
		if (!editable(row.status)) throw new InventoryError('transfer_closed', 409)
		if (input.lines) {
			const lines = await linesToBase(tx, input.lines, ctx.now)
			await tx
				.delete(invTransferLines)
				.where(eq(invTransferLines.transferId, row.id))
			for (const [index, line] of lines.entries()) {
				await tx.insert(invTransferLines).values({
					transferId: row.id,
					itemId: line.itemId,
					requestedQuantity: line.quantity,
					sortOrder: index,
				})
			}
		}
		await tx
			.update(invTransfers)
			.set({
				...(input.note !== undefined
					? { note: input.note?.length ? input.note : null }
					: {}),
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invTransfers.id, row.id))
	})
	return viewOf(caller, input.id)
}

/** The amounts a person confirmed per item, or the default for every line. */
async function confirmedQuantities(
	tx: InventoryTx,
	lines: readonly LineRow[],
	typed: readonly TransferLineInput[] | undefined,
	fallback: (line: LineRow) => number,
	now: number,
): Promise<Map<string, number>> {
	const result = new Map<string, number>()
	if (!typed) {
		for (const line of lines) result.set(line.itemId, fallback(line))
		return result
	}
	const onRecord = new Set(lines.map((line) => line.itemId))
	for (const entry of typed) {
		if (!onRecord.has(entry.itemId)) throw badRequest('lines')
	}
	// An amount of zero is "none": `linesToBase` takes positive amounts only.
	const positive = typed.filter((entry) => entry.amount > 0)
	const converted = await linesToBase(tx, positive, now)
	for (const line of lines) result.set(line.itemId, 0)
	for (const entry of converted) result.set(entry.itemId, entry.quantity)
	return result
}

export async function sendTransfer(
	caller: InventoryCaller,
	input: {
		id: string
		expectedVersion: number
		lines?: readonly TransferLineInput[]
	},
): Promise<TransferDetail> {
	await withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const { row, lines } = await loadTransfer(tx, input.id, caller)
		assertLocationAllowed(caller.locationIds, row.fromLocationId)
		assertVersion(row.version, input.expectedVersion)
		if (!editable(row.status)) throw new InventoryError('transfer_closed', 409)
		const sent = await confirmedQuantities(
			tx,
			lines,
			input.lines,
			(line) => line.requestedQuantity,
			ctx.now,
		)
		if (![...sent.values()].some((quantity) => quantity > 0)) {
			throw badRequest('nothing_sent')
		}
		await assertSameCurrency(tx, row.fromLocationId, row.toLocationId)
		const costs = await loadItemCosts(tx)
		const businessDate = await locationBusinessDate(
			tx,
			row.fromLocationId,
			ctx.now,
		)
		const sendCurrency = await getLocationCurrency(tx, row.fromLocationId)
		for (const line of lines) {
			const quantity = sent.get(line.itemId) ?? 0
			const average = costs.average.get(line.itemId) ?? null
			const itemCurrency = costs.currencyByItem.get(line.itemId) ?? null
			// Valued in the item's own currency, and only when that is the sending
			// location's (never a mixed-currency figure).
			const priced =
				average !== null &&
				itemCurrency !== null &&
				(sendCurrency === null || sendCurrency === itemCurrency)
			await tx
				.update(invTransferLines)
				.set({
					sentQuantity: quantity,
					unitCostMicro: priced ? average : null,
					costCurrency: priced ? itemCurrency : null,
				})
				.where(
					and(
						eq(invTransferLines.transferId, row.id),
						eq(invTransferLines.itemId, line.itemId),
					),
				)
			if (quantity <= 0) continue
			const value = priced ? inventoryValueMinor(quantity, average) : null
			await tx.insert(invMovements).values({
				id: newId(),
				locationId: row.fromLocationId,
				itemId: line.itemId,
				quantity: -quantity,
				valueMinor: value === null ? null : -value,
				currency: value === null ? null : itemCurrency,
				kind: 'transfer_out',
				sourceType: 'transfer',
				sourceId: row.id,
				eventKey: `transfer:${row.id}:out:${line.itemId}`,
				businessDate,
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				createdAt: ctx.now,
			})
		}
		await tx
			.update(invTransfers)
			.set({
				status: 'sent',
				sentAt: ctx.now,
				sentByKind: caller.actor.kind,
				sentById: caller.actor.id,
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invTransfers.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'transfer.send',
			resourceType: 'transfer',
			resourceId: row.id,
			locationId: row.fromLocationId,
			detail: {
				lines: lines.length,
				short: lines.filter(
					(line) => (sent.get(line.itemId) ?? 0) < line.requestedQuantity,
				).length,
			},
			at: ctx.now,
		})
	})
	return viewOf(caller, input.id)
}

export async function receiveTransfer(
	caller: InventoryCaller,
	input: {
		id: string
		expectedVersion: number
		lines?: readonly TransferLineInput[]
	},
): Promise<TransferDetail> {
	await withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const { row, lines } = await loadTransfer(tx, input.id, caller)
		assertLocationAllowed(caller.locationIds, row.toLocationId)
		assertVersion(row.version, input.expectedVersion)
		if (row.status !== 'sent') throw new InventoryError('transfer_closed', 409)
		const received = await confirmedQuantities(
			tx,
			lines,
			input.lines,
			(line) => line.sentQuantity ?? 0,
			ctx.now,
		)
		for (const line of lines) {
			if ((received.get(line.itemId) ?? 0) > (line.sentQuantity ?? 0)) {
				throw badRequest('over_received')
			}
		}
		const businessDate = await locationBusinessDate(
			tx,
			row.toLocationId,
			ctx.now,
		)
		for (const line of lines) {
			const quantity = received.get(line.itemId) ?? 0
			await tx
				.update(invTransferLines)
				.set({ receivedQuantity: quantity })
				.where(
					and(
						eq(invTransferLines.transferId, row.id),
						eq(invTransferLines.itemId, line.itemId),
					),
				)
			if (quantity <= 0) continue
			const value =
				line.unitCostMicro !== null
					? inventoryValueMinor(quantity, line.unitCostMicro)
					: null
			await tx.insert(invMovements).values({
				id: newId(),
				locationId: row.toLocationId,
				itemId: line.itemId,
				quantity,
				valueMinor: value,
				currency: value === null ? null : line.costCurrency,
				kind: 'transfer_in',
				sourceType: 'transfer',
				sourceId: row.id,
				eventKey: `transfer:${row.id}:in:${line.itemId}`,
				businessDate,
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				createdAt: ctx.now,
			})
		}
		await tx
			.update(invTransfers)
			.set({
				status: 'received',
				receivedAt: ctx.now,
				receivedByKind: caller.actor.kind,
				receivedById: caller.actor.id,
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invTransfers.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'transfer.receive',
			resourceType: 'transfer',
			resourceId: row.id,
			locationId: row.toLocationId,
			detail: {
				lines: lines.length,
				missing: lines.filter(
					(line) => (received.get(line.itemId) ?? 0) < (line.sentQuantity ?? 0),
				).length,
			},
			at: ctx.now,
		})
	})
	return viewOf(caller, input.id)
}

export async function cancelTransfer(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number },
): Promise<TransferDetail> {
	await withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const { row } = await loadTransfer(tx, input.id, caller)
		// Cancelled twice answers the same; a sent transfer is received, not cancelled.
		if (row.status === 'cancelled') return
		assertVersion(row.version, input.expectedVersion)
		if (!editable(row.status)) throw new InventoryError('transfer_closed', 409)
		await tx
			.update(invTransfers)
			.set({
				status: 'cancelled',
				cancelledAt: ctx.now,
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invTransfers.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'transfer.cancel',
			resourceType: 'transfer',
			resourceId: row.id,
			locationId: creatingLocation(row),
			at: ctx.now,
		})
	})
	return viewOf(caller, input.id)
}

/**
 * What open requests (and drafts not yet sent) ask of a location, per item, so
 * a central kitchen's prep list makes enough for its branches. Base thousandths.
 */
export async function committedFromLocation(
	db: InventoryReader,
	locationId: string,
): Promise<Map<string, number>> {
	const rows = await db
		.select({ id: invTransfers.id })
		.from(invTransfers)
		.where(
			and(
				eq(invTransfers.fromLocationId, locationId),
				inArray(invTransfers.status, ['requested', 'draft']),
			),
		)
	const committed = new Map<string, number>()
	if (rows.length === 0) return committed
	const lines = await loadLines(
		db,
		rows.map((row) => row.id),
	)
	for (const list of lines.values()) {
		for (const line of list) {
			committed.set(
				line.itemId,
				(committed.get(line.itemId) ?? 0) + line.requestedQuantity,
			)
		}
	}
	return committed
}
