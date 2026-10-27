import { type PrintSnapshot } from '@repo/common/print-shop'
import {
	db,
	eq,
	PrintDesign,
	PrintOrder,
	PrintVendorOrder,
	PrintVendorProduct,
} from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

const sessionCount = vi.hoisted(() => ({ value: 0 }))
const stripeMock = vi.hoisted(() => ({
	customers: {
		create: vi.fn(async () => ({ id: 'cus_print_1' })),
		update: vi.fn(async () => ({})),
	},
	checkout: {
		sessions: {
			create: vi.fn(async () => {
				const id = `cs_print_${++sessionCount.value}`
				return { id, url: `https://checkout.example/${id}` }
			}),
			expire: vi.fn(async () => ({})),
			retrieve: vi.fn(async (id: string) => ({
				id,
				status: 'open',
				payment_status: 'unpaid',
				url: `https://checkout.example/${id}`,
			})),
		},
	},
	refunds: { create: vi.fn(async () => ({ id: 're_1' })) },
}))

vi.mock('#app/utils/payments.server.ts', () => ({ stripe: stripeMock }))
vi.mock('@repo/email', () => ({
	sendEmail: vi.fn(async () => ({ success: true })),
	StaffingAlertEmail: () => null,
}))

const {
	createPrintQuote,
	cancelPrintOrder,
	handlePrintStripeSession,
	startPrintCheckout,
	getPrintOrderDetail,
	submitPrintOrder,
	syncOpenPrintOrders,
	adminRetryPrintOrder,
	adminRefundPrintOrder,
} = await import('./orders.server.ts')

function snapshot(pieces = 2): PrintSnapshot {
	return {
		product: 'table_card',
		sizeKey: 'a6',
		style: 'classic',
		templateVersion: 1,
		brand: {
			name: 'Bistro',
			logoDataUri: null,
			background: '#ffffff',
			foreground: '#111111',
			muted: '#666666',
			primary: '#123456',
			primaryForeground: '#ffffff',
			accent: '#eeeeee',
			accentForeground: '#111111',
			headingFont: 'Inter',
			bodyFont: 'Inter',
		},
		copy: [
			{
				locale: 'en',
				dir: 'ltr',
				headline: 'Scan to order',
				body: '',
				callToAction: '',
				qrCaption: 'Scan to order',
				tableWord: 'Table',
			},
		],
		featured: [],
		address: null,
		website: null,
		pieces: Array.from({ length: pieces }, (_, index) => ({
			tableLabel: `T${index + 1}`,
			qrUrl: `https://bistro.example/menu#table=${index}`,
		})),
		facts: { featured: [], tables: [] },
	}
}

const address = {
	recipientName: 'Sam Rivera',
	recipientPhone: '+1 555 010 2000',
	line1: '1 Main Street',
	city: 'Springfield',
	state: 'IL' as const,
	postalCode: '62701',
	country: 'US' as const,
}

async function setup() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id)
	const access = {
		userId: user.id,
		organization: {
			id: organization.id,
			slug: organization.slug,
			name: organization.name,
			siteTheme: null,
			siteIconKey: null,
			siteLocales: null,
			siteDefaultLocale: null,
			customDomain: null,
			dataRegion: 'us',
		},
		features: { enabled: true, shipping: true },
		canWrite: true,
		canPay: true,
	}
	const shot = snapshot()
	const [design] = await db
		.insert(PrintDesign)
		.values({
			organizationId: organization.id,
			createdById: user.id,
			name: 'Table cards',
			product: 'table_card',
			sizeKey: 'a6',
			style: 'classic',
			templateVersion: 1,
			content: {},
			status: 'approved',
			snapshot: shot,
			snapshotHash: 'hash-1',
		})
		.returning()
	return { access, design: design! }
}

