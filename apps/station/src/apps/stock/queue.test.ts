import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type StationOutboxKind } from '@repo/inventory'
import { localCounts, localValues, saveLocalCounts } from './local.ts'
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
	clampMadeAt,
	completeRow,
	deferRows,
	laneOf,
	MADE_AT_FUTURE_MS,
	MADE_AT_PAST_MS,
	newClientId,
} from './queue.ts'
import { ctx, ORIGIN, resetStock } from './testing.ts'
import { useClock } from '~/lib/clock.ts'
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

	it('continues the count of the same list instead of starting two; "I am done" does not close it, a finished count refuses entries', async () => {
		const first = await startCount(ctx, { id: 'list_weekly', name: 'Weekly' })
		const again = await startCount(ctx, { id: 'list_weekly', name: 'Weekly' })
		expect(again.localId).toBe(first.localId)
		expect(
			(await stockRows(ORIGIN)).filter((row) => row.kind === 'count_start'),
		).toHaveLength(1)
		await sendCount(ctx, first.localId)
		// The count stays open on this tablet: late entries are still taken.
		expect((await localCounts(ORIGIN))[0]).toMatchObject({
			status: 'counting',
			done: expect.any(Number),
		})
		await saveCountEntry(ctx, first.localId, {
			itemId: 'a',
			areaId: null,
			amount: 1,
			unit: 'kg',
		})
		// Saying it twice queues one note.
		await sendCount(ctx, first.localId)
		expect(
			(await stockRows(ORIGIN)).filter((row) => row.kind === 'count_send'),
		).toHaveLength(1)
		// A manager finished it in the App: nothing more goes in.
		const [record] = await localCounts(ORIGIN)
		await saveLocalCounts(ORIGIN, [{ ...record!, serverStatus: 'approved' }])
		await expect(
			saveCountEntry(ctx, first.localId, {
				itemId: 'b',
				areaId: null,
				amount: 1,
				unit: 'kg',
			}),
		).rejects.toBeInstanceOf(CountClosedError)
	})

	it('does not continue a count the manager is already reviewing: the region makes a new one', async () => {
		const first = await startCount(ctx, { id: 'list_weekly', name: 'Weekly' })
		const [record] = await localCounts(ORIGIN)
		await saveLocalCounts(ORIGIN, [{ ...record!, serverStatus: 'in_review' }])
		const next = await startCount(ctx, { id: 'list_weekly', name: 'Weekly' })
		expect(next.localId).not.toBe(first.localId)
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

	it('batches the consecutive entries of one count lane, whatever waste waits between them', async () => {
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
			'count_entry',
		])
		expect(batch.every((row) => row.status === 'syncing')).toBe(true)
		// Another tab sending the counts lane holds that lane only: the waste still goes.
		const next = await claimNext(ORIGIN, claimOptions({ now: 1_000_010 }))
		expect(next.map((row) => row.kind)).toEqual(['waste'])
		expect(await claimNext(ORIGIN, claimOptions({ now: 1_000_020 }))).toEqual(
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

const entryRows = async () =>
	(await stockRows(ORIGIN)).flatMap((row) =>
		row.kind === 'count_entry'
			? [{ ...row.payload.entry, seq: row.seq, id: row.id, status: row.status }]
			: [],
	)
const settled = async (...ids: string[]) => {
	for (const id of ids) {
		const row = await db.stockQueue.get(id)
		await completeRow(row!, null)
	}
}

describe('switching a row’s unit (one live entry per unit at the region, and they add up)', () => {
	async function joined() {
		const record = await startCount(ctx, { id: null, name: null })
		const [start] = await stockRows(ORIGIN)
		await completeRow(start!, { id: 'cnt_1' })
		return record
	}
	const box = { itemId: 'oil', areaId: 'a1', unit: 'unit:box' } as const

	it('after the first entry was SENT, clears the old unit before the new entry', async () => {
		const record = await joined()
		await saveCountEntry(ctx, record.localId, { ...box, amount: 2 })
		const [sent] = await entryRows()
		await settled(sent!.id)
		expect(await entryRows()).toEqual([])

		await saveCountEntry(ctx, record.localId, {
			itemId: 'oil',
			areaId: 'a1',
			amount: 20,
			unit: 'l',
		})
		const rows = await entryRows()
		expect(rows.map((row) => [row.unit, row.amount])).toEqual([
			['unit:box', null],
			['l', 20],
		])
		expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq)
		// Both go in one request, in that order.
		const batch = await claimNext(ORIGIN, claimOptions())
		expect(
			batch.map((row) =>
				row.kind === 'count_entry'
					? [row.payload.entry.unit, row.payload.entry.amount]
					: null,
			),
		).toEqual([
			['unit:box', null],
			['l', 20],
		])
	})

	it('clearing a row clears every unit that may be live, not only the one shown', async () => {
		const record = await joined()
		await saveCountEntry(ctx, record.localId, { ...box, amount: 2 })
		await settled((await entryRows())[0]!.id)
		await saveCountEntry(ctx, record.localId, {
			itemId: 'oil',
			areaId: 'a1',
			amount: 20,
			unit: 'l',
		})
		await settled(...(await entryRows()).map((row) => row.id))
		await saveCountEntry(ctx, record.localId, {
			itemId: 'oil',
			areaId: 'a1',
			amount: null,
			unit: 'l',
		})
		expect((await entryRows()).map((row) => [row.unit, row.amount])).toEqual([
			['l', null],
		])
	})

	it('switching back and forth leaves the region with the last unit only', async () => {
		const record = await joined()
		await saveCountEntry(ctx, record.localId, { ...box, amount: 2 })
		await settled((await entryRows())[0]!.id)
		const litres = {
			itemId: 'oil',
			areaId: 'a1',
			amount: 20,
			unit: 'l',
		} as const
		await saveCountEntry(ctx, record.localId, litres)
		await saveCountEntry(ctx, record.localId, { ...box, amount: 2 })
		const live = new Map<string, number | null>()
		for (const row of await entryRows()) live.set(row.unit, row.amount)
		// Litres were never sent, so they are cleared; the box count is the live one.
		expect(live.get('l')).toBeNull()
		expect(live.get('unit:box')).toBe(2)
	})

	it('an unsent entry is replaced by the clear, and a joined count’s earlier unit is known from the screen', async () => {
		const record = await joined()
		await saveCountEntry(ctx, record.localId, { ...box, amount: 2 })
		await saveCountEntry(ctx, record.localId, {
			itemId: 'oil',
			areaId: 'a1',
			amount: 20,
			unit: 'l',
		})
		expect((await entryRows()).map((row) => [row.unit, row.amount])).toEqual([
			['unit:box', null],
			['l', 20],
		])
		// Another device typed kg: this tablet only knows it from the sheet.
		await saveCountEntry(
			ctx,
			record.localId,
			{ itemId: 'rice', areaId: null, amount: 3, unit: 'piece' },
			{ knownUnits: ['kg'] },
		)
		expect(
			(await entryRows())
				.filter((row) => row.id && row.unit !== 'unit:box' && row.unit !== 'l')
				.map((row) => [row.unit, row.amount]),
		).toEqual([
			['kg', null],
			['piece', 3],
		])
	})

	it('"Add another unit" keeps the other unit’s entry live (2 boxes and 3 kg)', async () => {
		const record = await joined()
		await saveCountEntry(ctx, record.localId, { ...box, amount: 2 })
		await settled((await entryRows())[0]!.id)
		await saveCountEntry(
			ctx,
			record.localId,
			{ itemId: 'oil', areaId: 'a1', amount: 3, unit: 'kg' },
			{ keepUnits: ['unit:box'], knownUnits: ['unit:box'] },
		)
		expect((await entryRows()).map((row) => [row.unit, row.amount])).toEqual([
			['kg', 3],
		])
		// The main line then changes: the added line's kg stays too.
		await saveCountEntry(
			ctx,
			record.localId,
			{ ...box, amount: 4 },
			{ keepUnits: ['kg'], knownUnits: ['unit:box', 'kg'] },
		)
		const live = (await entryRows()).map((row) => [row.unit, row.amount])
		expect(live).toContainEqual(['unit:box', 4])
		expect(live).not.toContainEqual(['kg', null])
	})
})

describe('lanes', () => {
	it('a photo backing off never holds counts, waste or the next delivery', async () => {
		await recordDelivery(
			ctx,
			{
				supplierId: 's',
				invoiceNumber: null,
				lines: [{ itemId: 'a', quantity: 1000 }],
			},
			{ blob: new Blob(['x']), contentType: 'image/jpeg' },
		)
		const [delivery, photo] = await stockRows(ORIGIN)
		await completeRow(delivery!, { id: 'dlv_1' })
		await deferRows([photo!], 'photo_unreachable', 1_000_000)
		const record = await startCount(ctx, { id: null, name: null })
		const [, start] = await stockRows(ORIGIN)
		await completeRow(start!, { id: 'cnt_1' })
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
				supplierId: 's',
				invoiceNumber: null,
				lines: [{ itemId: 'b', quantity: 1000 }],
			},
			null,
		)
		const skipped = new Set<StationOutboxKind>()
		const sent: string[] = []
		for (;;) {
			const batch = await claimNext(ORIGIN, claimOptions({ skip: skipped }))
			if (batch.length === 0) break
			sent.push(batch[0]!.kind)
			for (const row of batch) await completeRow(row, { id: `srv_${row.id}` })
		}
		expect(sent.sort()).toEqual(['count_entry', 'delivery', 'waste'])
		// The photo is still there, waiting its turn.
		expect((await stockRows(ORIGIN)).map((row) => row.kind)).toEqual([
			'delivery_photo',
		])
	})

	it('a delivery that keeps failing holds only its own lane', async () => {
		await recordDelivery(
			ctx,
			{
				supplierId: 's',
				invoiceNumber: null,
				lines: [{ itemId: 'a', quantity: 1000 }],
			},
			null,
		)
		await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		const [delivery] = await stockRows(ORIGIN)
		await deferRows([delivery!], 'internal_error', 1_000_000)
		const batch = await claimNext(ORIGIN, claimOptions())
		expect(batch.map((row) => row.kind)).toEqual(['waste'])
		// Its own lane waits until due.
		await completeRow(batch[0]!, { id: 'wst_1' })
		expect(await claimNext(ORIGIN, claimOptions())).toEqual([])
		const later = await claimNext(
			ORIGIN,
			claimOptions({ now: 1_000_000 + 5_000 }),
		)
		expect(later.map((row) => row.id)).toEqual([delivery!.id])
	})

	it('a photo waits until the delivery it names has settled', async () => {
		await recordDelivery(
			ctx,
			{
				supplierId: 's',
				invoiceNumber: null,
				lines: [{ itemId: 'a', quantity: 1000 }],
			},
			{ blob: new Blob(['x']), contentType: 'image/jpeg' },
		)
		const [delivery] = await stockRows(ORIGIN)
		// The delivery is being sent by another tab: the photo must not jump the queue.
		await db.stockQueue.update(delivery!.id, {
			status: 'syncing',
			claimedAt: 1_000_000,
		})
		expect(await claimNext(ORIGIN, claimOptions({ now: 1_000_010 }))).toEqual(
			[],
		)
		await completeRow({ ...delivery!, status: 'syncing' }, { id: 'dlv_1' })
		const [next] = await claimNext(ORIGIN, claimOptions())
		expect(next).toMatchObject({
			kind: 'delivery_photo',
			payload: { delivery: { id: 'dlv_1' } },
		})
	})

	it('every kind has a lane, within a lane rows keep their order', async () => {
		expect(
			(['count_start', 'count_entry', 'count_send'] as const).map(laneOf),
		).toEqual(['counts', 'counts', 'counts'])
		expect(laneOf('waste_undo')).toBe(laneOf('waste'))
		expect(laneOf('delivery_photo')).not.toBe(laneOf('delivery'))
	})
})

