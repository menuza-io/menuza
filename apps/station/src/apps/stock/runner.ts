import { classifyStationFailure, type StationOutboxKind } from '@repo/inventory'
import { create } from 'zustand'
import { StockApiError, type StockApi } from './api.ts'
import { pruneLocal } from './local.ts'
import {
	claimNext,
	completeRow,
	deferRows,
	failRow,
	refOf,
	releaseRows,
	stockRows,
	type Resolved,
} from './queue.ts'
import { db, type StockRow } from '~/lib/db.ts'

/**
 * Sends the Stock outbox: oldest first, one request per row (consecutive count
 * entries and consecutive waste entries share a request). What each answer
 * means is the contract's `classifyStationFailure`:
 *
 * - `permanent`: the row is marked failed and shown to the person; go on.
 * - `pause`: stop and keep every row, waiting for a person (sign in, a
 *   manager, an update, a switch turned back on).
 * - `retry`: an outage. Back off (`stationBackoffMs`) and stop; nothing is
 *   ever dropped.
 * - `unpair`: the terminal was removed or is not recognised; stop.
 *
 * One deviation from "pause stops the run": `receive_needs_manager` only
 * holds deliveries, so a cashier's counts and waste still go out while a
 * delivery waits for a manager to sign in.
 */

export type StockSyncState = {
	running: boolean
	/** The code that stopped the last run for a person to fix (shown in plain words), or null. */
	paused: string | null
	/** The last outage's code, while the outbox backs off. */
	error: string | null
	/** When the outbox tries again by itself. */
	retryAt: number | null
	lastSentAt: number | null
}

export const useStockSync = create<StockSyncState>(() => ({
	running: false,
	paused: null,
	error: null,
	retryAt: null,
	lastSentAt: null,
}))

export type FlushDeps = {
	api: StockApi
	origin: string
	/** The signed-in person has a server session (an online sign-in). */
	hasSession: boolean
	online: boolean
	/** Demo mode: the in-memory region answers, so the browser's connection does not matter. */
	demo?: boolean
	/** Try everything now, ignoring backoff ("Try now"). */
	force?: boolean
	now?: () => number
	/** The server says this terminal was removed. */
	onUnpaired?: () => void
	/** The server does not recognise this terminal (not necessarily removed). */
	onUnrecognised?: () => void
}

export type FlushResult = { sent: number; paused: string | null }

let running = false

type Outcome =
	| { row: StockRow; kind: 'done'; resolved: Resolved | null }
	| { row: StockRow; kind: 'failed'; code: string }
	| { row: StockRow; kind: 'again' }

const countId = (row: StockRow): string | null => {
	const ref = refOf(row)
	return ref && 'id' in ref ? ref.id : null
}

/** Sends one claimed batch. Throws `StockApiError` when the request itself failed. */
async function sendBatch(batch: StockRow[], api: StockApi): Promise<Outcome[]> {
	const head = batch[0]!
	const envelope = (row: StockRow) => ({
		madeBy: row.madeBy ?? undefined,
		madeAt: row.madeAt,
	})
	switch (head.kind) {
		case 'count_start': {
			const result = await api.startCount({
				clientId: head.id,
				locationId: head.locationId,
				listId: head.payload.listId,
				...envelope(head),
			})
			return [
				{
					row: head,
					kind: 'done',
					resolved: { id: result.count.id, summary: result },
				},
			]
		}
		case 'count_entry': {
			const id = countId(head)
			if (!id) return batch.map((row) => failed(row, 'dependency_failed'))
			const result = await api.countEntries(id, {
				entries: batch.flatMap((row) =>
					row.kind === 'count_entry'
						? [{ ...row.payload.entry, ...envelope(row) }]
						: [],
				),
			})
			const accepted = new Set([
				...result.accepted.map((entry) => entry.clientId),
				...result.duplicates,
			])
			const refused = new Map(
				result.refused.map((entry) => [entry.clientId, entry.code]),
			)
			return batch.map((row): Outcome => {
				if (accepted.has(row.id)) return { row, kind: 'done', resolved: null }
				const code = refused.get(row.id)
				return code ? failed(row, code) : { row, kind: 'again' }
			})
		}
		case 'count_send': {
			const id = countId(head)
			if (!id) return [failed(head, 'dependency_failed')]
			await api.sendCount(id, { clientId: head.id, ...envelope(head) })
			return [{ row: head, kind: 'done', resolved: null }]
		}
		case 'waste': {
			const result = await api.waste({
				entries: batch.flatMap((row) =>
					row.kind === 'waste'
						? [{ ...row.payload.entry, ...envelope(row) }]
						: [],
				),
			})
			const ids = new Map<string, string>([
				...result.accepted.map((entry) => [entry.clientId, entry.id] as const),
				...result.duplicates.map(
					(entry) => [entry.clientId, entry.id] as const,
				),
			])
			const refused = new Map(
				result.refused.map((entry) => [entry.clientId, entry.code]),
			)
			return batch.map((row): Outcome => {
				const id = ids.get(row.id)
				if (id) return { row, kind: 'done', resolved: { id } }
				const code = refused.get(row.id)
				return code ? failed(row, code) : { row, kind: 'again' }
			})
		}
		case 'waste_undo': {
			const id = countId(head)
			if (!id) return [failed(head, 'dependency_failed')]
			await api.undoWaste(id, { clientId: head.id })
			return [{ row: head, kind: 'done', resolved: null }]
		}
		case 'delivery': {
			const result = await api.delivery({
				...head.payload,
				clientId: head.id,
				locationId: head.locationId,
				...envelope(head),
			})
			return [
				{
					row: head,
					kind: 'done',
					resolved: { id: result.id, summary: result },
				},
			]
		}
		case 'delivery_photo': {
			const id = countId(head)
			if (!id) return [failed(head, 'dependency_failed')]
			const stored = await db.stockBlobs.get(head.payload.blobKey)
			if (!stored) return [failed(head, 'invalid_request')]
			// Five tries with a fresh upload target each (a signed link may have expired), then give up on the photo.
			if (head.attempts >= 5) return [failed(head, 'upload_failed')]
			const upload = await api.photoRequest(id, {
				contentType: head.payload.contentType,
				sizeBytes: stored.blob.size,
			})
			await api.putPhoto(upload, stored.blob)
			await api.photoConfirm(id, { key: upload.key })
			return [{ row: head, kind: 'done', resolved: null }]
		}
	}
}