describe('shipped print orders', () => {
	beforeEach(async () => {
		vi.stubEnv('PRINT_MOCK', 'true')
		vi.stubEnv('BASE_URL', 'https://app.menuza.test:2999')
		await db.delete(PrintVendorProduct)
		await db.insert(PrintVendorProduct).values({
			product: 'table_card',
			sizeKey: 'a6',
			vendor: 'gelato',
			vendorSku: 'cards_a6_test',
			bleedMm: 4,
		})
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.clearAllMocks()
	})

	it('quotes with the markup, takes payment and submits to the vendor', async () => {
		const { access, design } = await setup()
		const orderId = await createPrintQuote(
			new Request('https://app.test/'),
			access,
			{
				lines: [{ designId: design.id, quantity: 3 }],
				address,
				locationId: null,
			},
		)
		const { order, vendorOrders, items } = await getPrintOrderDetail(
			access.organization.id,
			orderId,
		)
		expect(order.status).toBe('quote')
		const vendor = vendorOrders[0]!
		expect(order.itemsCents).toBe(
			Math.ceil((vendor.wholesaleItemsCents * 13_000) / 10_000),
		)
		expect(order.shippingCents).toBe(vendor.wholesaleShippingCents)
		expect(items[0]!.item.pieces).toBe(2)

		const url = await startPrintCheckout(
			new Request('https://app.test/'),
			access,
			orderId,
			'https://app.menuza.test/x',
		)
		const sessionId = url.split('/').pop()!
		const sessionArgs = (
			stripeMock.checkout.sessions.create.mock.calls[0] as unknown as [
				Record<string, unknown>,
			]
		)[0]
		expect(sessionArgs.mode).toBe('payment')
		expect(sessionArgs.metadata).toMatchObject({ type: 'print_order', orderId })

		const session = {
			id: sessionId,
			metadata: {
				type: 'print_order',
				orderId,
				organizationId: access.organization.id,
			},
			payment_status: 'paid',
			currency: 'usd',
			amount_total: order.totalCents + 125,
			total_details: { amount_tax: 125 },
			payment_intent: 'pi_print_1',
		}
		await handlePrintStripeSession(
			session as never,
			'checkout.session.completed',
		)
		// A redelivered event changes nothing.
		await handlePrintStripeSession(
			session as never,
			'checkout.session.completed',
		)

		const [paid] = await db
			.select()
			.from(PrintOrder)
			.where(eq(PrintOrder.id, orderId))
		expect(paid).toMatchObject({
			status: 'submitted',
			taxCents: 125,
			stripePaymentIntentId: 'pi_print_1',
		})
		const [submitted] = await db
			.select()
			.from(PrintVendorOrder)
			.where(eq(PrintVendorOrder.orderId, orderId))
		expect(submitted?.status).toBe('submitted')
		expect(submitted?.vendorOrderId).toMatch(/^mock_/)

		await cancelPrintOrder(access, orderId)
		const [cancelled] = await db
			.select()
			.from(PrintOrder)
			.where(eq(PrintOrder.id, orderId))
		expect(cancelled?.status).toBe('refunded')
		expect(stripeMock.refunds.create).toHaveBeenCalledTimes(1)
	})

	it('ignores a session that is not bound to the order', async () => {
		const { access, design } = await setup()
		const orderId = await createPrintQuote(
			new Request('https://app.test/'),
			access,
			{
				lines: [{ designId: design.id, quantity: 1 }],
				address,
				locationId: null,
			},
		)
		await startPrintCheckout(
			new Request('https://app.test/'),
			access,
			orderId,
			'https://app.menuza.test/x',
		)
		await handlePrintStripeSession(
			{
				id: 'cs_forged',
				metadata: {
					type: 'print_order',
					orderId,
					organizationId: access.organization.id,
				},
				payment_status: 'paid',
				currency: 'usd',
			} as never,
			'checkout.session.completed',
		)
		const [order] = await db
			.select()
			.from(PrintOrder)
			.where(eq(PrintOrder.id, orderId))
		expect(order?.status).toBe('awaiting_payment')
	})

	it('refuses drafts, other organizations and unmapped sizes', async () => {
		const { access, design } = await setup()
		await db
			.update(PrintDesign)
			.set({ status: 'draft' })
			.where(eq(PrintDesign.id, design.id))
		await expect(
			createPrintQuote(new Request('https://app.test/'), access, {
				lines: [{ designId: design.id, quantity: 1 }],
				address,
				locationId: null,
			}),
		).rejects.toMatchObject({ code: 'design_not_approved' })

		const other = await setup()
		await expect(
			createPrintQuote(new Request('https://app.test/'), other.access, {
				lines: [{ designId: design.id, quantity: 1 }],
				address,
				locationId: null,
			}),
		).rejects.toMatchObject({ code: 'design_not_approved' })

		await db.delete(PrintVendorProduct)
		await expect(
			createPrintQuote(new Request('https://app.test/'), other.access, {
				lines: [{ designId: other.design.id, quantity: 1 }],
				address,
				locationId: null,
			}),
		).rejects.toMatchObject({ code: 'not_shippable' })
	})

	it('prints the snapshot that was priced, even if the design changes before payment', async () => {
		const { access, design } = await setup()
		const orderId = await createPrintQuote(
			new Request('https://app.test/'),
			access,
			{
				lines: [{ designId: design.id, quantity: 2 }],
				address,
				locationId: null,
			},
		)
		// The operator re-approves the design with many more tables.
		await db
			.update(PrintDesign)
			.set({ snapshot: snapshot(30), snapshotHash: 'hash-30' })
			.where(eq(PrintDesign.id, design.id))
		const url = await startPrintCheckout(
			new Request('https://app.test/'),
			access,
			orderId,
			'https://app.menuza.test/x',
		)
		const { order, items } = await getPrintOrderDetail(
			access.organization.id,
			orderId,
		)
		await handlePrintStripeSession(
			{
				id: url.split('/').pop()!,
				metadata: {
					type: 'print_order',
					orderId,
					organizationId: access.organization.id,
				},
				payment_status: 'paid',
				currency: 'usd',
				amount_total: order.totalCents,
				total_details: { amount_tax: 0 },
				payment_intent: 'pi_frozen',
			} as never,
			'checkout.session.completed',
		)
		const [paid] = await db
			.select()
			.from(PrintOrder)
			.where(eq(PrintOrder.id, orderId))
		expect(paid?.status).toBe('submitted')
		expect((items[0]!.item.snapshot as PrintSnapshot).pieces).toHaveLength(2)
	})

	it('refuses a cancel while the order is being sent, and never overwrites a cancel', async () => {
		const { access, design } = await setup()
		const orderId = await createPrintQuote(
			new Request('https://app.test/'),
			access,
			{
				lines: [{ designId: design.id, quantity: 1 }],
				address,
				locationId: null,
			},
		)
		await db
			.update(PrintOrder)
			.set({ status: 'submitting' })
			.where(eq(PrintOrder.id, orderId))
		await expect(cancelPrintOrder(access, orderId)).rejects.toMatchObject({
			code: 'order_busy',
		})

		// A submission that finds the order no longer paid does nothing.
		await db
			.update(PrintOrder)
			.set({ status: 'refunded' })
			.where(eq(PrintOrder.id, orderId))
		await submitPrintOrder(orderId)
		const [order] = await db
			.select()
			.from(PrintOrder)
			.where(eq(PrintOrder.id, orderId))
		expect(order?.status).toBe('refunded')
		const [vendorOrder] = await db
			.select()
			.from(PrintVendorOrder)
			.where(eq(PrintVendorOrder.orderId, orderId))
		expect(vendorOrder?.vendorOrderId).toBeNull()
	})

	it('refunds a payment that lands after the order was cancelled', async () => {
		const { access, design } = await setup()
		const orderId = await createPrintQuote(
			new Request('https://app.test/'),
			access,
			{
				lines: [{ designId: design.id, quantity: 1 }],
				address,
				locationId: null,
			},
		)
		const url = await startPrintCheckout(
			new Request('https://app.test/'),
			access,
			orderId,
			'https://app.test/x',
		)
		const sessionId = url.split('/').pop()!
		await cancelPrintOrder(access, orderId)
		const { order } = await getPrintOrderDetail(null, orderId)
		expect(order.status).toBe('cancelled')

		await handlePrintStripeSession(
			{
				id: sessionId,
				metadata: {
					type: 'print_order',
					orderId,
					organizationId: access.organization.id,
				},
				payment_status: 'paid',
				currency: 'usd',
				amount_total: order.totalCents,
				total_details: { amount_tax: 0 },
				payment_intent: 'pi_late_1',
			} as never,
			'checkout.session.completed',
		)
		const [after] = await db
			.select()
			.from(PrintOrder)
			.where(eq(PrintOrder.id, orderId))
		expect(after).toMatchObject({
			status: 'refunded',
			failureReason: 'late_payment',
			refundCents: order.totalCents,
		})
		expect(stripeMock.refunds.create).toHaveBeenCalledTimes(1)
	})

	it('will not cancel an order whose checkout already completed', async () => {
		const { access, design } = await setup()
		const orderId = await createPrintQuote(
			new Request('https://app.test/'),
			access,
			{
				lines: [{ designId: design.id, quantity: 1 }],
				address,
				locationId: null,
			},
		)
		await startPrintCheckout(
			new Request('https://app.test/'),
			access,
			orderId,
			'https://app.test/x',
		)
		stripeMock.checkout.sessions.retrieve.mockResolvedValueOnce({
			id: 'cs_done',
			status: 'complete',
			payment_status: 'paid',
			url: '',
		})
		await expect(cancelPrintOrder(access, orderId)).rejects.toMatchObject({
			code: 'order_busy',
		})
		const { order } = await getPrintOrderDetail(null, orderId)
		expect(order.status).toBe('awaiting_payment')
	})

	it('holds claims a crashed request left behind, and never retries a refund case', async () => {
		const { access, design } = await setup()
		const orderId = await createPrintQuote(
			new Request('https://app.test/'),
			access,
			{
				lines: [{ designId: design.id, quantity: 1 }],
				address,
				locationId: null,
			},
		)
		await db
			.update(PrintOrder)
			.set({
				status: 'submitting',
				updatedAt: new Date(Date.now() - 60 * 60_000),
			})
			.where(eq(PrintOrder.id, orderId))
		await syncOpenPrintOrders()
		const [held] = await db
			.select()
			.from(PrintOrder)
			.where(eq(PrintOrder.id, orderId))
		expect(held).toMatchObject({ status: 'held', holdReason: 'stale_claim' })

		await db
			.update(PrintOrder)
			.set({ holdReason: 'refund_failed' })
			.where(eq(PrintOrder.id, orderId))
		await expect(adminRetryPrintOrder(orderId, false)).rejects.toMatchObject({
			code: 'refund_needed',
		})
	})

	async function paidOrder() {
		const { access, design } = await setup()
		const request = new Request('https://app.test/')
		const orderId = await createPrintQuote(request, access, {
			lines: [{ designId: design.id, quantity: 1 }],
			address,
			locationId: null,
		})
		const url = await startPrintCheckout(
			request,
			access,
			orderId,
			'https://app.test/x',
		)
		const { order } = await getPrintOrderDetail(null, orderId)
		await handlePrintStripeSession(
			{
				id: url.split('/').pop()!,
				metadata: {
					type: 'print_order',
					orderId,
					organizationId: access.organization.id,
				},
				payment_status: 'paid',
				currency: 'usd',
				amount_total: order.totalCents,
				total_details: { amount_tax: 0 },
				payment_intent: `pi_${orderId}`,
			} as never,
			'checkout.session.completed',
		)
		return { access, orderId }
	}

	it('refunds only paid orders, and never in full by accident while a vendor prints', async () => {
		const { access, design } = await setup()
		const unpaid = await createPrintQuote(
			new Request('https://app.test/'),
			access,
			{
				lines: [{ designId: design.id, quantity: 1 }],
				address,
				locationId: null,
			},
		)
		await expect(adminRefundPrintOrder(unpaid)).rejects.toMatchObject({
			code: 'not_refundable',
		})

		const { orderId } = await paidOrder()
		// The vendor started long ago (the emulator reads the id's timestamp).
		await db
			.update(PrintVendorOrder)
			.set({ vendorOrderId: 'mock_1' })
			.where(eq(PrintVendorOrder.orderId, orderId))
		await expect(adminRefundPrintOrder(orderId)).rejects.toMatchObject({
			code: 'vendor_printing',
		})
		const { order: kept } = await getPrintOrderDetail(null, orderId)
		expect(kept.status).toBe('submitted')
		expect(stripeMock.refunds.create).not.toHaveBeenCalled()

		await adminRefundPrintOrder(orderId, { keepPrinting: true })
		const { order: refunded } = await getPrintOrderDetail(null, orderId)
		expect(refunded).toMatchObject({
			status: 'refunded',
			refundCents: refunded.totalCents,
		})
	})

	it('refunds a part of a held order and keeps tracking the rest', async () => {
		const { orderId } = await paidOrder()
		await db
			.update(PrintOrder)
			.set({ status: 'held', holdReason: 'partial_cancel' })
			.where(eq(PrintOrder.id, orderId))
		await adminRefundPrintOrder(orderId, { amountCents: 100 })
		const { order } = await getPrintOrderDetail(null, orderId)
		expect(order).toMatchObject({ refundCents: 100, holdReason: null })
		expect(order.status).not.toBe('held')
		await expect(
			adminRefundPrintOrder(orderId, { amountCents: order.totalCents }),
		).rejects.toMatchObject({ code: 'invalid_amount' })
	})

	it('asks Admin to check the vendor before retrying an order that may exist there', async () => {
		const { orderId } = await paidOrder()
		await db
			.update(PrintOrder)
			.set({ status: 'held', holdReason: 'vendor_unknown' })
			.where(eq(PrintOrder.id, orderId))
		await expect(adminRetryPrintOrder(orderId, false)).rejects.toMatchObject({
			code: 'check_vendor',
		})
	})
})
