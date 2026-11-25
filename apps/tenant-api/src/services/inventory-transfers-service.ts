import {
	EDITABLE_TRANSFER_STATUSES,
	inventoryValueMinor,
	stationTransferSchema,
	type StationTransfer,
	type TransferPriceSource,
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
	invTransferTerms,
	invTransfers,
} from '@repo/tenant-db'
import { and, desc, eq, gte, inArray, max, or } from 'drizzle-orm'
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

/**
 * The open transfers of a location, plus those received or cancelled in the
 * last two days, for the Station catalogue (#515): quantities only, no price,
 * value or on-hand figure. What it must send, what is on the way in, and what
 * it asked for. Built in bulk (a handful of queries, whatever the count).
 */
export async function listStationTransfers(
	db: InventoryReader,
	input: {
		locationId: string
		region: 'us' | 'ksa'
		now: number
		limit?: number
	},
): Promise<StationTransfer[]> {
	const since = input.now - 2 * 24 * 60 * 60_000
	const rows = await db
		.select()
		.from(invTransfers)
		.where(
			and(
				or(
					eq(invTransfers.toLocationId, input.locationId),
					eq(invTransfers.fromLocationId, input.locationId),
				),
				or(
					inArray(invTransfers.status, ['requested', 'draft', 'sent']),
					gte(invTransfers.updatedAt, since),
				),
			),
		)
		.orderBy(desc(invTransfers.number))
		.limit(input.limit ?? 60)
	if (rows.length === 0) return []
	const lines = await loadLines(
		db,
		rows.map((row) => row.id),
	)
	const itemIds = [
		...new Set([...lines.values()].flat().map((line) => line.itemId)),
	]
	const [items, units, places, settings] = await Promise.all([
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
						eq(invItemPlaces.locationId, input.locationId),
						// bounded: its own statement, one chunk of at most 90 ids
						inArray(invItemPlaces.itemId, chunk),
					),
				),
		),
		getInventorySettings(db, input.region),
	])
	const itemById = new Map(items.map((item) => [item.id, item]))
	const placeOf = new Map(places.map((place) => [place.itemId, place]))
	return rows.map((row) => {
		const list = lines.get(row.id) ?? []
		const summary = summaryOf(row, list, false)
		return stationTransferSchema.parse({
			...summary,
			lines: list.map((line) => {
				const item = itemById.get(line.itemId)
				const baseUnit = item?.baseUnit ?? 'g'
				const place = placeOf.get(line.itemId)
				return {
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
					askedQuantity: line.askedQuantity ?? undefined,
				}
			}),
		})
	})
}

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

/** What a line is charged per base unit: the price fixed at send (#526), else the cost it left at. */
export function lineUnitValueMicro(
	line: Pick<LineRow, 'priceMicro' | 'unitCostMicro'>,
): number | null {
	return line.priceMicro ?? line.unitCostMicro
}

function lineValue(line: LineRow, quantity: number | null): number | null {
	const micro = lineUnitValueMicro(line)
	if (quantity === null || micro === null) return null
	return inventoryValueMinor(quantity, micro)
}

/**
 * A branch may only ask for what the sending place offers (#526). An item the
 * sender switched off is 409 `item_not_requestable`; an item with no terms row
 * is on offer. Items already on the record are left alone (a request made
 * before the switch can still be sent).
 */
async function assertRequestable(
	tx: InventoryTx,
	fromLocationId: string,
	itemIds: readonly string[],
): Promise<void> {
	if (itemIds.length === 0) return
	const blocked = await queryInChunks([...new Set(itemIds)], (chunk) =>
		tx
			.select({ itemId: invTransferTerms.itemId })
			.from(invTransferTerms)
			.where(
				and(
					eq(invTransferTerms.locationId, fromLocationId),
					eq(invTransferTerms.branchRequestable, false),
					inArray(invTransferTerms.itemId, chunk),
				),
			),
	)
	if (blocked.length > 0) {
		throw new InventoryError('item_not_requestable', 409, {
			reason: 'item_not_requestable',
		})
	}
}

type TermsRow = typeof invTransferTerms.$inferSelect

/**
 * The transfer price to fix on a line being sent: the item's fixed price, or
 * its cost plus the markup, in the sender's currency. None when the item has
 * no price set or the price cannot be worked out (the receiver is then charged
 * the cost, as before).
 */
