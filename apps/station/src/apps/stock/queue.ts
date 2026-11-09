import {
	STATION_QUEUE_LIMIT,
	stationBackoffMs,
	type StationOutboxItem,
	type StationOutboxKind,
	type StationRef,
	type UnitRef,
} from '@repo/inventory'
import {
	isFinished,
	localCounts,
	localLiveUnits,
	localValues,
	rememberWaste,
	saveLiveUnits,
	saveLocalCounts,
	saveLocalValues,
	wasteKey,
	writeKey,
	type LocalCount,
} from './local.ts'
import { rowKey, type CountValue } from './model.ts'
import { serverNow } from '~/lib/clock.ts'
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

const newId = (): string => crypto.randomUUID()

/** The region ignores a `madeAt` further back than this, or further ahead than the next one. */
export const MADE_AT_PAST_MS = 7 * 24 * 3_600_000
export const MADE_AT_FUTURE_MS = 5 * 60_000

/**
 * When something was made, for the region: `madeAt` is stamped with the
 * server's time as best known (the tablet's clock corrected by the offset the
 * answers' `Date` headers gave) and clamped again when it is first sent, the
 * way the region clamps it: a tablet with a wrong clock never books a count or
 * waste into the wrong business day.
 */
export function clampMadeAt(madeAt: number, now = serverNow()): number {
	return Math.min(
		Math.max(madeAt, now - MADE_AT_PAST_MS),
		now + MADE_AT_FUTURE_MS,
	)
}

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
		now: serverNow(),
	})
	await db.stockQueue.add(row)
	return row
}

// ── Counts ──────────────────────────────────────────────────────────────────

/**
 * Starts a count of `listId` (null: everything) on this tablet. A count of
 * the same list already open here is continued instead (two taps never make
 * two); one the manager is already reviewing is not, the region makes a new
 * one. The start waits in the outbox; the count can be worked on at once.
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
					(count.serverStatus ?? 'counting') === 'counting' &&
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
		super('count_finished')
		this.name = 'CountClosedError'
	}
}

export type CountEntryInput = {
	itemId: string
	areaId: string | null
	amount: number | null
	unit: UnitRef
}

export type SaveCountOptions = {
	/**
	 * Units of this row's other lines (the "Add another unit" lines: "2 boxes
	 * and 3 kg"). Their entries stay; every other unit's live entry is cleared.
	 */
	keepUnits?: readonly UnitRef[]
	/** Units this tablet showed an amount in before this change (earlier entries of a count joined from another device). */
	knownUnits?: readonly UnitRef[]
	/** What the row shows afterwards, when that is more than this entry (the other lines of the row). */
	display?: CountValue
}

/**
 * Saves what was typed in one row of a count: the value is remembered for the
 * screen and entries are queued. The region keeps one live entry per item,
 * area and UNIT and adds them up, so a row whose unit was switched (or
 * cleared) must not leave the old unit's entry live: a clear (`amount: null`)
 * for every other live unit is queued first, then the entry for this unit
 * (`keepUnits` names the units of the row's other lines, which stay). An entry
 * for the same row and unit still waiting (never tried) is replaced rather
 * than stacked, so tapping + ten times is one entry, not ten. An entry that
 * was already tried is never edited: it may have reached the server, which
 * would refuse the same id with another body.
 */
