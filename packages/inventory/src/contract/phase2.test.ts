import { describe, expect, test } from 'vitest'
import {
	confirmDeliveryPricesSchema,
	createOrderSchema,
	creditMessageRequestSchema,
	INVENTORY_NOTIFY_KINDS,
	inventoryNotifyDedupeKey,
	inventoryNotifyEventSchema,
	inventoryTickAnswerSchema,
	inventoryTickRequestSchema,
	invoicePhotoRequestSchema,
	listOrdersQuerySchema,
	orderLineInputSchema,
	priceAlertsQuerySchema,
	putLevelsSchema,
	recordDeliverySchema,
	recordDeliveryResultSchema,
	sendOrderSchema,
	updateOrderSchema,
} from './index.ts'

const delivery = {
	clientId: 'client-0001',
	locationId: 'main',
	supplierId: 'sup_1',
	currency: 'SAR',
	lines: [{ itemId: 'it_1', quantity: 10_000_000, lineTotalMinor: 28_000 }],
}

describe('record delivery (phase 1 callers keep working)', () => {
	test('the phase 1 request still parses, with defaults for the new fields', () => {
		const parsed = recordDeliverySchema.parse(delivery)
		expect(parsed.paid).toBe(false)
		expect(parsed.quantityOnly).toBeUndefined()
		expect(parsed.orderId).toBeUndefined()
	})

	test('a priced delivery still needs a currency and every line total', () => {
		const { currency: ignoredCurrency, ...noCurrency } = delivery
		expect(recordDeliverySchema.safeParse(noCurrency).success).toBe(false)
		expect(
			recordDeliverySchema.safeParse({
				...delivery,
				lines: [{ itemId: 'it_1', quantity: 1000 }],
			}).success,
		).toBe(false)
	})

	test('a quantity-only delivery needs no currency and carries no money', () => {
		const quantityOnly = {
			clientId: 'client-0002',
			locationId: 'main',
			supplierId: null,
			quantityOnly: true,
			lines: [{ itemId: 'it_1', quantity: 5_000_000 }],
		}
		expect(recordDeliverySchema.safeParse(quantityOnly).success).toBe(true)
		for (const money of [
			{ vatMinor: 100 },
			{ totalMinor: 100 },
			{ paid: true },
			{ lines: [{ itemId: 'it_1', quantity: 1000, lineTotalMinor: 5 }] },
			{ lines: [{ itemId: 'it_1', quantity: 1000, packPriceMinor: 5 }] },
		]) {
			expect(
				recordDeliverySchema.safeParse({ ...quantityOnly, ...money }).success,
			).toBe(false)
		}
	})

	test('receiving against an order', () => {
		const result = recordDeliverySchema.safeParse({
			...delivery,
			orderId: 'ord_1',
			closeOrder: true,
			lines: [
				{
					itemId: 'it_1',
					quantity: 8_000_000,
					lineTotalMinor: 22_400,
					orderLineId: 'ol_1',
					orderedQuantity: 10_000_000,
				},
			],
		})
		expect(result.success).toBe(true)
	})

	test('unknown fields are still refused', () => {
		expect(
			recordDeliverySchema.safeParse({ ...delivery, surprise: 1 }).success,
		).toBe(false)
	})

	test('the result may carry the order', () => {
		expect(
			recordDeliveryResultSchema.shape.order.safeParse(undefined).success,
		).toBe(true)
	})

	test('the result may say why a Station delivery was recorded without its order', () => {
		const shape = recordDeliveryResultSchema.shape.orderLinkIgnored
		for (const reason of ['closed', 'not_found', 'wrong_supplier', null]) {
			expect(shape.safeParse(reason).success).toBe(true)
		}
		expect(shape.safeParse(undefined).success).toBe(true)
		expect(shape.safeParse('other').success).toBe(false)
	})
})