export function transferPriceFor(
	term: Pick<
		TermsRow,
		'priceMode' | 'fixedPriceMicro' | 'currency' | 'markupBp'
	> | null,
	input: {
		averageMicro: number | null
		itemCurrency: string | null
		sendCurrency: string | null
	},
): {
	micro: number
	source: Exclude<TransferPriceSource, 'cost'>
	currency: string | null
} | null {
	if (!term || term.priceMode === 'none') return null
	if (term.priceMode === 'fixed') {
		if (term.fixedPriceMicro === null) return null
		if (
			input.sendCurrency !== null &&
			term.currency !== null &&
			term.currency !== input.sendCurrency
		) {
			return null
		}
		return {
			micro: term.fixedPriceMicro,
			source: 'fixed',
			currency: term.currency,
		}
	}
	if (term.markupBp === null || input.averageMicro === null) return null
	if (input.itemCurrency === null) return null
	if (
		input.sendCurrency !== null &&
		input.sendCurrency !== input.itemCurrency
	) {
		return null
	}
	return {
		micro: Math.round((input.averageMicro * (10_000 + term.markupBp)) / 10_000),
		source: 'cost_plus',
		currency: input.itemCurrency,
	}
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
		editedAt: row.editedAt,
		changedBySender:
			row.kind === 'request' &&
			row.editedByLocationId !== null &&
			row.editedByLocationId === row.fromLocationId,
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
		if (line.askedQuantity !== null) out.askedQuantity = line.askedQuantity
		if (caller.cost) {
			if (value !== null) out.valueMinor = value
			if (line.priceMicro !== null) {
				out.unitPriceMicro = line.priceMicro
				if (line.priceSource) out.priceSource = line.priceSource
			}
		}
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
			if (body.kind === 'request') {
				await assertRequestable(
					tx,
					body.fromLocationId,
					lines.map((line) => line.itemId),
				)
			}
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

/**
 * Who is editing: the place that made the record, or (for a request) the place
 * that was asked, which may change what it will send until it sends. A token
 * that covers both ends names the place with `locationId`.
 */
function editingLocation(
	caller: InventoryCaller,
	row: Pick<TransferRow, 'kind' | 'fromLocationId' | 'toLocationId'>,
	chosen: string | undefined,
): string {
	const creator = creatingLocation(row)
	const candidates =
		row.kind === 'request' ? [creator, row.fromLocationId] : [creator]
	if (chosen !== undefined) {
		if (!candidates.includes(chosen)) {
			throw new InventoryError('location_forbidden', 403)
		}
		assertLocationAllowed(caller.locationIds, chosen)
		return chosen
	}
	const covered = candidates.find(
		(id) => caller.locationIds === null || caller.locationIds.includes(id),
	)
	if (covered === undefined) assertLocationAllowed(caller.locationIds, creator)
	return covered ?? creator
}

/**
 * Change the lines or note of a transfer that is still `requested` or a
 * `draft` (#477): add, remove and change lines, versioned with
 * `expectedVersion` (409 `stale_version`). Once sent it is closed (409
 * `transfer_closed`, checked first so the answer says why). The place that made
 * the record edits it; the place a request was made to may change the lines
 * too, and the branch then sees the request as changed
 * (`changedBySender`, and each changed line's `askedQuantity`).
 */
export async function patchTransfer(
	caller: InventoryCaller,
	input: {
		id: string
		expectedVersion: number
		lines?: readonly TransferLineInput[]
		note?: string | null
		locationId?: string
	},
): Promise<TransferDetail> {
	await withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const { row, lines: current } = await loadTransfer(tx, input.id, caller)
		const editor = editingLocation(caller, row, input.locationId)
		if (!editable(row.status)) throw new InventoryError('transfer_closed', 409)
		assertVersion(row.version, input.expectedVersion)
		const byCreator = editor === creatingLocation(row)
		if (!byCreator && input.note !== undefined) throw badRequest('note')
		let lineCount = current.length
		if (input.lines) {
			const lines = await linesToBase(tx, input.lines, ctx.now)
			if (row.kind === 'request') {
				const onRecord = new Set(current.map((line) => line.itemId))
				await assertRequestable(
					tx,
					row.fromLocationId,
					lines
						.filter((line) => !onRecord.has(line.itemId))
						.map((line) => line.itemId),
				)
			}
			const before = new Map(current.map((line) => [line.itemId, line]))
			await tx
				.delete(invTransferLines)
				.where(eq(invTransferLines.transferId, row.id))
			for (const [index, line] of lines.entries()) {
				const old = before.get(line.itemId)
				// The maker's own edit settles what was asked; the other place's edit
				// remembers what the maker first asked for, line by line.
				let asked: number | null = null
				if (!byCreator) {
					if (!old) asked = 0
					else if (old.askedQuantity !== null) asked = old.askedQuantity
					else if (old.requestedQuantity !== line.quantity) {
						asked = old.requestedQuantity
					}
				}
				await tx.insert(invTransferLines).values({
					transferId: row.id,
					itemId: line.itemId,
					requestedQuantity: line.quantity,
					askedQuantity: asked === line.quantity ? null : asked,
					sortOrder: index,
				})
			}
			lineCount = lines.length
		}
		await tx
			.update(invTransfers)
			.set({
				...(input.note !== undefined
					? { note: input.note?.length ? input.note : null }
					: {}),
				...(input.lines
					? { editedAt: ctx.now, editedByLocationId: editor }
					: {}),
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invTransfers.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'transfer.edit',
			resourceType: 'transfer',
			resourceId: row.id,
			locationId: editor,
			detail: {
				lines: lineCount,
				linesChanged: input.lines !== undefined,
				bySender: !byCreator,
			},
			at: ctx.now,
		})
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
		/** A Station tablet's retry after a lost answer replays the first result. */
		idempotency?: InventoryIdempotency
		onReplay?: () => void
	},
): Promise<TransferDetail> {
	await withInventoryWrite(
		{
			orgId: caller.orgId,
			idempotency: input.idempotency,
			onReplay: input.onReplay,
		},
		async (tx, ctx) => {
			const { row, lines } = await loadTransfer(tx, input.id, caller)
			assertLocationAllowed(caller.locationIds, row.fromLocationId)
			assertVersion(row.version, input.expectedVersion)
			if (!editable(row.status))
				throw new InventoryError('transfer_closed', 409)
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
			// The price in force NOW is fixed on each line (#526): a later change of
			// the item's terms never reaches a sent transfer.
			const terms = new Map(
				(
					await queryInChunks(
						lines.map((line) => line.itemId),
						(chunk) =>
							tx
								.select()
								.from(invTransferTerms)
								.where(
									and(
										eq(invTransferTerms.locationId, row.fromLocationId),
										inArray(invTransferTerms.itemId, chunk),
									),
								),
					)
				).map((term) => [term.itemId, term]),
			)
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
				const price = transferPriceFor(terms.get(line.itemId) ?? null, {
					averageMicro: average,
					itemCurrency,
					sendCurrency,
				})
				await tx
					.update(invTransferLines)
					.set({
						sentQuantity: quantity,
						unitCostMicro: priced ? average : null,
						costCurrency: priced ? itemCurrency : (price?.currency ?? null),
						priceMicro: price?.micro ?? null,
						priceSource: price?.source ?? (priced ? 'cost' : null),
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
		},
	)
	return viewOf(caller, input.id)
}

export async function receiveTransfer(
	caller: InventoryCaller,
	input: {
		id: string
		expectedVersion: number
		lines?: readonly TransferLineInput[]
		idempotency?: InventoryIdempotency
		onReplay?: () => void
	},
): Promise<TransferDetail> {
	await withInventoryWrite(
		{
			orgId: caller.orgId,
			idempotency: input.idempotency,
			onReplay: input.onReplay,
		},
		async (tx, ctx) => {
			const { row, lines } = await loadTransfer(tx, input.id, caller)
			assertLocationAllowed(caller.locationIds, row.toLocationId)
			assertVersion(row.version, input.expectedVersion)
			if (row.status !== 'sent')
				throw new InventoryError('transfer_closed', 409)
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
				// What the receiver is charged: the transfer price fixed at send (#526),
				// else what the stock cost when it left.
				const unitMicro = lineUnitValueMicro(line)
				const value =
					unitMicro !== null ? inventoryValueMinor(quantity, unitMicro) : null
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
						(line) =>
							(received.get(line.itemId) ?? 0) < (line.sentQuantity ?? 0),
					).length,
				},
				at: ctx.now,
			})
		},
	)
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