export async function saveCountEntry(
	ctx: StockContext,
	localId: string,
	entry: CountEntryInput,
	options: SaveCountOptions = {},
): Promise<void> {
	await db.transaction('rw', db.stockQueue, db.stockCatalog, async () => {
		const counts = await localCounts(ctx.origin)
		const record = counts.find((count) => count.localId === localId)
		if (!record || isFinished(record)) throw new CountClosedError()
		const key = rowKey(entry.itemId, entry.areaId)
		const liveMap = await localLiveUnits(ctx.origin, localId)
		const keep = new Set<UnitRef>(options.keepUnits ?? [])
		const waiting = (
			await db.stockQueue
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
				.toArray()
		).flatMap((row) => (row.kind === 'count_entry' ? [row] : []))
		const live = new Set<UnitRef>([
			...(liveMap[key] ?? []),
			...(options.knownUnits ?? []),
			...waiting.map((row) => row.payload.entry.unit),
		])
		const stale = [...live].filter(
			(unit) => unit !== entry.unit && !keep.has(unit),
		)
		const now = serverNow()

		// Clear the units this row no longer uses, before the new entry.
		for (const unit of stale) {
			const waits = waiting.find((row) => row.payload.entry.unit === unit)
			if (waits) {
				await db.stockQueue.put({
					...waits,
					madeBy: ctx.madeBy,
					madeAt: now,
					payload: {
						...waits.payload,
						entry: { ...waits.payload.entry, amount: null },
					},
				})
				continue
			}
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
						amount: null,
						unit,
					},
				},
				id,
			)
		}

		const sameUnit = waiting.find(
			(row) => row.payload.entry.unit === entry.unit,
		)
		if (sameUnit && stale.length === 0) {
			await db.stockQueue.put({
				...sameUnit,
				madeBy: ctx.madeBy,
				madeAt: now,
				payload: {
					...sameUnit.payload,
					entry: { ...sameUnit.payload.entry, amount: entry.amount },
				},
			})
		} else {
			// Never tried, so the region has never heard of it: it can go. The new entry then queues after the clears above.
			if (sameUnit) await db.stockQueue.delete(sameUnit.id)
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

		const nextLive = new Set<UnitRef>(
			[...live].filter((unit) => keep.has(unit) && unit !== entry.unit),
		)
		if (entry.amount !== null) nextLive.add(entry.unit)
		await saveLiveUnits(ctx.origin, localId, {
			...liveMap,
			[key]: [...nextLive],
		})
		const values = await localValues(ctx.origin, localId)
		const next: CountValue = options.display ?? {
			amount: entry.amount,
			unit: entry.unit,
		}
		await saveLocalValues(ctx.origin, localId, { ...values, [key]: next })
	})
}

/**
 * "I'm done counting": a per-device note, queued after every entry (the
 * region answers the same whenever it is repeated). It does not close the
 * count, here or at the region: a manager finishes it in the App, and entries
 * are still taken until then. Tapping it again while the note waits adds
 * nothing.
 */
