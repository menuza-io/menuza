import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	createReportDefinition,
	getSubject,
	organizationCatalog,
	type ReportDefinition,
} from '@repo/reports'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	marketingCampaigns,
	marketingMessages,
	provisionTenantDb,
	restaurantOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	attributedChannel,
	loadCustomerRecords,
	loadOrderItemRecords,
	loadOrderOptionRecords,
	loadOrderRecords,
	loadTextSubscriberRecords,
	orderCountsTowardSales,
	parseOrderLines,
	phoneKey,
	reportOrderStatus,
} from './report-records.ts'

const day = 86_400_000
const now = new Date('2026-03-20T12:00:00Z')

function ago(days: number) {
	return new Date(now.getTime() - days * day)
}

describe('orderCountsTowardSales', () => {
	it('counts open and completed orders once they are payable', () => {
		expect(
			orderCountsTowardSales({
				status: 'accepted',
				paymentMethod: 'handoff',
				paymentStatus: 'unpaid',
			}),
		).toBe(true)
		expect(
			orderCountsTowardSales({
				status: 'completed',
				paymentMethod: 'online',
				paymentStatus: 'paid',
			}),
		).toBe(true)
	})

	it('leaves out unpaid online, cancelled, and payment review orders', () => {
		expect(
			orderCountsTowardSales({
				status: 'accepted',
				paymentMethod: 'online',
				paymentStatus: 'pending',
			}),
		).toBe(false)
		expect(
			orderCountsTowardSales({
				status: 'cancelled',
				paymentMethod: 'handoff',
				paymentStatus: 'unpaid',
			}),
		).toBe(false)
		expect(
			orderCountsTowardSales({
				status: 'payment_review',
				paymentMethod: 'online',
				paymentStatus: 'review',
			}),
		).toBe(false)
	})
})

describe('reportOrderStatus', () => {
	const unpaidOnline = {
		status: 'accepted',
		paymentMethod: 'online',
		paymentStatus: 'pending',
	} as const

	it('shows unpaid online orders as awaiting payment until the hold lapses', () => {
		expect(
			reportOrderStatus(
				{ ...unpaidOnline, holdExpiresAt: new Date(now.getTime() + 60_000) },
				now,
			),
		).toEqual({ status: 'awaiting_payment', paymentStatus: 'pending' })
		expect(
			reportOrderStatus({ ...unpaidOnline, holdExpiresAt: null }, now),
		).toEqual({ status: 'awaiting_payment', paymentStatus: 'pending' })
		expect(
			reportOrderStatus(
				{ ...unpaidOnline, holdExpiresAt: new Date(now.getTime() - 60_000) },
				now,
			),
		).toEqual({ status: 'expired', paymentStatus: 'expired' })
	})

	it('keeps the stored status of every other order', () => {
		expect(
			reportOrderStatus(
				{
					status: 'preparing',
					paymentMethod: 'handoff',
					paymentStatus: 'unpaid',
					holdExpiresAt: null,
				},
				now,
			),
		).toEqual({ status: 'preparing', paymentStatus: 'unpaid' })
	})
})

describe('phoneKey', () => {
	it('matches the same number written different ways', () => {
		expect(phoneKey('+966 50 123 4567')).toBe('501234567')
		expect(phoneKey('0501234567')).toBe('501234567')
		expect(phoneKey('(555) 000-0001')).toBe(phoneKey('+1 555 000 0001'))
	})

	it('ignores missing and too-short numbers', () => {
		expect(phoneKey(null)).toBeNull()
		expect(phoneKey('')).toBeNull()
		expect(phoneKey('12345')).toBeNull()
	})
})