describe('when things were made', () => {
	afterEach(() => useClock.setState({ skewMs: null }))

	it('stamps rows with the server’s time, not a tablet clock that is days behind', async () => {
		useClock.setState({ skewMs: 3 * 24 * 3_600_000 })
		const before = Date.now()
		await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		const [row] = await stockRows(ORIGIN)
		expect(row!.madeAt).toBeGreaterThanOrEqual(before + 3 * 24 * 3_600_000)
		expect(row!.madeAt).toBeLessThan(Date.now() + 3 * 24 * 3_600_000 + 1_000)
	})

	it('clamps what is sent to what the region accepts, once, and keeps it for retries', async () => {
		const now = 1_800_000_000_000
		expect(clampMadeAt(now - 30 * 24 * 3_600_000, now)).toBe(
			now - MADE_AT_PAST_MS,
		)
		expect(clampMadeAt(now + 3_600_000, now)).toBe(now + MADE_AT_FUTURE_MS)
		expect(clampMadeAt(now - 1_000, now)).toBe(now - 1_000)

		await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		await db.stockQueue.toCollection().modify({ madeAt: 5 })
		const [claimed] = await claimNext(ORIGIN, claimOptions())
		expect(claimed!.madeAt).toBeGreaterThan(
			Date.now() - MADE_AT_PAST_MS - 5_000,
		)
		expect((await stockRows(ORIGIN))[0]!.madeAt).toBe(claimed!.madeAt)
		// A retry repeats exactly what the first try sent (the region hashes the body).
		await deferRows([claimed!], 'connection_lost', 0)
		const [again] = await claimNext(ORIGIN, claimOptions({ force: true }))
		expect(again!.madeAt).toBe(claimed!.madeAt)
	})
})

describe('a double tap', () => {
	it('records a delivery made before the tap once', async () => {
		const id = newClientId()
		const delivery = {
			supplierId: null,
			invoiceNumber: null,
			lines: [{ itemId: 'a', quantity: 1000 }],
		}
		await Promise.all([
			recordDelivery(ctx, delivery, null, id),
			recordDelivery(ctx, delivery, null, id),
		])
		expect((await stockRows(ORIGIN)).map((row) => row.id)).toEqual([id])
	})

	it('logs waste made before the tap once', async () => {
		const id = newClientId()
		const entry = {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		} as const
		const results = await Promise.all([
			logWaste(ctx, entry, id),
			logWaste(ctx, entry, id),
		])
		expect(results).toEqual([id, id])
		expect(await stockRows(ORIGIN)).toHaveLength(1)
	})
})
