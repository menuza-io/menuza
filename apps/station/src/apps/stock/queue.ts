import {
	STATION_QUEUE_LIMIT,
	stationBackoffMs,
	type StationOutboxItem,
	type StationOutboxKind,
	type StationRef,
	type UnitRef,
} from '@repo/inventory'
import {
	localCounts,
	localValues,
	rememberWaste,
	saveLocalCounts,
	saveLocalValues,
	wasteKey,
	writeKey,
	type LocalCount,
} from './local.ts'
import { rowKey, type CountValue } from './model.ts'
import { db, type StockRow } from '~/lib/db.ts'

/**
 * The Stock app's outbox, in IndexedDB (`stockQueue`). Every count entry,
 * waste entry and delivery is written here, in one transaction, before the
 * person sees it saved; the runner (`runner.ts`) sends the rows oldest first.
 * The server de-duplicates on each row's `id` (its `clientId`), so a retry
 * after a lost answer is harmless.
 *
 * Rows that name another row (`{ clientId }` refs: entries of a count started
 * offline, an undo of a waste entry still waiting, a delivery's photo) are
 * rewritten to the server's id in the same transaction that settles the row
 * they name.
 */

export type StockContext = {
	/** The restaurant (`stockOrigin`). */
	origin: string
	locationId: string
	/** The signed-in person's staff id: who made it. */
	madeBy: string | null
}

export class StockQueueFullError extends Error {
	constructor() {
		super('queue_full')
		this.name = 'StockQueueFullError'
	}
}

/** A claim older than this belongs to a tab that died mid-request (a request gives up after 15 s). */
export const STALE_CLAIM_MS = 20_000

const newId = () => crypto.randomUUID()

type Payload<K extends StationOutboxKind> = Extract<
	StationOutboxItem,
	{ kind: K }
>['payload']

// ── Refs ────────────────────────────────────────────────────────────────────

/** The row or server thing this row is about, when it names one. */
export function refOf(row: StockRow): StationRef | null {
	switch (row.kind) {
		case 'count_entry':
		case 'count_send':
			return row.payload.count
		case 'waste_undo':
			return row.payload.waste
		case 'delivery_photo':
			return row.payload.delivery
		default:
			return null
	}
}

function withRef(row: StockRow, ref: StationRef): StockRow {
	switch (row.kind) {
		case 'count_entry':
			return { ...row, payload: { ...row.payload, count: ref } }
		case 'count_send':
			return { ...row, payload: { ...row.payload, count: ref } }
		case 'waste_undo':
			return { ...row, payload: { ...row.payload, waste: ref } }
		case 'delivery_photo':
			return { ...row, payload: { ...row.payload, delivery: ref } }
		default:
			return row
	}
}

export const sameRef = (a: StationRef, b: StationRef) =>
	'id' in a && 'id' in b
		? a.id === b.id
		: 'clientId' in a && 'clientId' in b && a.clientId === b.clientId

const dependsOn = (row: StockRow, id: string) => {
	const ref = refOf(row)
	return ref !== null && 'clientId' in ref && ref.clientId === id
}

// ── Writing rows ────────────────────────────────────────────────────────────

async function nextSeq(): Promise<number> {
	const last = await db.stockQueue.orderBy('seq').last()
	return (last?.seq ?? 0) + 1
}

function makeRow<K extends StationOutboxKind>(
	ctx: StockContext,
	kind: K,
	payload: Payload<K>,
	extra: { id: string; seq: number; now: number },
): StockRow {
	return {
		id: extra.id,
		kind,
		payload,
		locationId: ctx.locationId,
		madeBy: ctx.madeBy,
		madeAt: extra.now,
		createdAt: extra.now,
		attempts: 0,
		nextAttemptAt: null,
		status: 'queued',
		failure: null,
		seq: extra.seq,
		origin: ctx.origin,
	} as StockRow
}

/** Adds a row inside the caller's transaction (`stockQueue` must be locked for writing). */
async function addRow<K extends StationOutboxKind>(
	ctx: StockContext,
	kind: K,
	payload: Payload<K>,
	id = newId(),
): Promise<StockRow> {
	const waiting = await db.stockQueue
		.filter((row) => row.origin === ctx.origin && row.status !== 'failed')
		.count()
	if (waiting >= STATION_QUEUE_LIMIT) throw new StockQueueFullError()
	const row = makeRow(ctx, kind, payload, {
		id,
		seq: await nextSeq(),
		now: Date.now(),
	})
	await db.stockQueue.add(row)
	return row
}

// ── Counts ──────────────────────────────────────────────────────────────────