describe('parseOrderLines', () => {
	it('reads localized names and skips malformed entries', () => {
		const lines = parseOrderLines(
			JSON.stringify([
				{
					itemName: '{"en":"Burger","ar":"برجر"}',
					quantity: 2,
					totalCents: 2400,
					options: [
						{
							groupName: 'Size',
							optionName: 'Large',
							quantity: 1,
							totalCents: 200,
						},
						null,
					],
				},
				'not a line',
				{ itemName: 'Fries', quantity: 'two', totalCents: null },
			]),
		)
		expect(lines).toEqual([
			{
				itemName: 'Burger',
				quantity: 2,
				totalCents: 2400,
				options: [
					{
						groupName: 'Size',
						optionName: 'Large',
						quantity: 1,
						totalCents: 200,
					},
				],
			},
			{ itemName: 'Fries', quantity: 0, totalCents: 0, options: [] },
		])
	})

	it('returns no lines when the stored value is unreadable', () => {
		expect(parseOrderLines('{not json')).toEqual([])
		expect(parseOrderLines({ itemName: 'Burger' })).toEqual([])
		expect(parseOrderLines(null)).toEqual([])
	})
})

describe('attributedChannel', () => {
	const orderedAt = ago(1)

	it('credits the latest message in the 7 days before the order', () => {
		expect(
			attributedChannel(
				[
					{ sentAt: ago(5).getTime(), channel: 'sms' },
					{ sentAt: ago(2).getTime(), channel: 'email' },
					{ sentAt: ago(0).getTime(), channel: 'sms' },
				],
				orderedAt,
			),
		).toBe('email')
		expect(
			attributedChannel(
				[{ sentAt: ago(8).getTime(), channel: 'sms' }],
				orderedAt,
			),
		).toBe('sms')
	})

	it('does not credit older or later messages', () => {
		expect(
			attributedChannel(
				[{ sentAt: ago(8).getTime() - 1000, channel: 'sms' }],
				orderedAt,
			),
		).toBe('none')
		expect(
			attributedChannel(
				[{ sentAt: ago(0).getTime(), channel: 'sms' }],
				orderedAt,
			),
		).toBe('none')
		expect(attributedChannel(undefined, orderedAt)).toBe('none')
	})
})

