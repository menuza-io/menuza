import 'fake-indexeddb/auto'
import {
	stationCatalogSchema,
	stationCountEntriesResultSchema,
	stationCountSheetSchema,
	stationDeliveryResultSchema,
	stationOutboxItemSchema,
	stationPhotoUploadSchema,
	stationStartCountResultSchema,
	stationWasteResultSchema,
} from '@repo/inventory'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDemoStockApi } from './demo.ts'
import catalogFixture from './fixtures/catalog.json'
import countEntries from './fixtures/count-entries.json'
import countSheet from './fixtures/count-sheet.json'
import delivery from './fixtures/delivery.json'
import photoUpload from './fixtures/photo-upload.json'
import startCount from './fixtures/start-count.json'
import waste from './fixtures/waste.json'
import {
	logWaste,
	recordDelivery,
	saveCountEntry,
	sendCount,
	startCount as begin,
	stockRows,
	undoWaste,
	deferRows,
} from './queue.ts'
import { ctx, ORIGIN, resetStock } from './testing.ts'

beforeEach(resetStock)

describe('the recorded answers still match the contract', () => {
	it.each([
		['catalog', stationCatalogSchema, catalogFixture],
		['start count', stationStartCountResultSchema, startCount],
		['count sheet', stationCountSheetSchema, countSheet],
		['count entries', stationCountEntriesResultSchema, countEntries],
		['waste', stationWasteResultSchema, waste],
		['delivery', stationDeliveryResultSchema, delivery],
		['photo upload', stationPhotoUploadSchema, photoUpload],
	])('%s', (_name, schema, fixture) => {
		expect(schema.safeParse(fixture).success).toBe(true)
	})

	it('carries no money, supplier contact or stock figure anywhere in the catalogue', () => {
		const keys = new Set<string>()
		const walk = (value: unknown) => {
			if (Array.isArray(value)) value.forEach(walk)
			else if (value && typeof value === 'object')
				for (const [key, inner] of Object.entries(value)) {
					keys.add(key)
					walk(inner)
				}
		}
		walk(catalogFixture)
		const forbidden = [...keys].filter((key) =>
			/(Minor|Micro)$|^currency$|^(cost|price(?!dByWeight)|onHand|lastCount|phone|email|whatsapp|contact)/i.test(
				key,
			),
		)
		expect(forbidden).toEqual([])
		expect(keys.size).toBeGreaterThan(30)
	})
})

describe('every row the tablet queues is a row of the contract’s outbox', () => {
	it('parses with `stationOutboxItemSchema`', async () => {
		const record = await begin(ctx, { id: 'list_weekly', name: 'Weekly' })
		await saveCountEntry(ctx, record.localId, {
			itemId: 'item_tomato',
			areaId: 'area_walkin',
			amount: 2.5,
			unit: 'kg',
		})
		await sendCount(ctx, record.localId)
		const id = await logWaste(ctx, {
			itemId: 'item_tomato',
			amount: 1,
			unit: 'kg',
			reason: 'spoiled',
			note: 'left out',
		})
		const [, , , waste] = await stockRows(ORIGIN)
		await deferRows([waste!], 'connection_lost', 0)
		await undoWaste(ctx, id)
		await recordDelivery(
			ctx,
			{
				supplierId: 'sup_fresh',
				orderId: 'ord_41',
				closeOrder: true,
				invoiceNumber: 'A-1',
				lines: [
					{
						itemId: 'item_tomato',
						supplierProductId: 'sp_tomato_crate',
						quantity: 12_000_000,
						packs: 2,
						packName: 'Crate 6 kg',
						packBaseQuantity: 6_000_000,
						realWeightQuantity: null,
						orderLineId: 'ol_1',
					},
				],
			},
			{ blob: new Blob(['x']), contentType: 'image/jpeg' },
		)
		const rows = await stockRows(ORIGIN)
		expect(rows.map((row) => row.kind)).toEqual([
			'count_start',
			'count_entry',
			'count_send',
			'waste',
			'waste_undo',
			'delivery',
			'delivery_photo',
		])
		for (const row of rows) {
			const parsed = stationOutboxItemSchema.safeParse(row)
			expect(
				parsed.success,
				`${row.kind}: ${JSON.stringify(parsed.error?.issues)}`,
			).toBe(true)
		}
	})
})

describe('demo mode answers in the contract’s shapes', () => {
	it('starts, joins and sends a count, and takes waste and a delivery, with nothing leaving the tab', async () => {
		const api = createDemoStockApi()
		const answer = await api.catalog('demo', null)
		expect(
			answer.status === 'ok' &&
				stationCatalogSchema.safeParse(answer.catalog).success,
		).toBe(true)
		const first = await api.startCount({
			clientId: 'start-0001-aaaa',
			locationId: 'demo',
			listId: 'demo_weekly',
		})
		expect(stationStartCountResultSchema.safeParse(first).success).toBe(true)
		expect(first.joined).toBe(false)
		const again = await api.startCount({
			clientId: 'start-0002-bbbb',
			locationId: 'demo',
			listId: 'demo_weekly',
		})
		expect(again).toMatchObject({ joined: true, count: { id: first.count.id } })
		const entries = await api.countEntries(first.count.id, {
			entries: [
				{
					clientId: 'entry-0001-aaaa',
					itemId: 'demo_tomato',
					areaId: null,
					amount: 2,
					unit: 'kg',
				},
			],
		})
		expect(stationCountEntriesResultSchema.safeParse(entries).success).toBe(
			true,
		)
		const reopened = await api.catalog('demo', null)
		expect(
			reopened.status === 'ok' && reopened.catalog.counts[0]?.itemsCounted,
		).toBe(1)
		const sent = await api.sendCount(first.count.id, {
			clientId: 'send-0001-aaaa',
		})
		expect(sent.status).toBe('in_review')
		const wasted = await api.waste({
			entries: [
				{
					clientId: 'waste-0001-aaaa',
					locationId: 'demo',
					itemId: 'demo_tomato',
					amount: 1,
					unit: 'kg',
					reason: 'spoiled',
				},
			],
		})
		expect(stationWasteResultSchema.safeParse(wasted).success).toBe(true)
		const received = await api.delivery({
			clientId: 'deliv-0001-aaaa',
			locationId: 'demo',
			supplierId: 'demo_supplier',
			lines: [{ itemId: 'demo_tomato', quantity: 6_000_000 }],
		})
		expect(stationDeliveryResultSchema.safeParse(received).success).toBe(true)
	})
})
