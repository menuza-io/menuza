import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { localCounts, localValues } from './local.ts'
import {
	canRetry,
	CountClosedError,
	discardRow,
	failRow,
	logWaste,
	recordDelivery,
	retryFailed,
	saveCountEntry,
	sendCount,
	startCount,
	stockRows,
	stockStats,
	undoWaste,
	wipeStock,
	claimNext,
	completeRow,
	deferRows,
} from './queue.ts'
import { ctx, ORIGIN, resetStock } from './testing.ts'
import { db } from '~/lib/db.ts'

const claimOptions = (
	over: Partial<Parameters<typeof claimNext>[1]> = {},
): Parameters<typeof claimNext>[1] => ({
	now: 1_000_000,
	force: false,
	skip: new Set(),
	solo: new Set(),
	...over,
})

beforeEach(resetStock)

describe('the Stock outbox', () => {
	it('keeps rows in the order they were made, even within one millisecond', async () => {
		const record = await startCount(ctx, { id: 'list_weekly', name: 'Weekly' })
		for (const amount of [1, 2, 3])
			await saveCountEntry(ctx, record.localId, {
				itemId: `item_${amount}`,
				areaId: null,
				amount,
				unit: 'kg',
			})
		await sendCount(ctx, record.localId)
		const kinds = (await stockRows(ORIGIN)).map((row) => row.kind)
		expect(kinds).toEqual([
			'count_start',
			'count_entry',
			'count_entry',
			'count_entry',
			'count_send',
		])
		const seqs = (await stockRows(ORIGIN)).map((row) => row.seq)
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
		expect(new Set(seqs).size).toBe(seqs.length)
	})

	it('names a count started offline by the clientId of its start, until the server answers', async () => {
		const record = await startCount(ctx, { id: null, name: null })
		expect(record.ref).toEqual({ clientId: record.localId })
		await saveCountEntry(ctx, record.localId, {
			itemId: 'item_tomato',
			areaId: 'area_walkin',
			amount: 2.5,
			unit: 'kg',
		})
		const [start, entry] = await stockRows(ORIGIN)
		expect(entry).toMatchObject({
			kind: 'count_entry',
			payload: { count: { clientId: start!.id } },
		})
		// The entry's own id is the entry's clientId (the idempotency key).
		expect(entry!.kind === 'count_entry' && entry!.payload.entry.clientId).toBe(
			entry!.id,
		)
	})

	it('settling the start swaps its clientId for the server id in every row that named it, and in the count', async () => {
		const record = await startCount(ctx, { id: null, name: null })
		await saveCountEntry(ctx, record.localId, {
			itemId: 'a',
			areaId: null,
			amount: 1,
			unit: 'kg',
		})
		await sendCount(ctx, record.localId)
		const [start] = await stockRows(ORIGIN)
		await completeRow(start!, { id: 'cnt_77', summary: { joined: true } })
		const rest = await stockRows(ORIGIN)
		expect(rest.map((row) => row.kind)).toEqual(['count_entry', 'count_send'])
		for (const row of rest)
			expect(
				row.kind === 'count_entry'
					? row.payload.count
					: row.kind === 'count_send'
						? row.payload.count
						: null,
			).toEqual({ id: 'cnt_77' })
		const [local] = await localCounts(ORIGIN)
		expect(local).toMatchObject({ ref: { id: 'cnt_77' }, joined: true })
	})

	it('replaces an entry that never left instead of stacking taps, and never edits one that was tried', async () => {
		const record = await startCount(ctx, { id: null, name: null })
		const entry = (amount: number | null) => ({
			itemId: 'item_tomato',
			areaId: null,
			amount,
			unit: 'kg' as const,
		})
		for (const amount of [1, 2, 3, 4])
			await saveCountEntry(ctx, record.localId, entry(amount))
		let rows = (await stockRows(ORIGIN)).filter(
			(row) => row.kind === 'count_entry',
		)
		expect(rows).toHaveLength(1)
		expect(
			rows[0]!.kind === 'count_entry' && rows[0]!.payload.entry.amount,
		).toBe(4)

		// Tried once (the answer may have been lost): the same id must keep the same body.
		await deferRows([rows[0]!], 'connection_lost', 1_000)
		await saveCountEntry(ctx, record.localId, entry(5))
		rows = (await stockRows(ORIGIN)).filter((row) => row.kind === 'count_entry')
		expect(rows).toHaveLength(2)
		expect(
			rows[0]!.kind === 'count_entry' && rows[0]!.payload.entry.amount,
		).toBe(4)
		expect(
			rows[1]!.kind === 'count_entry' && rows[1]!.payload.entry.amount,
		).toBe(5)
		expect(rows[0]!.id).not.toBe(rows[1]!.id)
	})

	it('keeps rows for different items and areas apart, and remembers what was typed for the screen', async () => {
		const record = await startCount(ctx, { id: null, name: null })
		await saveCountEntry(ctx, record.localId, {
			itemId: 'x',
			areaId: 'a1',
			amount: 1,
			unit: 'kg',
		})
		await saveCountEntry(ctx, record.localId, {
			itemId: 'x',
			areaId: 'a2',
			amount: 2,
			unit: 'l',
		})
		await saveCountEntry(ctx, record.localId, {
			itemId: 'x',
			areaId: 'a2',
			amount: null,
			unit: 'l',
		})
		expect(
			(await stockRows(ORIGIN)).filter((row) => row.kind === 'count_entry'),
		).toHaveLength(2)
		expect(await localValues(ORIGIN, record.localId)).toEqual({
			'x|a1': { amount: 1, unit: 'kg' },
			'x|a2': { amount: null, unit: 'l' },
		})
	})

	it('continues the count of the same list instead of starting two, and refuses entries after send', async () => {
		const first = await startCount(ctx, { id: 'list_weekly', name: 'Weekly' })
		const again = await startCount(ctx, { id: 'list_weekly', name: 'Weekly' })
		expect(again.localId).toBe(first.localId)
		expect(
			(await stockRows(ORIGIN)).filter((row) => row.kind === 'count_start'),
		).toHaveLength(1)
		await sendCount(ctx, first.localId)
		await expect(
			saveCountEntry(ctx, first.localId, {
				itemId: 'a',
				areaId: null,
				amount: 1,
				unit: 'kg',
			}),
		).rejects.toBeInstanceOf(CountClosedError)
		// Sending twice queues one send.
		await sendCount(ctx, first.localId)
		expect(
			(await stockRows(ORIGIN)).filter((row) => row.kind === 'count_send'),
		).toHaveLength(1)
	})

	it('survives a reload: closing and reopening the database loses nothing', async () => {
		const record = await startCount(ctx, { id: null, name: null })
		await saveCountEntry(ctx, record.localId, {
			itemId: 'a',
			areaId: null,
			amount: 1,
			unit: 'kg',
		})
		await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		await recordDelivery(
			ctx,
			{
				supplierId: 'sup',
				invoiceNumber: null,
				lines: [{ itemId: 'a', quantity: 1000 }],
			},
			{
				blob: new Blob(['x'], { type: 'image/jpeg' }),
				contentType: 'image/jpeg',
			},
		)
		const before = await stockRows(ORIGIN)
		db.close()
		await db.open()
		expect(await stockRows(ORIGIN)).toEqual(before)
		expect(await localCounts(ORIGIN)).toHaveLength(1)
		expect(await db.stockBlobs.count()).toBe(1)
		expect(await stockStats(ORIGIN)).toEqual({ waiting: 5, failed: 0 })
	})

	it('only counts and sends rows for its own restaurant', async () => {
		await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		await logWaste(
			{ ...ctx, origin: 'https://other.test|other' },
			{ itemId: 'b', amount: 1, unit: 'kg', reason: 'spoiled' },
		)
		expect(await stockStats(ORIGIN)).toEqual({ waiting: 1, failed: 0 })
		expect(await stockRows(ORIGIN)).toHaveLength(1)
		await wipeStock()
		expect(await db.stockQueue.count()).toBe(0)
	})
})