/**
 * Starts a count of `listId` (null: everything) on this tablet. A count of
 * the same list already open here is continued instead (two taps never make
 * two). The start waits in the outbox; the count can be worked on at once.
 */
export async function startCount(
	ctx: StockContext,
	list: { id: string | null; name: string | null },
): Promise<LocalCount> {
	return db.transaction(
		'rw',
		db.stockQueue,
		db.stockCatalog,
		async (): Promise<LocalCount> => {
			const counts = await localCounts(ctx.origin)
			const open = counts.find(
				(count) =>
					count.status === 'counting' &&
					count.listId === list.id &&
					!count.startFailed,
			)
			if (open) return open
			const row = await addRow(ctx, 'count_start', { listId: list.id })
			const record: LocalCount = {
				localId: row.id,
				ref: { clientId: row.id },
				listId: list.id,
				listName: list.name,
				status: 'counting',
				startedAt: row.createdAt,
			}
			await saveLocalCounts(ctx.origin, [...counts, record])
			return record
		},
	)
}

/** Joins a count the server lists as in progress (started on a phone, another tablet or in the App). */
export async function joinCount(
	ctx: StockContext,
	count: { id: string; listId: string | null; listName: string | null },
): Promise<LocalCount> {
	return db.transaction(
		'rw',
		db.stockCatalog,
		async (): Promise<LocalCount> => {
			const counts = await localCounts(ctx.origin)
			const known = counts.find(
				(entry) => 'id' in entry.ref && entry.ref.id === count.id,
			)
			if (known) return known
			const record: LocalCount = {
				localId: `srv-${count.id}`,
				ref: { id: count.id },
				listId: count.listId,
				listName: count.listName,
				status: 'counting',
				startedAt: Date.now(),
				joined: true,
			}
			await saveLocalCounts(ctx.origin, [
				...counts.filter((entry) => entry.localId !== record.localId),
				record,
			])
			return record
		},
	)
}

export class CountClosedError extends Error {
	constructor() {
		super('count_sent')
		this.name = 'CountClosedError'
	}
}

export type CountEntryInput = {
	itemId: string
	areaId: string | null
	amount: number | null
	unit: UnitRef
}

/**
 * Saves what was typed in one row of a count: the value is remembered for the
 * screen and one entry is queued. An entry for the same row still waiting
 * (never tried) is replaced rather than stacked, so tapping + ten times is one
 * entry, not ten. An entry that was already tried is never edited: it may
 * have reached the server, which would refuse the same id with another body.
 */
export async function saveCountEntry(
	ctx: StockContext,
	localId: string,
	entry: CountEntryInput,
): Promise<void> {
	await db.transaction('rw', db.stockQueue, db.stockCatalog, async () => {
		const counts = await localCounts(ctx.origin)
		const record = counts.find((count) => count.localId === localId)
		if (!record || record.status === 'sent') throw new CountClosedError()
		const waiting = await db.stockQueue
			.where('status')
			.equals('queued')
			.filter(
				(row) =>
					row.origin === ctx.origin &&
					row.kind === 'count_entry' &&
					row.attempts === 0 &&
					sameRef(row.payload.count, record.ref) &&
					row.payload.entry.itemId === entry.itemId &&
					row.payload.entry.areaId === entry.areaId,
			)
			.first()
		if (waiting && waiting.kind === 'count_entry') {
			await db.stockQueue.put({
				...waiting,
				madeBy: ctx.madeBy,
				madeAt: Date.now(),
				payload: {
					...waiting.payload,
					entry: {
						...waiting.payload.entry,
						amount: entry.amount,
						unit: entry.unit,
					},
				},
			})
		} else {
			const id = newId()
			await addRow(
				ctx,
				'count_entry',
				{
					count: record.ref,
					entry: {
						clientId: id,
						itemId: entry.itemId,
						areaId: entry.areaId,
						amount: entry.amount,
						unit: entry.unit,
					},
				},
				id,
			)
		}
		const values = await localValues(ctx.origin, localId)
		const next: CountValue = { amount: entry.amount, unit: entry.unit }
		await saveLocalValues(ctx.origin, localId, {
			...values,
			[rowKey(entry.itemId, entry.areaId)]: next,
		})
	})
}

/** "Send for review": queued after every entry, and this tablet adds nothing more to the count. */
export async function sendCount(
	ctx: StockContext,
	localId: string,
): Promise<void> {
	await db.transaction('rw', db.stockQueue, db.stockCatalog, async () => {
		const counts = await localCounts(ctx.origin)
		const record = counts.find((count) => count.localId === localId)
		if (!record || record.status === 'sent') return
		await addRow(ctx, 'count_send', { count: record.ref })
		await saveLocalCounts(
			ctx.origin,
			counts.map((count) =>
				count.localId === localId ? { ...count, status: 'sent' } : count,
			),
		)
	})
}