describe('orders', () => {
	const base = {
		clientId: 'client-0003',
		locationId: 'main',
		supplierId: 'sup_1',
	}

	test('create from a suggestion or from lines, not both', () => {
		expect(
			createOrderSchema.safeParse({ ...base, fromSuggestion: true }).success,
		).toBe(true)
		expect(createOrderSchema.safeParse(base).success).toBe(true)
		expect(
			createOrderSchema.safeParse({
				...base,
				lines: [{ itemId: 'it_1', supplierProductId: 'sp_1', packs: 2.5 }],
			}).success,
		).toBe(true)
		expect(
			createOrderSchema.safeParse({
				...base,
				fromSuggestion: true,
				lines: [],
			}).success,
		).toBe(false)
	})

	test('packs are positive with at most three decimals', () => {
		const line = { itemId: 'it_1', supplierProductId: 'sp_1' }
		expect(orderLineInputSchema.safeParse({ ...line, packs: 0 }).success).toBe(
			false,
		)
		expect(
			orderLineInputSchema.safeParse({ ...line, packs: 1.2345 }).success,
		).toBe(false)
		expect(
			orderLineInputSchema.safeParse({ ...line, packs: 0.125 }).success,
		).toBe(true)
		expect(
			orderLineInputSchema.safeParse({ ...line, packs: 100_001 }).success,
		).toBe(false)
	})

	test('an update must change something and needs the version', () => {
		expect(updateOrderSchema.safeParse({ expectedVersion: 1 }).success).toBe(
			false,
		)
		expect(
			updateOrderSchema.safeParse({ expectedVersion: 1, note: null }).success,
		).toBe(true)
		expect(
			updateOrderSchema.safeParse({ expectedDate: '2026-11-12' }).success,
		).toBe(false)
	})

	test('send takes a channel and an optional language', () => {
		for (const channel of ['email', 'whatsapp', 'copy', 'pdf']) {
			expect(
				sendOrderSchema.safeParse({ expectedVersion: 2, channel }).success,
			).toBe(true)
		}
		expect(
			sendOrderSchema.safeParse({ expectedVersion: 2, channel: 'fax' }).success,
		).toBe(false)
		expect(
			sendOrderSchema.safeParse({
				expectedVersion: 2,
				channel: 'email',
				locale: 'ar',
			}).success,
		).toBe(true)
	})

	test('list defaults to open orders', () => {
		expect(listOrdersQuerySchema.parse({ locationId: 'main' }).status).toBe(
			'open',
		)
		expect(
			listOrdersQuerySchema.safeParse({ locationId: 'main', status: 'sent' })
				.success,
		).toBe(true)
		expect(
			listOrdersQuerySchema.safeParse({ locationId: 'main', status: 'nope' })
				.success,
		).toBe(false)
	})
})

describe('levels', () => {
	test('a row cannot order below above fill up to', () => {
		const body = (orderBelow: number | null, fillUp: number | null) => ({
			clientId: 'client-0004',
			locationId: 'main',
			levels: [
				{
					itemId: 'it_1',
					orderBelowQuantity: orderBelow,
					fillUpToQuantity: fillUp,
					expectedVersion: 0,
				},
			],
		})
		expect(putLevelsSchema.safeParse(body(8_000_000, 30_000_000)).success).toBe(
			true,
		)
		expect(putLevelsSchema.safeParse(body(null, 30_000_000)).success).toBe(true)
		expect(putLevelsSchema.safeParse(body(null, null)).success).toBe(true)
		expect(
			putLevelsSchema.safeParse(body(31_000_000, 30_000_000)).success,
		).toBe(false)
		expect(putLevelsSchema.safeParse(body(-1, 30_000_000)).success).toBe(false)
	})
})

