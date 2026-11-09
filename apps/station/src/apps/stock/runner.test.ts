import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StockApiError } from './api.ts'
import { localCounts } from './local.ts'
import {
	logWaste,
	recordDelivery,
	saveCountEntry,
	sendCount,
	startCount,
	stockRows,
	undoWaste,
} from './queue.ts'
import { flushStock, useStockSync, type FlushDeps } from './runner.ts'
import { ctx, fakeApi, ORIGIN, resetStock } from './testing.ts'
import { db } from '~/lib/db.ts'

const NOW = 2_000_000
const deps = (
	over: Partial<FlushDeps> & Pick<FlushDeps, 'api'>,
): FlushDeps => ({
	origin: ORIGIN,
	hasSession: true,
	online: true,
	now: () => NOW,
	...over,
})
const entry = (itemId: string, amount: number | null = 1) => ({
	itemId,
	areaId: null,
	amount,
	unit: 'kg' as const,
})

beforeEach(resetStock)

describe('sending the Stock outbox', () => {
	it('sends a count started offline in order, resolving the start’s clientId to the server id', async () => {
		const record = await startCount(ctx, { id: 'list_weekly', name: 'Weekly' })
		await saveCountEntry(ctx, record.localId, entry('item_tomato', 2.5))
		await saveCountEntry(ctx, record.localId, entry('item_oil', 3))
		await sendCount(ctx, record.localId)
		const api = fakeApi()
		const result = await flushStock(deps({ api }))
		expect(result).toEqual({ sent: 4, paused: null })
		expect(api.calls.map((call) => call.name)).toEqual([
			'startCount',
			'countEntries',
			'sendCount',
		])
		const [start, entries, send] = api.calls
		expect(start!.args[0]).toMatchObject({
			clientId: record.localId,
			locationId: 'main',
			listId: 'list_weekly',
			madeBy: 'stf_ana',
		})
		// The entries and the send name the count by the id the start returned.
		expect(entries!.args[0]).toBe('cnt_1')
		expect(
			(
				entries!.args[1] as {
					entries: Array<{ itemId: string; madeBy: string }>
				}
			).entries,
		).toMatchObject([
			{ itemId: 'item_tomato', madeBy: 'stf_ana' },
			{ itemId: 'item_oil', madeBy: 'stf_ana' },
		])
		expect(send!.args[0]).toBe('cnt_1')
		expect(await stockRows(ORIGIN)).toEqual([])
		expect((await localCounts(ORIGIN))[0]).toMatchObject({
			ref: { id: 'cnt_1' },
			status: 'sent',
		})
	})

	it('sends each entry with its own clientId and the time it was made, so a replay is harmless', async () => {
		const record = await startCount(ctx, { id: null, name: null })
		await saveCountEntry(ctx, record.localId, entry('a'))
		const rows = await stockRows(ORIGIN)
		const api = fakeApi()
		await flushStock(deps({ api }))
		const body = api.calls[1]!.args[1] as {
			entries: Array<{ clientId: string; madeAt: number }>
		}
		expect(body.entries[0]!.clientId).toBe(rows[1]!.id)
		expect(body.entries[0]!.madeAt).toBe(rows[1]!.madeAt)
	})

	it('stops at an outage with every row kept, backs off, and resumes in order without a duplicate', async () => {
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
				lines: [{ itemId: 'a', quantity: 1000 }],
			},
			null,
		)
		const down = fakeApi({
			async waste() {
				throw new StockApiError('service_unavailable', 503)
			},
		})
		const first = await flushStock(deps({ api: down }))
		expect(first.sent).toBe(0)
		expect(await stockRows(ORIGIN)).toHaveLength(2)
		const state = useStockSync.getState()
		expect(state).toMatchObject({
			error: 'service_unavailable',
			retryAt: NOW + 5_000,
		})
		// Not due yet: nothing is tried.
		const quiet = fakeApi()
		await flushStock(deps({ api: quiet }))
		expect(quiet.calls).toEqual([])
		// Due: waste first, then the delivery.
		const up = fakeApi()
		const second = await flushStock(deps({ api: up, now: () => NOW + 5_001 }))
		expect(second.sent).toBe(2)
		expect(up.calls.map((call) => call.name)).toEqual(['waste', 'delivery'])
		expect(await stockRows(ORIGIN)).toEqual([])
		expect(useStockSync.getState()).toMatchObject({ error: null, paused: null })
	})

	it('treats a dropped connection like an outage', async () => {
		await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		const api = fakeApi({
			async waste() {
				throw new StockApiError('connection_lost')
			},
		})
		await flushStock(deps({ api }))
		expect((await stockRows(ORIGIN))[0]).toMatchObject({
			status: 'queued',
			attempts: 1,
			failure: 'connection_lost',
		})
	})

	it('waits for a person to sign in: no request without a session, rows kept', async () => {
		await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		const api = fakeApi()
		const result = await flushStock(deps({ api, hasSession: false }))
		expect(result).toEqual({ sent: 0, paused: 'staff_session_required' })
		expect(api.calls).toEqual([])
		expect(await stockRows(ORIGIN)).toHaveLength(1)
		// With nothing waiting there is nothing to wait for.
		await db.stockQueue.clear()
		expect(await flushStock(deps({ api, hasSession: false }))).toEqual({
			sent: 0,
			paused: null,
		})
	})

	it.each([
		['staff_session_invalid', 401],
		['inventory_not_enabled', 403],
		['inventory_disabled', 403],
		['inventory_unavailable', 503],
		['pos_disabled', 503],
		['contract_too_old', 400],
	])(
		'pauses on %s: nothing is dropped and no attempt is counted',
		async (code, status) => {
			await logWaste(ctx, {
				itemId: 'a',
				amount: 1,
				unit: 'kg',
				reason: 'spoiled',
			})
			const api = fakeApi({
				async waste() {
					throw new StockApiError(code, status)
				},
			})
			const result = await flushStock(deps({ api }))
			expect(result).toEqual({ sent: 0, paused: code })
			expect((await stockRows(ORIGIN))[0]).toMatchObject({
				status: 'queued',
				attempts: 0,
				failure: code,
			})
			expect(useStockSync.getState().paused).toBe(code)
			// It tries again the next run (a person fixed it).
			const fixed = fakeApi()
			expect((await flushStock(deps({ api: fixed }))).sent).toBe(1)
		},
	)

	it('a delivery that needs a manager waits while counts and waste still go', async () => {
		await recordDelivery(
			ctx,
			{
				supplierId: 's',
				invoiceNumber: null,
				lines: [{ itemId: 'a', quantity: 1000 }],
			},
			{
				blob: new Blob(['x'], { type: 'image/jpeg' }),
				contentType: 'image/jpeg',
			},
		)
		await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		const api = fakeApi({
			async delivery() {
				throw new StockApiError('receive_needs_manager', 403)
			},
		})
		const result = await flushStock(deps({ api }))
		expect(result).toEqual({ sent: 1, paused: null })
		expect((await stockRows(ORIGIN)).map((row) => row.kind)).toEqual([
			'delivery',
			'delivery_photo',
		])
		// The manager signs in.
		const manager = fakeApi()
		await flushStock(deps({ api: manager }))
		expect(manager.calls.map((call) => call.name)).toEqual([
			'delivery',
			'photoRequest',
			'putPhoto',
			'photoConfirm',
		])
		expect(await stockRows(ORIGIN)).toEqual([])
	})

	it('a count closed while offline fails its entries for good and is listed, the next row still goes', async () => {
		const record = await startCount(ctx, { id: null, name: null })
		await saveCountEntry(ctx, record.localId, entry('a'))
		await saveCountEntry(ctx, record.localId, entry('b'))
		await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		const api = fakeApi({
			async countEntries() {
				throw new StockApiError('count_closed', 409)
			},
		})
		const result = await flushStock(deps({ api }))
		expect(result.sent).toBe(2)
		expect(
			(await stockRows(ORIGIN)).map((row) => [
				row.kind,
				row.status,
				row.failure,
			]),
		).toEqual([
			['count_entry', 'failed', 'count_closed'],
			['count_entry', 'failed', 'count_closed'],
		])
	})

	it('entries the region refuses one by one fail alone; accepted and duplicate ones settle', async () => {
		const record = await startCount(ctx, { id: null, name: null })
		for (const id of ['a', 'b', 'c'])
			await saveCountEntry(ctx, record.localId, entry(id))
		const rows = await stockRows(ORIGIN)
		const api = fakeApi({
			async countEntries() {
				return {
					accepted: [{ clientId: rows[1]!.id, quantity: 1000 }],
					duplicates: [rows[3]!.id],
					refused: [{ clientId: rows[2]!.id, code: 'unit_mismatch' }],
				}
			},
		})
		await flushStock(deps({ api }))
		expect(
			(await stockRows(ORIGIN)).map((row) => [row.status, row.failure]),
		).toEqual([['failed', 'unit_mismatch']])
	})

	it('a bad request in a batch is retried one by one, so one bad entry does not refuse its neighbours', async () => {
		const record = await startCount(ctx, { id: null, name: null })
		for (const id of ['a', 'b', 'c'])
			await saveCountEntry(ctx, record.localId, entry(id))
		let bad = ''
		const api = fakeApi({
			async countEntries(id, body) {
				const entries = (
					body as { entries: Array<{ itemId: string; clientId: string }> }
				).entries
				if (entries.some((e) => e.itemId === 'b')) {
					bad = entries.length === 1 ? 'single' : 'batch'
					throw new StockApiError('invalid_request', 400)
				}
				void id
				return {
					accepted: entries.map((e) => ({ clientId: e.clientId, quantity: 1 })),
					duplicates: [],
					refused: [],
				}
			},
		})
		await flushStock(deps({ api }))
		expect(bad).toBe('single')
		expect(
			(await stockRows(ORIGIN)).map((row) => [
				row.kind,
				row.status,
				row.failure,
			]),
		).toEqual([['count_entry', 'failed', 'invalid_request']])
	})

	it('a refused start fails the count and everything queued for it, and the person is told', async () => {
		const record = await startCount(ctx, { id: null, name: null })
		await saveCountEntry(ctx, record.localId, entry('a'))
		await sendCount(ctx, record.localId)
		const api = fakeApi({
			async startCount() {
				throw new StockApiError('wrong_location', 403)
			},
		})
		await flushStock(deps({ api }))
		expect((await stockRows(ORIGIN)).map((row) => row.failure)).toEqual([
			'wrong_location',
			'dependency_failed',
			'dependency_failed',
		])
		expect((await localCounts(ORIGIN))[0]!.startFailed).toBe('wrong_location')
	})

	it('batches waste into one request and remembers the server ids for an undo', async () => {
		const ids: string[] = []
		for (const item of ['a', 'b', 'c'])
			ids.push(
				await logWaste(ctx, {
					itemId: item,
					amount: 1,
					unit: 'kg',
					reason: 'spoiled',
				}),
			)
		const api = fakeApi()
		await flushStock(deps({ api }))
		expect(api.calls.map((call) => call.name)).toEqual(['waste'])
		expect(
			(api.calls[0]!.args[0] as { entries: unknown[] }).entries,
		).toHaveLength(3)
		expect(await undoWaste(ctx, ids[1]!)).toBe('queued')
		const undo = fakeApi()
		await flushStock(deps({ api: undo }))
		expect(undo.calls[0]).toMatchObject({ name: 'undoWaste' })
		expect(undo.calls[0]!.args[0]).toMatch(/^wst_/)
		expect(
			(undo.calls[0]!.args[1] as { clientId: string }).clientId,
		).toBeTruthy()
	})

	it('an undo queued behind a waste entry that was tried goes after it with the server id', async () => {
		const id = await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		const down = fakeApi({
			async waste() {
				throw new StockApiError('internal_error', 500)
			},
		})
		await flushStock(deps({ api: down }))
		expect(await undoWaste(ctx, id)).toBe('queued')
		const up = fakeApi()
		await flushStock(deps({ api: up, now: () => NOW + 10_000 }))
		expect(up.calls.map((call) => call.name)).toEqual(['waste', 'undoWaste'])
		expect(up.calls[1]!.args[0]).toBe('wst_1')
	})

	it('uploads an invoice photo through the region’s own storage, then confirms it', async () => {
		await recordDelivery(
			ctx,
			{
				supplierId: 's',
				invoiceNumber: 'INV-1',
				lines: [{ itemId: 'a', quantity: 1000 }],
			},
			{
				blob: new Blob(['jpeg-bytes'], { type: 'image/jpeg' }),
				contentType: 'image/jpeg',
			},
		)
		const api = fakeApi()
		await flushStock(deps({ api }))
		const names = api.calls.map((call) => call.name)
		expect(names).toEqual([
			'delivery',
			'photoRequest',
			'putPhoto',
			'photoConfirm',
		])
		expect(api.calls[1]!.args).toEqual([
			'dlv_1',
			{ contentType: 'image/jpeg', sizeBytes: 10 },
		])
		expect(api.calls[3]!.args).toEqual([
			'dlv_1',
			{ key: 'inventory-invoices/org/dlv/abc.jpg' },
		])
		expect(await db.stockBlobs.count()).toBe(0)
	})

	it('a photo the node cannot store is refused for good and the delivery stays recorded', async () => {
		await recordDelivery(
			ctx,
			{
				supplierId: 's',
				invoiceNumber: null,
				lines: [{ itemId: 'a', quantity: 1000 }],
			},
			{
				blob: new Blob(['x'], { type: 'image/jpeg' }),
				contentType: 'image/jpeg',
			},
		)
		const api = fakeApi({
			async photoRequest() {
				throw new StockApiError('upload_not_configured', 503)
			},
		})
		// 503 is an outage by status, but the code says what it is: a refusal of the photo only.
		await flushStock(deps({ api }))
		const rows = await stockRows(ORIGIN)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			kind: 'delivery_photo',
			status: 'failed',
			failure: 'upload_not_configured',
		})
	})

	it('gives up on a photo after five uploads that fail, never on the delivery', async () => {
		await recordDelivery(
			ctx,
			{
				supplierId: 's',
				invoiceNumber: null,
				lines: [{ itemId: 'a', quantity: 1000 }],
			},
			{
				blob: new Blob(['x'], { type: 'image/jpeg' }),
				contentType: 'image/jpeg',
			},
		)
		const api = fakeApi({
			async putPhoto() {
				throw new StockApiError('connection_lost')
			},
		})
		let clock = NOW
		for (let i = 0; i < 7; i++) {
			clock += 20 * 60_000
			await flushStock(deps({ api, now: () => clock }))
		}
		expect((await stockRows(ORIGIN))[0]).toMatchObject({
			kind: 'delivery_photo',
			status: 'failed',
			failure: 'upload_failed',
		})
	})

	it('a removed terminal stops the run and says so, keeping the rows', async () => {
		await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		const onUnpaired = vi.fn()
		const onUnrecognised = vi.fn()
		const api = fakeApi({
			async waste() {
				throw new StockApiError('device_revoked', 401)
			},
		})
		await flushStock(deps({ api, onUnpaired, onUnrecognised }))
		expect(onUnpaired).toHaveBeenCalledTimes(1)
		expect(onUnrecognised).not.toHaveBeenCalled()
		expect(await stockRows(ORIGIN)).toHaveLength(1)
		const unknown = fakeApi({
			async waste() {
				throw new StockApiError('invalid_device', 401)
			},
		})
		await flushStock(deps({ api: unknown, onUnpaired, onUnrecognised }))
		expect(onUnrecognised).toHaveBeenCalledTimes(1)
	})

	it('does nothing offline and runs one at a time', async () => {
		await logWaste(ctx, {
			itemId: 'a',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
		})
		const offline = fakeApi()
		expect((await flushStock(deps({ api: offline, online: false }))).sent).toBe(
			0,
		)
		expect(offline.calls).toEqual([])
		let release = () => {}
		let started = false
		const slow = fakeApi({
			waste: () =>
				new Promise((resolve) => {
					started = true
					release = () =>
						resolve({ accepted: [], duplicates: [], refused: [], lateSync: [] })
				}),
		})
		const run = flushStock(deps({ api: slow }))
		await vi.waitFor(() => expect(started).toBe(true))
		expect(useStockSync.getState().running).toBe(true)
		const second = await flushStock(deps({ api: fakeApi() }))
		expect(second.sent).toBe(0)
		release()
		await run
	})
})