export async function sendCount(
	ctx: StockContext,
	localId: string,
): Promise<void> {
	await db.transaction('rw', db.stockQueue, db.stockCatalog, async () => {
		const counts = await localCounts(ctx.origin)
		const record = counts.find((count) => count.localId === localId)
		if (!record || isFinished(record)) return
		const pending = await db.stockQueue
			.filter(
				(row) =>
					row.origin === ctx.origin &&
					row.kind === 'count_send' &&
					row.status !== 'failed' &&
					sameRef(row.payload.count, record.ref),
			)
			.count()
		if (pending === 0) await addRow(ctx, 'count_send', { count: record.ref })
		await saveLocalCounts(
			ctx.origin,
			counts.map((count) =>
				count.localId === localId ? { ...count, done: Date.now() } : count,
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

/**
 * Queues one waste entry and remembers the item for the recent chips. Returns
 * its `clientId`, for an undo. The `clientId` can be made before the tap
 * (`newClientId`): a second call with the same one (a double tap) queues
 * nothing and answers the same id.
 */
export async function logWaste(
	ctx: StockContext,
	input: WasteInput,
	clientId?: string,
): Promise<string> {
	const id = await db.transaction(
		'rw',
		db.stockQueue,
		db.stockCatalog,
		async () => {
			const id = clientId ?? newId()
			if (clientId && (await db.stockQueue.get(clientId))) return id
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

/** A fresh id for a row, to make before the tap that queues it. */
export const newClientId = newId

/**
 * Queues a delivery and, when there is one, its invoice photo (the bytes wait
 * in `stockBlobs`). Returns the delivery's `clientId`. With a `clientId` made
 * before the tap, a second call (a double tap) queues nothing more.
 */
export async function recordDelivery(
	ctx: StockContext,
	delivery: DeliveryInput,
	photo: {
		blob: Blob
		contentType: 'image/jpeg' | 'image/png' | 'image/webp'
	} | null,
	clientId?: string,
): Promise<string> {
	return db.transaction(
		'rw',
		db.stockQueue,
		db.stockBlobs,
		db.stockCatalog,
		async () => {
			if (clientId && (await db.stockQueue.get(clientId))) return clientId
			const row = await addRow(ctx, 'delivery', delivery, clientId)
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
 * The outbox has one lane per kind of work. Rows go oldest first WITHIN a lane
 * (a value is never sent before an older one for the same thing), but a lane
 * that waits (backing off, or stuck on a row) never holds up the others: a
 * photo that cannot upload, or a delivery the region keeps answering 500 to,
 * must not stop a cook's counts and waste from going out.
 */
export type Lane = 'counts' | 'waste' | 'delivery' | 'photo'

export const LANE_KINDS: Record<Lane, readonly StationOutboxKind[]> = {
	counts: ['count_start', 'count_entry', 'count_send'],
	waste: ['waste', 'waste_undo'],
	delivery: ['delivery'],
	photo: ['delivery_photo'],
}

export const laneOf = (kind: StationOutboxKind): Lane =>
	(Object.keys(LANE_KINDS) as Lane[]).find((lane) =>
		LANE_KINDS[lane].includes(kind),
	)!

/**
 * Claims the next row to send, with the rows right behind it in its lane that
 * go in the same request (consecutive entries of one count, consecutive
 * waste). The lane whose oldest waiting row is due and was queued first goes
 * first; a lane whose oldest row is not due (it backs off), is being sent by
 * another tab or waits for the row it names (a photo before its delivery
 * settled) is passed over. `skip` kinds are passed over too (a delivery
 * waiting for a manager must not hold up counts). `solo` ids go alone (a
 * batch one of them poisoned).
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
		const ids = new Set(rows.map((row) => row.id))
		// A row naming another row by `clientId` waits until that row has settled (the ref is then rewritten to the server's id).
		const waitsForRow = (row: StockRow) => {
			const ref = refOf(row)
			return ref !== null && 'clientId' in ref && ids.has(ref.clientId)
		}
		let head: StockRow | undefined
		let lane: StockRow[] = []
		for (const name of Object.keys(LANE_KINDS) as Lane[]) {
			const inLane = open.filter((row) => laneOf(row.kind) === name)
			const first = inLane[0]
			if (!first || first.status !== 'queued') continue
			if (!force && first.nextAttemptAt !== null && first.nextAttemptAt > now)
				continue
			if (waitsForRow(first)) continue
			if (!head || first.seq < head.seq) {
				head = first
				lane = inLane
			}
		}
		if (!head) return []
		const batch = [head]
		const limit = head.kind === 'waste' ? MAX_WASTE_BATCH : MAX_ENTRY_BATCH
		if (
			(head.kind === 'count_entry' || head.kind === 'waste') &&
			!solo.has(head.id)
		) {
			const headRef = refOf(head)
			for (const next of lane.slice(1)) {
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
		// A row's time is fixed the first time it is sent (the region hashes the body: a later try must repeat it), clamped to what the region accepts.
		const sent = batch.map((row) => ({
			...row,
			status: 'syncing' as const,
			claimedAt: now,
			madeAt: row.attempts === 0 ? clampMadeAt(row.madeAt) : row.madeAt,
		}))
		for (const row of sent) {
			await db.stockQueue.update(row.id, {
				status: 'syncing',
				claimedAt: now,
				madeAt: row.madeAt,
			})
		}
		return sent
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
	'item_unknown',
	'item_archived',
	'area_unknown',
	'quantity_invalid',
	'duplicate',
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