describe('waste and undo', () => {
	it('an undo of waste still waiting here is just removing it', async () => {
		const id = await logWaste(ctx, {
			itemId: 'a',
			amount: 2,
			unit: 'kg',
			reason: 'expired',
			note: 'walk-in',
		})
		expect(await undoWaste(ctx, id)).toBe('removed')
		expect(await stockRows(ORIGIN)).toEqual([])
	})

	it('an undo of waste that was already tried is queued by clientId, then by server id once it settles', async () => {
		const id = await logWaste(ctx, {
			itemId: 'a',
			amount: 2,
			unit: 'kg',
			reason: 'expired',
		})
		const [waste] = await stockRows(ORIGIN)
		await deferRows([waste!], 'connection_lost', 1_000)
		expect(await undoWaste(ctx, id)).toBe('queued')
		const [, undo] = await stockRows(ORIGIN)
		expect(undo).toMatchObject({
			kind: 'waste_undo',
			payload: { waste: { clientId: id } },
		})
		await completeRow(waste!, { id: 'wst_9' })
		const [after] = await stockRows(ORIGIN)
		expect(after).toMatchObject({ payload: { waste: { id: 'wst_9' } } })
	})

	it('an undo after the waste was sent uses the server id remembered for a while', async () => {
		const id = await logWaste(ctx, {
			itemId: 'a',
			amount: 2,
			unit: 'kg',
			reason: 'expired',
		})
		const [waste] = await stockRows(ORIGIN)
		await completeRow(waste!, { id: 'wst_4' })
		expect(await undoWaste(ctx, id)).toBe('queued')
		expect(await stockRows(ORIGIN)).toMatchObject([
			{ kind: 'waste_undo', payload: { waste: { id: 'wst_4' } } },
		])
		expect(await undoWaste(ctx, 'never-seen-id-0000')).toBe('unknown')
	})
})