const failed = (row: StockRow, code: string): Outcome => ({
	row,
	kind: 'failed',
	code,
})

/** Sends everything that is due. Safe to call from several places: one run at a time. */
export async function flushStock(deps: FlushDeps): Promise<FlushResult> {
	const state = useStockSync
	if (running) return { sent: 0, paused: state.getState().paused }
	if (
		!deps.demo &&
		typeof navigator !== 'undefined' &&
		navigator.onLine === false
	)
		return { sent: 0, paused: state.getState().paused }
	if (!deps.online) return { sent: 0, paused: state.getState().paused }
	running = true
	state.setState({ running: true })
	const clock = deps.now ?? (() => Date.now())
	let sent = 0
	let paused: string | null = null
	let error: string | null = null
	let retryAt: number | null = null
	const skip = new Set<StationOutboxKind>()
	const solo = new Set<string>()
	try {
		await pruneLocal(clock()).catch(() => {})
		if (!deps.hasSession) {
			const waiting = (await stockRows(deps.origin)).some(
				(row) => row.status !== 'failed',
			)
			paused = waiting ? 'staff_session_required' : null
			return { sent, paused }
		}
		for (;;) {
			const batch = await claimNext(deps.origin, {
				now: clock(),
				force: deps.force ?? false,
				skip,
				solo,
			})
			if (batch.length === 0) break
			let outcomes: Outcome[]
			try {
				outcomes = await sendBatch(batch, deps.api)
			} catch (failure) {
				const code =
					failure instanceof StockApiError ? failure.code : 'connection_lost'
				const status = failure instanceof StockApiError ? failure.status : 0
				const action = classifyStationFailure({ status, code })
				if (action === 'permanent') {
					// One bad entry must not refuse its neighbours: try them one by one.
					if (batch.length > 1 && code === 'invalid_request') {
						for (const row of batch) solo.add(row.id)
						await releaseRows(batch, null)
						continue
					}
					for (const row of batch) await failRow(row, code)
					continue
				}
				if (action === 'pause') {
					if (code === 'receive_needs_manager') {
						skip.add('delivery')
						skip.add('delivery_photo')
						await releaseRows(batch, code)
						continue
					}
					await releaseRows(batch, code)
					paused = code
					break
				}
				if (action === 'unpair') {
					await releaseRows(batch, code)
					paused = code
					if (code === 'device_revoked') deps.onUnpaired?.()
					else deps.onUnrecognised?.()
					break
				}
				retryAt = await deferRows(batch, code, clock())
				error = code
				break
			}
			for (const outcome of outcomes) {
				if (outcome.kind === 'done') {
					await completeRow(outcome.row, outcome.resolved)
					sent++
				} else if (outcome.kind === 'failed') {
					await failRow(outcome.row, outcome.code)
				} else {
					retryAt = await deferRows([outcome.row], 'invalid_response', clock())
					error = 'invalid_response'
				}
			}
			if (error) break
		}
		return { sent, paused }
	} finally {
		running = false
		state.setState({
			running: false,
			paused,
			error,
			retryAt,
			...(sent > 0 ? { lastSentAt: clock() } : {}),
		})
	}
}