describe('receiving extras', () => {
	test('credit message request and photo request limits', () => {
		expect(creditMessageRequestSchema.safeParse({}).success).toBe(true)
		expect(
			invoicePhotoRequestSchema.safeParse({
				contentType: 'image/jpeg',
				sizeBytes: 1_000_000,
			}).success,
		).toBe(true)
		for (const bad of [
			{ contentType: 'application/pdf', sizeBytes: 1000 },
			{ contentType: 'image/jpeg', sizeBytes: 6 * 1024 * 1024 },
			{ contentType: 'image/jpeg', sizeBytes: 0 },
		]) {
			expect(invoicePhotoRequestSchema.safeParse(bad).success).toBe(false)
		}
	})

	test('confirm prices lists lines and carries the currency', () => {
		expect(
			confirmDeliveryPricesSchema.safeParse({
				expectedVersion: 1,
				currency: 'SAR',
				vatMinor: 420,
				lines: [{ lineId: 'dl_1', lineTotalMinor: 28_000 }],
			}).success,
		).toBe(true)
		expect(
			confirmDeliveryPricesSchema.safeParse({
				expectedVersion: 1,
				currency: 'SAR',
				lines: [],
			}).success,
		).toBe(false)
	})

	test('price alert window', () => {
		expect(priceAlertsQuerySchema.parse({ locationId: 'main' }).days).toBe(30)
		expect(
			priceAlertsQuerySchema.safeParse({ locationId: 'main', days: 400 })
				.success,
		).toBe(false)
	})
})

describe('notifications and the tick', () => {
	const event = {
		orgId: 'org_1',
		eventId: 'a'.repeat(32),
		kind: 'inventory_low_stock',
		locationId: 'main',
		count: 4,
	}

	test('the event is ids and counts only', () => {
		expect(inventoryNotifyEventSchema.safeParse(event).success).toBe(true)
		for (const kind of INVENTORY_NOTIFY_KINDS) {
			expect(
				inventoryNotifyEventSchema.safeParse({ ...event, kind }).success,
			).toBe(true)
		}
		for (const bad of [
			{ kind: 'inventory_sold_out' },
			{ count: 0 },
			{ eventId: 'XYZ' },
			{ itemName: 'Chicken' },
			{ amountMinor: 100 },
		]) {
			expect(
				inventoryNotifyEventSchema.safeParse({ ...event, ...bad }).success,
			).toBe(false)
		}
	})

	test('dedupe keys are stable and distinct per business key', () => {
		const key = (k: string) =>
			inventoryNotifyDedupeKey({
				orgId: 'org_1',
				kind: 'inventory_price_rise',
				locationId: 'main',
				key: k,
			})
		expect(key('d1')).toBe(key('d1'))
		expect(key('d1')).not.toBe(key('d2'))
	})

	test('tick request and both answers', () => {
		expect(inventoryTickRequestSchema.safeParse({}).success).toBe(true)
		expect(inventoryTickRequestSchema.safeParse({ orgId: 'o1' }).success).toBe(
			true,
		)
		expect(inventoryTickRequestSchema.safeParse({ extra: 1 }).success).toBe(
			false,
		)
		const result = {
			alertsSent: 1,
			alertsDeferred: 0,
			alertsSkipped: 2,
			lowStockDigests: 1,
			countReviewAlerts: 0,
			deliveryDueAlerts: 0,
			priceRiseAlerts: 0,
			salesSettled: 0,
			errors: 0,
		}
		expect(
			inventoryTickAnswerSchema.safeParse({ success: true, result }).success,
		).toBe(true)
		expect(
			inventoryTickAnswerSchema.safeParse({
				success: true,
				orgs: 3,
				orgsDeferred: 0,
				...result,
			}).success,
		).toBe(true)
		// A single organization's answer may say an alert still waits and when to look again.
		expect(
			inventoryTickAnswerSchema.safeParse({
				success: true,
				result: {
					...result,
					needsFollowUp: true,
					nextDueAt: 1_700_000_000_000,
				},
			}).success,
		).toBe(true)
		expect(
			inventoryTickAnswerSchema.safeParse({
				success: true,
				result: { ...result, needsFollowUp: false, nextDueAt: null },
			}).success,
		).toBe(true)
	})
})