// ── Waste ───────────────────────────────────────────────────────────────────

export type WasteInput = {
	itemId: string
	amount: number
	unit: UnitRef
	reason: Payload<'waste'>['entry']['reason']
	note?: string
}

/** Queues one waste entry and remembers the item for the recent chips. Returns its `clientId`, for an undo. */
export async function logWaste(
	ctx: StockContext,
	input: WasteInput,
): Promise<string> {
	const id = await db.transaction(
		'rw',
		db.stockQueue,
		db.stockCatalog,
		async () => {
			const id = newId()
			await addRow(
				ctx,
				'waste',
				{
					entry: {
						clientId: id,
						locationId: ctx.locationId,
						itemId: input.itemId,
						amount: input.amount,
						unit: input.unit,
						reason: input.reason,
						...(input.note ? { note: input.note } : {}),
					},
				},
				id,
			)
			await rememberWaste(ctx.origin, input.itemId)
			return id
		},
	)
	return id
}

export type UndoOutcome = 'removed' | 'queued' | 'unknown'

/**
 * Takes a waste entry back. Still waiting here (never tried, or refused): it
 * is simply removed. Tried or sent: an undo is queued, naming the entry by its
 * `clientId` until the server's id is known (the runner swaps it in).
 * `unknown` means this tablet no longer knows the entry (too old to undo).
 */
export async function undoWaste(
	ctx: StockContext,
	wasteClientId: string,
): Promise<UndoOutcome> {
	return db.transaction(
		'rw',
		db.stockQueue,
		db.stockCatalog,
		async (): Promise<UndoOutcome> => {
			const row = await db.stockQueue.get(wasteClientId)
			if (row && row.kind === 'waste' && row.origin === ctx.origin) {
				if (
					row.status === 'failed' ||
					(row.status === 'queued' && row.attempts === 0)
				) {
					await db.stockQueue.delete(row.id)
					return 'removed'
				}
				await addRow(ctx, 'waste_undo', {
					waste: { clientId: wasteClientId },
				})
				return 'queued'
			}
			const settled = (
				await db.stockCatalog.get(wasteKey(ctx.origin, wasteClientId))
			)?.value as { id: string } | undefined
			if (!settled) return 'unknown'
			await addRow(ctx, 'waste_undo', { waste: { id: settled.id } })
			return 'queued'
		},
	)
}

// ── Deliveries ──────────────────────────────────────────────────────────────

export type DeliveryInput = Payload<'delivery'>