describe('report record loaders', () => {
	const orgId = 'clw9x0a12000008l00orders01'
	const orderSubject = getSubject(organizationCatalog, 'orders')!
	const customerSubject = getSubject(organizationCatalog, 'customers')!
	let tempDir: string
	let db: TenantDatabase
	let sequence = 0

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-orders-'))
		process.env.TENANT_DB_DIR = tempDir
		await provisionTenantDb(orgId)
		db = await getTenantDb(orgId)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function listDefinition(
		subject: string,
		columns: string[] = [],
		timeframe: Partial<ReportDefinition['timeframe']> = {},
	) {
		return createReportDefinition({
			subject,
			timeframe: { field: 'createdAt', preset: 'all_time', ...timeframe },
			columns,
			visualization: {
				chartStyle: 'table',
				measure: 'count',
				sortBy: 'none',
				hideCounts: false,
			},
			settings: { title: 'Report', notes: '', timezone: 'UTC' },
		})
	}

	async function insertCustomer(values: {
		name: string
		phone?: string | null
		email?: string | null
	}) {
		const [row] = await db
			.insert(customers)
			.values({ createdAt: ago(30), ...values })
			.returning({ id: customers.id })
		return row!.id
	}

	async function insertOrders(
		...orders: Array<Partial<typeof restaurantOrders.$inferInsert>>
	) {
		await db.insert(restaurantOrders).values(
			orders.map((order): typeof restaurantOrders.$inferInsert => {
				sequence += 1
				return {
					orgId,
					number: `auto-${sequence}`,
					status: 'completed',
					paymentMethod: 'handoff',
					paymentStatus: 'unpaid',
					fulfillment: 'pickup',
					locationId: 'loc_1',
					locationName: '{"en":"Downtown","ar":"وسط البلد"}',
					contactName: 'Guest',
					contactPhone: '+15550009999',
					currency: 'usd',
					subtotalCents: 1000,
					taxCents: 100,
					totalCents: 1100,
					lines: [],
					idempotencyKey: `idempotency-${sequence}`,
					requestHash: 'request-hash',
					receiptTokenHash: `receipt-${sequence}`,
					createdAt: ago(1),
					...order,
				}
			}),
		)
	}

	function orderLine(
		itemName: string,
		quantity: number,
		unitCents: number,
		options: Array<{
			groupName: string
			optionName: string
			quantity?: number
			priceCents: number
		}> = [],
	) {
		const priced = options.map((option, index) => {
			const optionQuantity = option.quantity ?? 1
			return {
				groupId: `group_${index}`,
				groupName: option.groupName,
				optionId: `option_${index}`,
				optionName: option.optionName,
				half: null,
				quantity: optionQuantity,
				priceCents: option.priceCents,
				totalCents: option.priceCents * optionQuantity,
			}
		})
		const unitPriceCents =
			unitCents + priced.reduce((sum, option) => sum + option.totalCents, 0)
		return {
			itemId: `item_${itemName}`,
			itemName,
			variantId: null,
			quantity,
			unitPriceCents,
			taxableUnitCents: unitPriceCents,
			totalCents: unitPriceCents * quantity,
			taxableCents: unitPriceCents * quantity,
			instructions: null,
			options: priced,
		}
	}

	describe('loadOrderRecords', () => {
		it('maps orders to report fields, newest first', async () => {
			await insertOrders(
				{
					number: 'A100',
					createdAt: ago(5),
					completedAt: new Date(ago(5).getTime() + 3_600_000),
					scheduledFor: ago(4),
					contactName: 'Ada',
					contactPhone: '+15550000001',
					contactEmail: 'ada@example.com',
					subtotalCents: 2000,
					taxCents: 150,
					tipCents: 300,
					tipPercent: 15,
					totalCents: 2450,
				},
				{
					number: 'A101',
					createdAt: ago(4),
					status: 'accepted',
					paymentMethod: 'online',
					paymentStatus: 'pending',
					holdExpiresAt: new Date(now.getTime() + 600_000),
					fulfillment: 'delivery',
					deliveryFeeCents: 500,
					dropId: 'drop_1',
					dropSlug: 'friday-drop',
					currency: 'sar',
				},
				{
					number: 'A102',
					createdAt: ago(3),
					status: 'accepted',
					paymentMethod: 'online',
					paymentStatus: 'pending',
					holdExpiresAt: ago(3),
				},
				{
					number: 'A103',
					createdAt: ago(2),
					status: 'preparing',
					paymentMethod: 'online',
					paymentStatus: 'paid',
				},
				{ number: 'A104', createdAt: ago(1), status: 'cancelled' },
				{ number: 'Z999', orgId: 'another_org', createdAt: ago(1) },
			)

			const { records, truncated } = await loadOrderRecords(
				db,
				orgId,
				orderSubject,
				listDefinition('orders'),
				now,
			)

			expect(truncated).toBe(false)
			expect(
				records.map((record) => [
					record.orderNumber,
					record.status,
					record.paymentStatus,
					record.countsTowardSales,
				]),
			).toEqual([
				['A104', 'cancelled', 'unpaid', false],
				['A103', 'preparing', 'paid', true],
				['A102', 'expired', 'expired', false],
				['A101', 'awaiting_payment', 'pending', false],
				['A100', 'completed', 'unpaid', true],
			])
			expect(records[3]).toMatchObject({
				fulfillment: 'delivery',
				source: 'drop',
				drop: 'friday-drop',
				currency: 'SAR',
				timing: 'asap',
				customerEmail: '',
				deliveryFee: 5,
			})
			expect(records[4]).toEqual({
				createdAt: ago(5),
				completedAt: new Date(ago(5).getTime() + 3_600_000),
				orderNumber: 'A100',
				location: 'Downtown',
				fulfillment: 'pickup',
				source: 'menu',
				drop: '',
				currency: 'USD',
				status: 'completed',
				paymentStatus: 'unpaid',
				countsTowardSales: true,
				paymentMethod: 'handoff',
				timing: 'scheduled',
				customerName: 'Ada',
				customerPhone: '+15550000001',
				customerEmail: 'ada@example.com',
				total: 24.5,
				subtotal: 20,
				tax: 1.5,
				tip: 3,
				tipPercent: 15,
				deliveryFee: 0,
			})
		})

		it('counts items per order only when the report uses item counts', async () => {
			await insertOrders(
				{
					number: 'A1',
					createdAt: ago(2),
					lines: [orderLine('Burger', 2, 1200), orderLine('Fries', 1, 400)],
				},
				{ number: 'A2', createdAt: ago(1), lines: 'not json' },
			)

			const { records } = await loadOrderRecords(
				db,
				orgId,
				orderSubject,
				listDefinition('orders', ['orderNumber', 'itemCount']),
				now,
			)

			expect(
				records.map((record) => [record.orderNumber, record.itemCount]),
			).toEqual([
				['A2', 0],
				['A1', 3],
			])
			expect(records[0]).not.toHaveProperty('customerType')
			expect(records[0]).not.toHaveProperty('attributedChannel')
		})

		it('tells first orders from returning customers across accounts and guest checkouts', async () => {
			const adaId = await insertCustomer({ name: 'Ada', phone: '+15550000001' })
			await insertOrders(
				// Before the report window, as a guest with Ada's number.
				{ number: 'A1', createdAt: ago(10), contactPhone: '(555) 000-0001' },
				{ number: 'A2', createdAt: ago(5), customerId: adaId },
				// A cancelled order is not an earlier purchase.
				{
					number: 'B1',
					createdAt: ago(4),
					contactPhone: '+15550000002',
					status: 'cancelled',
				},
				{ number: 'B2', createdAt: ago(3), contactPhone: '+15550000002' },
				{ number: 'B3', createdAt: ago(2), contactPhone: '555 000 0002' },
			)

			const { records } = await loadOrderRecords(
				db,
				orgId,
				orderSubject,
				listDefinition('orders', ['orderNumber', 'customerType'], {
					preset: 'last_7_days',
				}),
				now,
			)

			expect(
				Object.fromEntries(
					records.map((record) => [record.orderNumber, record.customerType]),
				),
			).toEqual({ A2: 'returning', B1: 'new', B2: 'new', B3: 'returning' })
		})

		it('credits orders to the latest email or text delivered in the week before', async () => {
			const adaId = await insertCustomer({ name: 'Ada', phone: '+15550000001' })
			const bobId = await insertCustomer({ name: 'Bob', phone: '+15550000002' })
			const [campaign] = await db
				.insert(marketingCampaigns)
				.values({ name: 'Weekend', channel: 'sms', status: 'Completed' })
				.returning({ id: marketingCampaigns.id })
			await db.insert(marketingMessages).values([
				// Broadcast rows keep the default channel; the campaign's applies.
				{ campaignId: campaign!.id, customerId: adaId, sentAt: ago(3) },
				{ customerId: adaId, channel: 'email', sentAt: ago(1.5) },
				{ customerId: bobId, channel: 'email', sentAt: ago(20) },
				{ customerId: bobId, channel: 'sms', status: 'Failed', sentAt: ago(2) },
			])
			await insertOrders(
				{ number: 'A1', createdAt: ago(4), customerId: adaId },
				{ number: 'A2', createdAt: ago(2), customerId: adaId },
				// A guest checkout with Ada's number.
				{ number: 'A3', createdAt: ago(1), contactPhone: '555-000-0001' },
				{ number: 'B1', createdAt: ago(1), customerId: bobId },
				{ number: 'C1', createdAt: ago(1), contactPhone: '+15550000003' },
			)

			const { records } = await loadOrderRecords(
				db,
				orgId,
				orderSubject,
				listDefinition('orders', ['orderNumber', 'attributedChannel']),
				now,
			)

			expect(
				Object.fromEntries(
					records.map((record) => [
						record.orderNumber,
						record.attributedChannel,
					]),
				),
			).toEqual({ A1: 'none', A2: 'sms', A3: 'email', B1: 'none', C1: 'none' })
		})

		it('reads only the timeframe and keeps the newest orders at the cap', async () => {
			await insertOrders(
				{ number: 'A1', createdAt: ago(20), completedAt: ago(19) },
				{ number: 'A2', createdAt: ago(3) },
				{
					number: 'A3',
					createdAt: ago(2),
					completedAt: new Date(ago(2).getTime() + 3_600_000),
				},
				{
					number: 'A4',
					createdAt: ago(1),
					completedAt: new Date(ago(1).getTime() + 3_600_000),
				},
			)

			const recent = await loadOrderRecords(
				db,
				orgId,
				orderSubject,
				listDefinition('orders', [], { preset: 'last_7_days' }),
				now,
			)
			expect(recent.truncated).toBe(false)
			expect(recent.records.map((record) => record.orderNumber)).toEqual([
				'A4',
				'A3',
				'A2',
			])

			const completed = await loadOrderRecords(
				db,
				orgId,
				orderSubject,
				listDefinition('orders', [], {
					field: 'completedAt',
					preset: 'last_7_days',
				}),
				now,
			)
			expect(completed.records.map((record) => record.orderNumber)).toEqual([
				'A4',
				'A3',
			])

			const capped = await loadOrderRecords(
				db,
				orgId,
				orderSubject,
				listDefinition('orders'),
				now,
				2,
			)
			expect(capped.truncated).toBe(true)
			expect(capped.records.map((record) => record.orderNumber)).toEqual([
				'A4',
				'A3',
			])
		})
	})

	describe('loadOrderItemRecords', () => {
		it('lists the lines of orders that count toward sales', async () => {
			await insertOrders(
				{
					number: 'A1',
					createdAt: ago(2),
					lines: [
						orderLine('{"en":"Burger","ar":"برجر"}', 2, 1200),
						orderLine('Fries', 1, 400),
					],
				},
				{
					number: 'A2',
					createdAt: ago(1),
					status: 'cancelled',
					lines: [orderLine('Burger', 5, 1200)],
				},
				{
					number: 'A3',
					createdAt: ago(1),
					status: 'accepted',
					paymentMethod: 'online',
					paymentStatus: 'pending',
					lines: [orderLine('Burger', 3, 1200)],
				},
			)

			const { records, truncated } = await loadOrderItemRecords(
				db,
				orgId,
				listDefinition('order_items'),
				now,
			)

			const context = {
				createdAt: ago(2),
				orderNumber: 'A1',
				location: 'Downtown',
				fulfillment: 'pickup',
				source: 'menu',
				drop: '',
				currency: 'USD',
			}
			expect(truncated).toBe(false)
			expect(records).toEqual([
				{ ...context, itemName: 'Burger', quantity: 2, sales: 24 },
				{ ...context, itemName: 'Fries', quantity: 1, sales: 4 },
			])
		})
	})

	describe('loadOrderOptionRecords', () => {
		it('scales option quantities and charges by the item quantity', async () => {
			await insertOrders({
				number: 'A1',
				createdAt: ago(1),
				dropId: 'drop_1',
				dropSlug: 'friday',
				lines: [
					orderLine('Burger', 3, 1200, [
						{ groupName: 'Size', optionName: 'Large', priceCents: 200 },
						{
							groupName: 'Extras',
							optionName: 'Cheese',
							quantity: 2,
							priceCents: 50,
						},
					]),
					orderLine('Fries', 1, 400),
				],
			})

			const { records } = await loadOrderOptionRecords(
				db,
				orgId,
				listDefinition('order_options'),
				now,
			)

			expect(records).toEqual([
				expect.objectContaining({
					itemName: 'Burger',
					groupName: 'Size',
					optionName: 'Large',
					quantity: 3,
					sales: 6,
					source: 'drop',
					drop: 'friday',
				}),
				expect.objectContaining({
					itemName: 'Burger',
					groupName: 'Extras',
					optionName: 'Cheese',
					quantity: 6,
					sales: 3,
				}),
			])
		})
	})

	describe('loadTextSubscriberRecords', () => {
		it('lists text subscribers, including those who opted out', async () => {
			const adaId = await insertCustomer({ name: 'Ada', phone: '+15550000001' })
			const bobId = await insertCustomer({ name: 'Bob', phone: null })
			await db.insert(customerSubscriptions).values([
				{
					customerId: adaId,
					topic: 'drops',
					channel: 'sms',
					source: 'menu',
					subscribedAt: ago(10),
				},
				{
					customerId: bobId,
					topic: 'drops',
					channel: 'sms',
					source: 'order_success',
					subscribedAt: ago(9),
					unsubscribedAt: ago(2),
				},
			])

			const records = await loadTextSubscriberRecords(db)

			expect(
				[...records].sort((left, right) =>
					String(left.customerName).localeCompare(String(right.customerName)),
				),
			).toEqual([
				{
					subscribedAt: ago(10),
					unsubscribedAt: null,
					status: 'subscribed',
					source: 'menu',
					topic: 'drops',
					customerName: 'Ada',
					customerPhone: '+15550000001',
				},
				{
					subscribedAt: ago(9),
					unsubscribedAt: ago(2),
					status: 'unsubscribed',
					source: 'order_success',
					topic: 'drops',
					customerName: 'Bob',
					customerPhone: '',
				},
			])
		})
	})

	describe('loadCustomerRecords', () => {
		it('adds order history and text status only when the report reads them', async () => {
			const adaId = await insertCustomer({
				name: 'Ada',
				phone: '+15550000001',
				email: 'ada@example.com',
			})
			const bobId = await insertCustomer({ name: 'Bob', phone: '+15550000002' })
			await db.insert(customerSubscriptions).values([
				{
					customerId: adaId,
					topic: 'drops',
					channel: 'sms',
					source: 'menu',
					subscribedAt: ago(10),
				},
				{
					customerId: bobId,
					topic: 'drops',
					channel: 'sms',
					source: 'menu',
					subscribedAt: ago(10),
					unsubscribedAt: ago(1),
				},
			])
			await insertOrders(
				// A guest checkout with Ada's number counts as hers.
				{
					createdAt: ago(10),
					contactPhone: '555-000-0001',
					dropId: 'drop_1',
					totalCents: 2000,
				},
				{ createdAt: ago(5), customerId: adaId, totalCents: 1500 },
				{
					createdAt: ago(1),
					customerId: adaId,
					status: 'cancelled',
					totalCents: 9999,
				},
			)

			const plain = await loadCustomerRecords(
				db,
				orgId,
				customerSubject,
				listDefinition('customers'),
			)
			expect(plain).toHaveLength(2)
			for (const record of plain) {
				expect(record).not.toHaveProperty('hasOrdered')
				expect(record).not.toHaveProperty('currency')
				expect(record).not.toHaveProperty('textSubscriber')
			}

			const detailed = await loadCustomerRecords(
				db,
				orgId,
				customerSubject,
				listDefinition('customers', [
					'name',
					'orderCount',
					'totalSpent',
					'firstOrderSource',
					'textSubscriber',
				]),
			)
			const byName = Object.fromEntries(
				detailed.map((record) => [record.name, record]),
			)
			expect(byName.Ada).toMatchObject({
				hasEmail: true,
				hasOrdered: true,
				orderCount: 2,
				totalSpent: 35,
				firstOrderAt: ago(10),
				lastOrderAt: ago(5),
				firstOrderSource: 'drop',
				currency: 'USD',
				textSubscriber: true,
			})
			// Customers without orders take the organization's usual currency.
			expect(byName.Bob).toMatchObject({
				hasEmail: false,
				hasOrdered: false,
				orderCount: 0,
				totalSpent: 0,
				firstOrderAt: null,
				lastOrderAt: null,
				firstOrderSource: 'none',
				currency: 'USD',
				textSubscriber: false,
			})
		})
	})
})