describe('claiming rows', () => {
	it('sends strictly oldest first: a row backing off holds the ones behind it', async () => {
		const a = await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		await logWaste(ctx, {
			itemId: 'b',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		const [first] = await stockRows(ORIGIN)
		await deferRows([first!], 'connection_lost', 1_000_000)
		expect(await claimNext(ORIGIN, claimOptions())).toEqual([])
		const later = await claimNext(
			ORIGIN,
			claimOptions({ now: 1_000_000 + 5_000 }),
		)
		expect(later.map((row) => row.id)).toContain(a)
		// A person tapping Try now does not wait.
		await resetClaims()
		const forced = await claimNext(ORIGIN, claimOptions({ force: true }))
		expect(forced.length).toBeGreaterThan(0)
	})

	it('batches consecutive count entries of one count, but not across another kind', async () => {
		const record = await startCount(ctx, { id: null, name: null })
		const [start] = await stockRows(ORIGIN)
		await completeRow(start!, { id: 'cnt_1' })
		for (const item of ['a', 'b', 'c'])
			await saveCountEntry(ctx, record.localId, {
				itemId: item,
				areaId: null,
				amount: 1,
				unit: 'kg',
			})
		await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		await saveCountEntry(ctx, record.localId, {
			itemId: 'd',
			areaId: null,
			amount: 1,
			unit: 'kg',
		})
		const batch = await claimNext(ORIGIN, claimOptions())
		expect(batch.map((row) => row.kind)).toEqual([
			'count_entry',
			'count_entry',
			'count_entry',
		])
		expect(batch.every((row) => row.status === 'syncing')).toBe(true)
		// Another tab sending holds the line.
		expect(await claimNext(ORIGIN, claimOptions({ now: 1_000_010 }))).toEqual(
			[],
		)
	})

	it('takes back a claim whose tab died', async () => {
		await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		const first = await claimNext(ORIGIN, claimOptions())
		expect(first).toHaveLength(1)
		const retaken = await claimNext(
			ORIGIN,
			claimOptions({ now: 1_000_000 + 25_000 }),
		)
		expect(retaken.map((row) => row.id)).toEqual(first.map((row) => row.id))
	})

	it('backs off 5 s, 15 s, 1 min, 5 min, 15 min and never gives up', async () => {
		await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		const waits: number[] = []
		for (let i = 0; i < 7; i++) {
			const [row] = await stockRows(ORIGIN)
			const at = await deferRows([row!], 'service_unavailable', 0)
			waits.push(at)
		}
		expect(waits).toEqual([
			5_000, 15_000, 60_000, 300_000, 900_000, 900_000, 900_000,
		])
		expect((await stockRows(ORIGIN))[0]).toMatchObject({
			status: 'queued',
			attempts: 7,
			failure: 'service_unavailable',
		})
	})
})

async function resetClaims() {
	await db.stockQueue.toCollection().modify({ status: 'queued' })
}

describe('permanent failures', () => {
	it('keeps a refused row, marked, and fails the rows that named it', async () => {
		const record = await startCount(ctx, { id: null, name: null })
		await saveCountEntry(ctx, record.localId, {
			itemId: 'a',
			areaId: null,
			amount: 1,
			unit: 'kg',
		})
		const [start] = await stockRows(ORIGIN)
		await failRow(start!, 'not_found')
		const rows = await stockRows(ORIGIN)
		expect(rows.map((row) => [row.kind, row.status, row.failure])).toEqual([
			['count_start', 'failed', 'not_found'],
			['count_entry', 'failed', 'dependency_failed'],
		])
		expect((await localCounts(ORIGIN))[0]).toMatchObject({
			startFailed: 'not_found',
		})
		expect(await stockStats(ORIGIN)).toEqual({ waiting: 0, failed: 2 })
		// A failed row never holds up newer work.
		await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		expect(await claimNext(ORIGIN, claimOptions())).toHaveLength(1)
	})

	it('trying again puts the row and what depended on it back; removing takes the dependents too', async () => {
		const record = await startCount(ctx, { id: null, name: null })
		await saveCountEntry(ctx, record.localId, {
			itemId: 'a',
			areaId: null,
			amount: 1,
			unit: 'kg',
		})
		const [start] = await stockRows(ORIGIN)
		await failRow(start!, 'service_unavailable')
		expect(canRetry('service_unavailable')).toBe(true)
		expect(canRetry('count_closed')).toBe(false)
		await retryFailed(start!.id)
		expect((await stockRows(ORIGIN)).map((row) => row.status)).toEqual([
			'queued',
			'queued',
		])
		expect((await localCounts(ORIGIN))[0]!.startFailed).toBeUndefined()

		await failRow((await stockRows(ORIGIN))[0]!, 'not_found')
		await discardRow(start!.id)
		expect(await stockRows(ORIGIN)).toEqual([])
		expect(await localCounts(ORIGIN)).toEqual([])
		expect(await localValues(ORIGIN, record.localId)).toEqual({})
	})

	it('removing a delivery takes its photo and the photo bytes', async () => {
		await recordDelivery(
			ctx,
			{
				supplierId: 'sup',
				invoiceNumber: '42',
				lines: [{ itemId: 'a', quantity: 1000 }],
			},
			{
				blob: new Blob(['x'], { type: 'image/jpeg' }),
				contentType: 'image/jpeg',
			},
		)
		const [delivery, photo] = await stockRows(ORIGIN)
		expect(photo).toMatchObject({
			kind: 'delivery_photo',
			payload: {
				delivery: { clientId: delivery!.id },
				contentType: 'image/jpeg',
			},
		})
		expect(await db.stockBlobs.count()).toBe(1)
		await failRow(delivery!, 'invalid_request')
		await discardRow(delivery!.id)
		expect(await stockRows(ORIGIN)).toEqual([])
		expect(await db.stockBlobs.count()).toBe(0)
	})
})