/** Queues a delivery and, when there is one, its invoice photo (the bytes wait in `stockBlobs`). Returns the delivery's `clientId`. */
export async function recordDelivery(
	ctx: StockContext,
	delivery: DeliveryInput,
	photo: {
		blob: Blob
		contentType: 'image/jpeg' | 'image/png' | 'image/webp'
	} | null,
): Promise<string> {
	return db.transaction(
		'rw',
		db.stockQueue,
		db.stockBlobs,
		db.stockCatalog,
		async () => {
			const row = await addRow(ctx, 'delivery', delivery)
			if (photo) {
				const blobKey = `photo:${row.id}`
				await db.stockBlobs.put({
					key: blobKey,
					blob: photo.blob,
					savedAt: Date.now(),
				})
				await addRow(ctx, 'delivery_photo', {
					delivery: { clientId: row.id },
					contentType: photo.contentType,
					sizeBytes: photo.blob.size,
					blobKey,
				})
			}
			return row.id
		},
	)
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** Every row of this restaurant, oldest first. */
export async function stockRows(origin: string): Promise<StockRow[]> {
	return (await db.stockQueue.orderBy('seq').toArray()).filter(
		(row) => row.origin === origin,
	)
}

export type StockQueueStats = {
	/** Waiting to send (including one being sent now). */
	waiting: number
	/** Refused for good and listed for the person. */
	failed: number
}

export async function stockStats(origin: string): Promise<StockQueueStats> {
	let waiting = 0
	let failed = 0
	await db.stockQueue
		.filter((row) => row.origin === origin)
		.each((row) => {
			if (row.status === 'failed') failed++
			else waiting++
		})
	return { waiting, failed }
}

// ── Running (used by `runner.ts`) ───────────────────────────────────────────

export const MAX_ENTRY_BATCH = 100
export const MAX_WASTE_BATCH = 50

/**
 * Claims the next row to send, with the rows right behind it that go in the
 * same request (consecutive entries of one count, consecutive waste). Strict
 * order: if the oldest waiting row is not due (it backs off) or another tab is
 * sending, nothing is claimed, so a newer value is never sent before an older
 * one for the same thing. `skip` kinds are passed over (a delivery waiting
 * for a manager must not hold up counts). `solo` ids go alone (a batch one of
 * them poisoned).
 */
export async function claimNext(
	origin: string,
	options: {
		now: number
		force: boolean
		skip: ReadonlySet<StationOutboxKind>
		solo: ReadonlySet<string>
	},
): Promise<StockRow[]> {
	const { now, force, skip, solo } = options
	return db.transaction('rw', db.stockQueue, async () => {
		const rows = (await db.stockQueue.orderBy('seq').toArray()).filter(
			(row) => row.origin === origin,
		)
		// A claim whose tab died goes back in line.
		for (const row of rows) {
			if (
				row.status === 'syncing' &&
				now - (row.claimedAt ?? 0) > STALE_CLAIM_MS
			) {
				row.status = 'queued'
				await db.stockQueue.update(row.id, { status: 'queued' })
			}
		}
		const open = rows.filter(
			(row) => row.status !== 'failed' && !skip.has(row.kind),
		)
		const head = open[0]
		if (!head || head.status !== 'queued') return []
		if (!force && head.nextAttemptAt !== null && head.nextAttemptAt > now)
			return []
		const batch = [head]
		const limit = head.kind === 'waste' ? MAX_WASTE_BATCH : MAX_ENTRY_BATCH
		if (
			(head.kind === 'count_entry' || head.kind === 'waste') &&
			!solo.has(head.id)
		) {
			const headRef = refOf(head)
			for (const next of open.slice(1)) {
				if (batch.length >= limit) break
				if (next.kind !== head.kind || next.status !== 'queued') break
				if (solo.has(next.id)) break
				if (!force && next.nextAttemptAt !== null && next.nextAttemptAt > now)
					break
				const nextRef = refOf(next)
				if (headRef && nextRef && !sameRef(headRef, nextRef)) break
				batch.push(next)
			}
		}
		for (const row of batch) {
			await db.stockQueue.update(row.id, {
				status: 'syncing',
				claimedAt: now,
			})
		}
		return batch.map((row) => ({
			...row,
			status: 'syncing' as const,
			claimedAt: now,
		}))
	})
}

/** The server's thing a settled row made, so rows naming it by `clientId` can name it by id. */
export type Resolved = { id: string; summary?: unknown }

/** A row went through: it leaves the queue and rows that named it by `clientId` now name its server id. */
export async function completeRow(
	row: StockRow,
	resolved: Resolved | null,
): Promise<void> {
	await db.transaction(
		'rw',
		db.stockQueue,
		db.stockCatalog,
		db.stockBlobs,
		async () => {
			await db.stockQueue.delete(row.id)
			if (resolved) {
				const all = await db.stockQueue.toArray()
				for (const other of all) {
					if (!dependsOn(other, row.id)) continue
					await db.stockQueue.put(withRef(other, { id: resolved.id }))
				}
				if (row.kind === 'waste')
					await writeKey(wasteKey(row.origin, row.id), {
						id: resolved.id,
						at: Date.now(),
					})
				if (row.kind === 'count_start') {
					const counts = await localCounts(row.origin)
					await saveLocalCounts(
						row.origin,
						counts.map((count) =>
							count.localId === row.id
								? {
										...count,
										ref: { id: resolved.id },
										joined:
											(resolved.summary as { joined?: boolean } | undefined)
												?.joined === true || count.joined,
									}
								: count,
						),
					)
				}
			}
			if (row.kind === 'delivery_photo')
				await db.stockBlobs.delete(row.payload.blobKey)
		},
	)
}

/** A row the server refused for good: it stays, marked, for the person; rows that named it fail with it. */
export async function failRow(row: StockRow, code: string): Promise<void> {
	await db.transaction('rw', db.stockQueue, db.stockCatalog, async () => {
		await db.stockQueue.update(row.id, {
			status: 'failed',
			failure: code,
			attempts: row.attempts + 1,
			claimedAt: undefined,
		})
		const all = await db.stockQueue.toArray()
		for (const other of all) {
			if (dependsOn(other, row.id) && other.status !== 'failed')
				await db.stockQueue.update(other.id, {
					status: 'failed',
					failure: 'dependency_failed',
					claimedAt: undefined,
				})
		}
		if (row.kind === 'count_start') {
			const counts = await localCounts(row.origin)
			await saveLocalCounts(
				row.origin,
				counts.map((count) =>
					count.localId === row.id ? { ...count, startFailed: code } : count,
				),
			)
		}
	})
}

/**
 * Puts claimed rows back without counting an attempt (the run stopped for a
 * reason that says nothing about them: no session, a switch, an update). The
 * code stays on the row so the person can read why it waits.
 */
export async function releaseRows(
	rows: readonly StockRow[],
	code: string | null,
): Promise<void> {
	await db.transaction('rw', db.stockQueue, async () => {
		for (const row of rows)
			await db.stockQueue.update(row.id, {
				status: 'queued',
				failure: code,
				claimedAt: undefined,
			})
	})
}

/** An outage: back off (5 s, 15 s, 1 min, 5 min, 15 min) and try again. Nothing is dropped. */
export async function deferRows(
	rows: readonly StockRow[],
	code: string,
	now: number,
): Promise<number> {
	let soonest = Infinity
	await db.transaction('rw', db.stockQueue, async () => {
		for (const row of rows) {
			const attempts = row.attempts + 1
			const at = now + stationBackoffMs(attempts)
			soonest = Math.min(soonest, at)
			await db.stockQueue.update(row.id, {
				status: 'queued',
				attempts,
				nextAttemptAt: at,
				failure: code,
				claimedAt: undefined,
			})
		}
	})
	return soonest
}

/** Failures a second try cannot help (the count closed, the entry is gone, the time to undo passed). */
const NO_RETRY = new Set([
	'count_closed',
	'wrong_location',
	'not_found',
	'undo_expired',
	'already_undone',
	'unit_mismatch',
	'reason_not_allowed',
	'idempotency_conflict',
	'invalid_request',
	'dependency_failed',
	'payload_too_large',
	'upload_not_configured',
])

export const canRetry = (code: string | null): boolean =>
	code === null || !NO_RETRY.has(code)

/** Puts a refused row (and the rows that failed because of it) back in line. */
export async function retryFailed(id: string): Promise<void> {
	await db.transaction('rw', db.stockQueue, db.stockCatalog, async () => {
		const row = await db.stockQueue.get(id)
		if (!row || row.status !== 'failed') return
		await db.stockQueue.update(id, {
			status: 'queued',
			attempts: 0,
			nextAttemptAt: null,
			failure: null,
		})
		const all = await db.stockQueue.toArray()
		for (const other of all)
			if (
				dependsOn(other, id) &&
				other.status === 'failed' &&
				other.failure === 'dependency_failed'
			)
				await db.stockQueue.update(other.id, {
					status: 'queued',
					failure: null,
					attempts: 0,
					nextAttemptAt: null,
				})
		if (row.kind === 'count_start') {
			const counts = await localCounts(row.origin)
			await saveLocalCounts(
				row.origin,
				counts.map((count) =>
					count.localId === id ? { ...count, startFailed: undefined } : count,
				),
			)
		}
	})
}

/** Removes a refused row, and what only made sense with it (a count that never started, a photo of a delivery that never came). */
export async function discardRow(id: string): Promise<void> {
	await db.transaction(
		'rw',
		db.stockQueue,
		db.stockCatalog,
		db.stockBlobs,
		async () => {
			const gone = new Set<string>()
			const visit = async (rowId: string) => {
				if (gone.has(rowId)) return
				gone.add(rowId)
				const all = await db.stockQueue.toArray()
				for (const other of all)
					if (dependsOn(other, rowId)) await visit(other.id)
			}
			await visit(id)
			for (const rowId of gone) {
				const row = await db.stockQueue.get(rowId)
				if (!row) continue
				if (row.kind === 'delivery_photo')
					await db.stockBlobs.delete(row.payload.blobKey)
				await db.stockQueue.delete(rowId)
				if (row.kind === 'count_start') {
					const counts = await localCounts(row.origin)
					await saveLocalCounts(
						row.origin,
						counts.filter((count) => count.localId !== rowId),
					)
					await db.stockCatalog.delete(`mine:${row.origin}:${rowId}`)
				}
			}
		},
	)
}

/** Everything this restaurant refused, for "Clear". */
export async function discardAllFailed(origin: string): Promise<void> {
	const failed = (await stockRows(origin)).filter(
		(row) => row.status === 'failed',
	)
	for (const row of failed) await discardRow(row.id)
}

/** Forgets everything waiting for a restaurant this tablet no longer works for (like punches, never sent to another). */
export async function wipeStock(): Promise<void> {
	await db.transaction(
		'rw',
		db.stockQueue,
		db.stockCatalog,
		db.stockBlobs,
		async () => {
			await db.stockQueue.clear()
			await db.stockBlobs.clear()
			await db.stockCatalog.clear()
		},
	)
}
