import {
	PRINT_MAX_PIECES_PER_DESIGN,
	type PrintSnapshot,
} from '@repo/common/print-shop'
import {
	db,
	eq,
	PrintDesign,
	PrintOrder,
	PrintVendorOrder,
	PrintVendorProduct,
} from '@repo/database'
import { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import * as printFiles from './print-files.server.ts'
import type * as vendorsModule from './vendors/index.server.ts'

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
	refunds: {
		create: vi.fn(
			async (params: { payment_intent: string; amount: number }) => {
				stripeRefunds.push({ ...params, status: 'succeeded' })
				return { id: `re_${stripeRefunds.length}` }
			},
		),
		list: vi.fn(({ payment_intent }: { payment_intent: string }) =>
			(async function* () {
				yield* stripeRefunds.filter(
					(refund) => refund.payment_intent === payment_intent,
				)
			})(),
		),
	},
}))
/** Refunds Stripe holds, whatever the order's ledger says. */
const stripeRefunds = vi.hoisted(
	() => [] as Array<{ payment_intent: string; amount: number; status: string }>,
)

const vendorState = vi.hoisted(() => ({
	value: null as null | 'returned' | 'failed' | 'cancelled',
	quoteError: null as null | 'rejected' | 'unavailable',
}))
vi.mock('./vendors/index.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof vendorsModule>()
	const { VendorError } = await import('./vendors/types.ts')
	return {
		...actual,
		getPrintVendor: (name: Parameters<typeof actual.getPrintVendor>[0]) => {
			const vendor = actual.getPrintVendor(name)
			return {
				...vendor,
				quote: async (...args: Parameters<typeof vendor.quote>) => {
					if (vendorState.quoteError) {
						throw new VendorError(name, vendorState.quoteError, 'Refused')
					}
					return vendor.quote(...args)
				},
				status: async (id: string) =>
					vendorState.value
						? {
								state: vendorState.value,
								carrier: null,
								trackingNumber: null,
								trackingUrl: null,
							}
						: vendor.status(id),
			}
		},
	}
})

vi.mock('@repo/common/print-shop-catalog', async () => ({
	printCatalog: (await import('./test-catalog.ts')).testPrintCatalog,
}))
vi.mock('#app/utils/shop.server.ts', () => ({
	getShopCommerce: () => ({ getPlatformStripe: () => stripeMock }),
}))
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
	syncPrintVendorOrder,
	adminRetryPrintOrder,
	continuePrintSubmission,
	adminRefundPrintOrder,
	adminRecordVendorOrder,
} = await import('./orders.server.ts')

function snapshot(pieces = 2): PrintSnapshot {
	return {
		product: 'desk_card',
		sizeKey: 'a6',
		style: 'classic',
		templateVersion: 1,
		brand: {
			name: 'Studio',
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
				headline: 'Scan to check in',
				body: '',
				callToAction: '',
				qrCaption: 'Scan to check in',
				pieceWord: 'Desk',
			},
		],
		featured: [],
		address: null,
		website: null,
		pieces: Array.from({ length: pieces }, (_, index) => ({
			label: `D${index + 1}`,
			qrUrl: `https://studio.example/check-in#desk=${index}`,
		})),
		qr: { kind: 'desk', deskIds: ['all'] },
		facts: { featured: [], pieces: [] },
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
		features: { enabled: true, shipping: true, canva: false },
		canWrite: true,
		canPay: true,
	}
	const shot = snapshot()
	const [design] = await db
		.insert(PrintDesign)
		.values({
			organizationId: organization.id,
			createdById: user.id,
			name: 'Desk cards',
			product: 'desk_card',
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
		vi.stubEnv('BASE_URL', 'https://app.studio.test:2999')
		await db.delete(PrintVendorProduct)
		await db.insert(PrintVendorProduct).values({
			product: 'desk_card',
			sizeKey: 'a6',
			vendor: 'gelato',
			vendorSku: 'cards_a6_test',
			bleedMm: 4,
		})
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.clearAllMocks()
		vendorState.value = null
		vendorState.quoteError = null
		stripeRefunds.length = 0
	})

	it('quotes with the markup, takes payment and submits to the vendor', async () => {
		const { access, design } = await setup()
		const orderId = await createPrintQuote(
			new Request('https://app.test/'),
			access,
			{
				lines: [{ designId: design.id, quantity: 3 }],
				address,
				scopeId: null,
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
			'https://app.studio.test/x',
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
				scopeId: null,
			},
		)
		await startPrintCheckout(
			new Request('https://app.test/'),
			access,
			orderId,
			'https://app.studio.test/x',
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
				scopeId: null,
			}),
		).rejects.toMatchObject({ code: 'design_not_approved' })

		const other = await setup()
		await expect(
			createPrintQuote(new Request('https://app.test/'), other.access, {
				lines: [{ designId: design.id, quantity: 1 }],
				address,
				scopeId: null,
			}),
		).rejects.toMatchObject({ code: 'design_not_approved' })

		await db.delete(PrintVendorProduct)
		await expect(
			createPrintQuote(new Request('https://app.test/'), other.access, {
				lines: [{ designId: other.design.id, quantity: 1 }],
				address,
				scopeId: null,
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
				scopeId: null,
			},
		)
		// The operator re-approves the design with many more desks.
		await db
			.update(PrintDesign)
			.set({ snapshot: snapshot(30), snapshotHash: 'hash-30' })
			.where(eq(PrintDesign.id, design.id))
		const url = await startPrintCheckout(
			new Request('https://app.test/'),
			access,
			orderId,
			'https://app.studio.test/x',
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
				scopeId: null,
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
				scopeId: null,
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
				scopeId: null,
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
				scopeId: null,
			},
		)
		// Cut short during a vendor call: it may have reached the vendor.
		await db
			.update(PrintOrder)
			.set({
				status: 'submitting',
				holdReason: 'vendor_sending',
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
			scopeId: null,
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

	it('submits after the webhook has answered when given a way to', async () => {
		const { access, design } = await setup()
		const request = new Request('https://app.test/')
		const orderId = await createPrintQuote(request, access, {
			lines: [{ designId: design.id, quantity: 1 }],
			address,
			scopeId: null,
		})
		const url = await startPrintCheckout(
			request,
			access,
			orderId,
			'https://app.test/x',
		)
		const { order } = await getPrintOrderDetail(null, orderId)
		const tasks: Array<() => Promise<unknown>> = []
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
			{ later: (task) => tasks.push(task) },
		)
		expect((await getPrintOrderDetail(null, orderId)).order.status).toBe('paid')
		expect(tasks).toHaveLength(1)
		await tasks[0]!()
		expect((await getPrintOrderDetail(null, orderId)).order.status).toBe(
			'submitted',
		)
	})

	it('leaves a fresh paid order to its background submission, and the sweep submits it once stale', async () => {
		// The webhook answered and its background submission never ran.
		const { orderId } = await paidOrderLater()
		await syncOpenPrintOrders()
		expect((await getPrintOrderDetail(null, orderId)).order.status).toBe('paid')

		await db
			.update(PrintOrder)
			.set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
			.where(eq(PrintOrder.id, orderId))
		await syncOpenPrintOrders()
		expect((await getPrintOrderDetail(null, orderId)).order.status).toBe(
			'submitted',
		)
	})

	it('hands a large set back when its rendering time runs out, and the sweep finishes it', async () => {
		const { orderId } = await paidOrderLater()
		expect(await submitPrintOrder(orderId, { budgetMs: -1 })).toBe('deferred')
		const deferred = (await getPrintOrderDetail(null, orderId)).order
		expect(deferred).toMatchObject({ status: 'paid', holdReason: null })

		// A claim cut short before any vendor call is simply resumed.
		await db
			.update(PrintOrder)
			.set({
				status: 'submitting',
				updatedAt: new Date(Date.now() - 60 * 60_000),
			})
			.where(eq(PrintOrder.id, orderId))
		await syncOpenPrintOrders()
		expect((await getPrintOrderDetail(null, orderId)).order.status).toBe(
			'submitted',
		)
	})

	it.each(['vendor_returned', 'vendor_after_shipping', 'vendor_unknown'])(
		'requires Admin to resolve %s without cancelling vendors or refunding',
		async (holdReason) => {
			const { access, orderId } = await paidOrderLater()
			await db
				.update(PrintOrder)
				.set({ status: 'held', holdReason })
				.where(eq(PrintOrder.id, orderId))
			await expect(cancelPrintOrder(access, orderId)).rejects.toMatchObject({
				code: 'needs_support',
			})
			expect((await getPrintOrderDetail(null, orderId)).order).toMatchObject({
				status: 'held',
				holdReason,
			})
			expect(stripeMock.refunds.create).not.toHaveBeenCalled()
		},
	)

	it('holds a returned parcel for Admin instead of refunding it', async () => {
		const { orderId } = await paidOrder()
		vendorState.value = 'returned'
		await syncOpenPrintOrders()
		const { order, vendorOrders } = await getPrintOrderDetail(null, orderId)
		expect(order).toMatchObject({
			status: 'held',
			holdReason: 'vendor_returned',
		})
		expect(vendorOrders[0]!.status).toBe('returned')
		expect(
			stripeMock.refunds.create.mock.calls.some(
				(call) =>
					(call as unknown as [{ payment_intent: string }])[0]
						.payment_intent === `pi_${orderId}`,
			),
		).toBe(false)
		// Nothing is left to send: a retry would only mark it sent again.
		await expect(adminRetryPrintOrder(orderId, false)).rejects.toMatchObject({
			code: 'shipped_already',
		})
	})

	it('an Admin retry runs one short submission, and the rest continues', async () => {
		const { orderId } = await paidOrderLater()
		await db
			.update(PrintOrder)
			.set({ status: 'held', holdReason: 'render_unavailable' })
			.where(eq(PrintOrder.id, orderId))
		let now = Date.now()
		vi.spyOn(Date, 'now').mockImplementation(() => now)
		// Every render takes 16 s: past the 15 s budget after the first one.
		const render = vi
			.spyOn(printFiles, 'getPrintFile')
			.mockImplementation(async () => {
				now += 16_000
				return {
					kind: 'pdf',
					bytes: new Uint8Array(new ArrayBuffer(4)),
					objectKey: 'print/x.pdf',
					fresh: true,
				}
			})
		expect(await adminRetryPrintOrder(orderId, false)).toBe('deferred')
		expect(render).toHaveBeenCalledTimes(1)
		expect((await getPrintOrderDetail(null, orderId)).order.status).toBe('paid')
		await continuePrintSubmission(orderId)
		expect((await getPrintOrderDetail(null, orderId)).order.status).toBe(
			'submitted',
		)
		vi.restoreAllMocks()
	})

	it('keeps an accepted price for every vendor when a retry is handed back', async () => {
		const { access, design } = await setup()
		// A second size printed at another vendor: one order, two vendor orders.
		await db.insert(PrintVendorProduct).values({
			product: 'desk_card',
			sizeKey: '4x6',
			vendor: 'prodigi',
			vendorSku: 'cards_4x6_test',
			bleedMm: 3,
		})
		const [other] = await db
			.insert(PrintDesign)
			.values({
				organizationId: access.organization.id,
				createdById: access.userId,
				name: 'Desk cards 4x6',
				product: 'desk_card',
				sizeKey: '4x6',
				style: 'classic',
				templateVersion: 1,
				content: {},
				status: 'approved',
				snapshot: { ...snapshot(), sizeKey: '4x6' },
				snapshotHash: 'hash-2',
			})
			.returning()
		const request = new Request('https://app.test/')
		const orderId = await createPrintQuote(request, access, {
			lines: [
				{ designId: design.id, quantity: 1 },
				{ designId: other!.id, quantity: 1 },
			],
			address,
			scopeId: null,
		})
		const url = await startPrintCheckout(
			request,
			access,
			orderId,
			'https://app.test/x',
		)
		const detail = await getPrintOrderDetail(null, orderId)
		expect(detail.vendorOrders).toHaveLength(2)
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
				amount_total: detail.order.totalCents,
				total_details: { amount_tax: 0 },
				payment_intent: `pi_${orderId}`,
			} as never,
			'checkout.session.completed',
			{ later: () => {} },
		)
		// Both vendors' prices rose past the drift limit; Admin accepts.
		await db
			.update(PrintVendorOrder)
			.set({ wholesaleItemsCents: 1, wholesaleShippingCents: 1 })
			.where(eq(PrintVendorOrder.orderId, orderId))
		await db
			.update(PrintOrder)
			.set({ status: 'held', holdReason: 'price_drift' })
			.where(eq(PrintOrder.id, orderId))
		let now = Date.now()
		vi.spyOn(Date, 'now').mockImplementation(() => now)
		vi.spyOn(printFiles, 'getPrintFile').mockImplementation(async () => {
			now += 16_000
			return {
				kind: 'pdf',
				bytes: new Uint8Array(new ArrayBuffer(4)),
				objectKey: 'print/x.pdf',
				fresh: true,
			}
		})
		expect(await adminRetryPrintOrder(orderId, true)).toBe('deferred')
		vi.restoreAllMocks()
		// The continuation does not know Admin accepted: it must not hold again.
		await continuePrintSubmission(orderId)
		expect((await getPrintOrderDetail(null, orderId)).order).toMatchObject({
			status: 'submitted',
			holdReason: null,
		})
	})

	it('hands an order back only after rendering something new', async () => {
		const { orderId } = await paidOrderLater()
		let now = Date.now()
		vi.spyOn(Date, 'now').mockImplementation(() => now)
		// Cached files cost time but are no progress: the run keeps going.
		vi.spyOn(printFiles, 'getPrintFile').mockImplementation(async () => {
			now += 30_000
			return {
				kind: 'pdf',
				bytes: new Uint8Array(new ArrayBuffer(4)),
				objectKey: 'print/x.pdf',
			}
		})
		expect(await submitPrintOrder(orderId, { budgetMs: 1 })).toBe('done')
		expect((await getPrintOrderDetail(null, orderId)).order.status).toBe(
			'submitted',
		)
		vi.restoreAllMocks()
	})

	it('keeps the sending marker until every vendor is recorded', async () => {
		const { orderId } = await paidOrderLater()
		expect(await submitPrintOrder(orderId)).toBe('done')
		expect((await getPrintOrderDetail(null, orderId)).order).toMatchObject({
			status: 'submitted',
			holdReason: null,
		})
	})

	it('does not submit an order that was held after the sweep read it', async () => {
		const { orderId } = await paidOrderLater()
		await db
			.update(PrintOrder)
			.set({ status: 'held', holdReason: 'partial_cancel' })
			.where(eq(PrintOrder.id, orderId))
		expect(await submitPrintOrder(orderId)).toBe('done')
		expect((await getPrintOrderDetail(null, orderId)).order).toMatchObject({
			status: 'held',
			holdReason: 'partial_cancel',
		})
		// Only Admin's retry may take a held order.
		expect(await submitPrintOrder(orderId, { fromHeld: true })).toBe('done')
		expect((await getPrintOrderDetail(null, orderId)).order.status).toBe(
			'submitted',
		)
	})

	it('refunds a paid order the vendor refuses when it is re-quoted', async () => {
		const { orderId } = await paidOrderLater()
		vendorState.quoteError = 'rejected'
		expect(await submitPrintOrder(orderId)).toBe('done')
		const { order, vendorOrders } = await getPrintOrderDetail(null, orderId)
		expect(order).toMatchObject({
			status: 'refunded',
			failureReason: 'vendor_rejected',
		})
		expect(vendorOrders[0]).toMatchObject({
			status: 'failed',
			error: 'Refused',
			vendorOrderId: null,
		})
		expect(stripeMock.refunds.create).toHaveBeenCalledWith(
			expect.objectContaining({ payment_intent: `pi_${orderId}` }),
			expect.anything(),
		)
	})

	it('holds a paid order for a retry when the re-quote gets no answer', async () => {
		const { orderId } = await paidOrderLater()
		vendorState.quoteError = 'unavailable'
		expect(await submitPrintOrder(orderId)).toBe('done')
		const { order, vendorOrders } = await getPrintOrderDetail(null, orderId)
		expect(order).toMatchObject({
			status: 'held',
			holdReason: 'vendor_unavailable',
		})
		expect(vendorOrders[0]!.status).toBe('pending')
		expect(stripeMock.refunds.create).not.toHaveBeenCalled()
	})

	/**
	 * Paid desk cards in two sizes, the submission left for later: A6 prints at
	 * Gelato, and 4x6 at `vendorOf4x6` (one vendor order per vendor).
	 */
	async function paidTwoSizeOrder(vendorOf4x6: 'gelato' | 'prodigi') {
		const { access, design } = await setup()
		// Replaced as Admin does: one active row per product and size.
		await db
			.update(PrintVendorProduct)
			.set({ active: false })
			.where(eq(PrintVendorProduct.sizeKey, '4x6'))
		await db.insert(PrintVendorProduct).values({
			product: 'desk_card',
			sizeKey: '4x6',
			vendor: vendorOf4x6,
			vendorSku: `cards_4x6_${vendorOf4x6}`,
			bleedMm: 3,
		})
		const [other] = await db
			.insert(PrintDesign)
			.values({
				organizationId: access.organization.id,
				createdById: access.userId,
				name: 'Desk cards 4x6',
				product: 'desk_card',
				sizeKey: '4x6',
				style: 'classic',
				templateVersion: 1,
				content: {},
				status: 'approved',
				snapshot: { ...snapshot(), sizeKey: '4x6' },
				snapshotHash: 'hash-2',
			})
			.returning()
		const request = new Request('https://app.test/')
		const orderId = await createPrintQuote(request, access, {
			lines: [
				{ designId: design.id, quantity: 1 },
				{ designId: other!.id, quantity: 1 },
			],
			address,
			scopeId: null,
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
			{ later: () => {} },
		)
		const { vendorOrders } = await getPrintOrderDetail(null, orderId)
		return {
			orderId,
			gelato: vendorOrders.find((row) => row.vendor === 'gelato')!,
			prodigi: vendorOrders.find((row) => row.vendor === 'prodigi'),
		}
	}

	const refundedIntents = () =>
		stripeMock.refunds.create.mock.calls.map(
			(call) =>
				(call as unknown as [{ payment_intent: string }])[0].payment_intent,
		)

	async function vendorOrderRow(id: string) {
		const [row] = await db
			.select()
			.from(PrintVendorOrder)
			.where(eq(PrintVendorOrder.id, id))
		return row!
	}

	it('never refunds a vendor drop automatically while another vendor may have the rest', async () => {
		// Gelato has its part; sending the Prodigi part timed out, so Prodigi
		// may have it as well.
		const { orderId, gelato, prodigi } = await paidTwoSizeOrder('prodigi')
		await db
			.update(PrintVendorOrder)
			.set({ status: 'submitted', vendorOrderId: `mock_${Date.now()}_g` })
			.where(eq(PrintVendorOrder.id, gelato.id))
		await db
			.update(PrintOrder)
			.set({ status: 'held', holdReason: 'vendor_unknown' })
			.where(eq(PrintOrder.id, orderId))

		vendorState.value = 'cancelled'
		await syncOpenPrintOrders(1000)
		const held = await getPrintOrderDetail(null, orderId)
		expect(held.order).toMatchObject({
			status: 'held',
			holdReason: 'vendor_unknown',
			failureReason: 'vendor_cancelled',
			refundCents: 0,
		})
		expect((await vendorOrderRow(gelato.id)).status).toBe('cancelled')
		expect((await vendorOrderRow(prodigi!.id)).status).toBe('pending')
		expect(refundedIntents()).not.toContain(`pi_${orderId}`)

		// Sending the rest would ship half the order at the full price: Admin
		// checks the other vendor, then refunds.
		await expect(
			adminRetryPrintOrder(orderId, false, { checkedVendor: true }),
		).rejects.toMatchObject({ code: 'refund_needed' })
		await adminRefundPrintOrder(orderId, { checkedVendor: true })
		expect((await getPrintOrderDetail(null, orderId)).order).toMatchObject({
			status: 'refunded',
			failureReason: 'vendor_cancelled',
		})
	})

	it('cancels what it can on a vendor drop but leaves vendor-check and after-shipping holds to Admin', async () => {
		vendorState.value = 'cancelled'
		const now = Date.now()
		// A claim cut short with both parts recorded at their vendors.
		const stale = await paidTwoSizeOrder('prodigi')
		await db
			.update(PrintVendorOrder)
			.set({ status: 'submitted', vendorOrderId: `mock_${now}_g` })
			.where(eq(PrintVendorOrder.id, stale.gelato.id))
		await db
			.update(PrintVendorOrder)
			.set({ status: 'submitted', vendorOrderId: `mock_${now}_p` })
			.where(eq(PrintVendorOrder.id, stale.prodigi!.id))
		await db
			.update(PrintOrder)
			.set({ status: 'held', holdReason: 'stale_claim' })
			.where(eq(PrintOrder.id, stale.orderId))
		await syncPrintVendorOrder(await vendorOrderRow(stale.gelato.id))
		expect(
			(await getPrintOrderDetail(null, stale.orderId)).order,
		).toMatchObject({
			status: 'held',
			holdReason: 'stale_claim',
			failureReason: 'vendor_cancelled',
		})
		// The other vendor's part was cancelled while it still could be.
		expect((await vendorOrderRow(stale.prodigi!.id)).status).toBe('cancelled')

		// A parcel already came back: nothing is cancelled or refunded.
		const returned = await paidTwoSizeOrder('prodigi')
		await db
			.update(PrintVendorOrder)
			.set({
				status: 'returned',
				vendorOrderId: `mock_${now}_r`,
				shippedAt: new Date(),
			})
			.where(eq(PrintVendorOrder.id, returned.gelato.id))
		await db
			.update(PrintVendorOrder)
			.set({ status: 'submitted', vendorOrderId: `mock_${now}_s` })
			.where(eq(PrintVendorOrder.id, returned.prodigi!.id))
		await db
			.update(PrintOrder)
			.set({ status: 'held', holdReason: 'vendor_returned' })
			.where(eq(PrintOrder.id, returned.orderId))
		await syncPrintVendorOrder(await vendorOrderRow(returned.prodigi!.id))
		expect(
			(await getPrintOrderDetail(null, returned.orderId)).order,
		).toMatchObject({
			status: 'held',
			holdReason: 'vendor_returned',
			failureReason: 'vendor_cancelled',
		})
		expect((await vendorOrderRow(returned.gelato.id)).status).toBe('returned')

		expect(refundedIntents()).not.toContain(`pi_${stale.orderId}`)
		expect(refundedIntents()).not.toContain(`pi_${returned.orderId}`)
	})

	it('leaves a vendor drop for the next sync while a submission holds the order', async () => {
		const { orderId, gelato, prodigi } = await paidTwoSizeOrder('prodigi')
		await db
			.update(PrintVendorOrder)
			.set({ status: 'submitted', vendorOrderId: `mock_${Date.now()}_g` })
			.where(eq(PrintVendorOrder.id, gelato.id))
		// Phase 2 is sending the Prodigi part right now.
		await db
			.update(PrintOrder)
			.set({ status: 'submitting', holdReason: 'vendor_sending' })
			.where(eq(PrintOrder.id, orderId))
		vendorState.value = 'failed'
		await syncPrintVendorOrder(await vendorOrderRow(gelato.id))
		// Untouched, and the drop is not recorded, so the next sync sees it.
		expect((await getPrintOrderDetail(null, orderId)).order).toMatchObject({
			status: 'submitting',
			holdReason: 'vendor_sending',
		})
		expect((await vendorOrderRow(gelato.id)).status).toBe('submitted')
		expect(refundedIntents()).not.toContain(`pi_${orderId}`)

		// The send finished: both parts are recorded at their vendors.
		await db
			.update(PrintVendorOrder)
			.set({ status: 'submitted', vendorOrderId: `mock_${Date.now()}_p` })
			.where(eq(PrintVendorOrder.id, prodigi!.id))
		await db
			.update(PrintOrder)
			.set({ status: 'submitted', holdReason: null })
			.where(eq(PrintOrder.id, orderId))
		await syncPrintVendorOrder(await vendorOrderRow(gelato.id))
		expect((await getPrintOrderDetail(null, orderId)).order).toMatchObject({
			status: 'refunded',
			failureReason: 'vendor_failed',
		})
		expect((await vendorOrderRow(gelato.id)).status).toBe('failed')
		expect((await vendorOrderRow(prodigi!.id)).status).toBe('cancelled')
		expect(refundedIntents()).toContain(`pi_${orderId}`)
	})

	it('reroutes a vendor order only as a whole, never into a mix of two vendors', async () => {
		// Both sizes print at Gelato: one vendor order with two products.
		const { orderId, gelato } = await paidTwoSizeOrder('gelato')
		const before = await getPrintOrderDetail(null, orderId)
		expect(before.vendorOrders).toHaveLength(1)
		expect(before.items).toHaveLength(2)
		await db
			.update(PrintOrder)
			.set({ status: 'held', holdReason: 'vendor_unavailable' })
			.where(eq(PrintOrder.id, orderId))

		// Admin moves only the 4x6 size to Prodigi.
		await db
			.update(PrintVendorProduct)
			.set({ active: false })
			.where(eq(PrintVendorProduct.sizeKey, '4x6'))
		await db.insert(PrintVendorProduct).values({
			product: 'desk_card',
			sizeKey: '4x6',
			vendor: 'prodigi',
			vendorSku: 'cards_4x6_prodigi',
			bleedMm: 3,
		})
		await expect(adminRetryPrintOrder(orderId, false)).rejects.toMatchObject({
			code: 'mixed_vendors',
		})
		const refused = await getPrintOrderDetail(null, orderId)
		expect(refused.order).toMatchObject({
			status: 'held',
			holdReason: 'vendor_unavailable',
		})
		expect(refused.vendorOrders[0]).toMatchObject({
			vendor: 'gelato',
			status: 'pending',
		})
		expect(refused.items.map(({ item }) => item.vendor)).toEqual([
			'gelato',
			'gelato',
		])

		// Once both sizes print at Prodigi, the whole vendor order moves.
		await db
			.update(PrintVendorProduct)
			.set({ active: false })
			.where(eq(PrintVendorProduct.sizeKey, 'a6'))
		await db.insert(PrintVendorProduct).values({
			product: 'desk_card',
			sizeKey: 'a6',
			vendor: 'prodigi',
			vendorSku: 'cards_a6_prodigi',
			bleedMm: 3,
		})
		expect(await adminRetryPrintOrder(orderId, true)).toBe('done')
		const moved = await getPrintOrderDetail(null, orderId)
		expect(moved.order.status).toBe('submitted')
		expect(moved.vendorOrders[0]).toMatchObject({
			id: gelato.id,
			vendor: 'prodigi',
			status: 'submitted',
			// The new vendor's own method, not the old vendor's.
			shippingMethod: 'mock-standard',
		})
		expect(
			moved.items.map(({ item }) => [item.vendor, item.vendorSku]).sort(),
		).toEqual([
			['prodigi', 'cards_4x6_prodigi'],
			['prodigi', 'cards_a6_prodigi'],
		])
	})

	it('renders pieces with the bleed of the vendor SKU the order was priced with', async () => {
		const { orderId } = await paidOrderLater()
		// Admin replaces the mapping (Gelato, 4 mm bleed) before the order is sent.
		await db.update(PrintVendorProduct).set({ active: false })
		await db.insert(PrintVendorProduct).values({
			product: 'desk_card',
			sizeKey: 'a6',
			vendor: 'prodigi',
			vendorSku: 'cards_a6_prodigi',
			bleedMm: 0,
		})
		const render = vi.spyOn(printFiles, 'getPrintFile')
		expect(await submitPrintOrder(orderId)).toBe('done')
		expect(render).toHaveBeenCalled()
		for (const [input] of render.mock.calls) {
			expect(input).toMatchObject({ format: 'pro', bleedMm: 4 })
		}
		const { order, vendorOrders } = await getPrintOrderDetail(null, orderId)
		expect(order.status).toBe('submitted')
		expect(vendorOrders[0]!.vendor).toBe('gelato')
		vi.restoreAllMocks()
	})

	it('holds an order whose vendor SKU has no catalog row instead of guessing its bleed', async () => {
		const { orderId } = await paidOrderLater()
		await db.delete(PrintVendorProduct)
		const render = vi.spyOn(printFiles, 'getPrintFile')
		expect(await submitPrintOrder(orderId)).toBe('done')
		expect(render).not.toHaveBeenCalled()
		const { order, vendorOrders } = await getPrintOrderDetail(null, orderId)
		expect(order).toMatchObject({
			status: 'held',
			holdReason: 'render_unavailable',
		})
		expect(vendorOrders[0]).toMatchObject({
			status: 'pending',
			vendorOrderId: null,
		})
		vi.restoreAllMocks()
	})

	it('refunds a vendor failure before shipping, but holds one after it', async () => {
		const early = await paidOrder()
		vendorState.value = 'failed'
		await syncOpenPrintOrders()
		expect((await getPrintOrderDetail(null, early.orderId)).order.status).toBe(
			'refunded',
		)
		const refundedIntents = () =>
			stripeMock.refunds.create.mock.calls.map(
				(call) =>
					(call as unknown as [{ payment_intent: string }])[0].payment_intent,
			)
		expect(refundedIntents()).toContain(`pi_${early.orderId}`)

		vendorState.value = null
		const late = await paidOrder()
		await db
			.update(PrintVendorOrder)
			.set({ shippedAt: new Date() })
			.where(eq(PrintVendorOrder.orderId, late.orderId))
		vendorState.value = 'cancelled'
		await syncOpenPrintOrders()
		expect((await getPrintOrderDetail(null, late.orderId)).order).toMatchObject(
			{ status: 'held', holdReason: 'vendor_after_shipping' },
		)
		expect(refundedIntents()).not.toContain(`pi_${late.orderId}`)
	})

	it('reuses checkout parameters on a retry and never starts a second session blind', async () => {
		const { access, design } = await setup()
		const request = new Request('https://app.test/')
		const orderId = await createPrintQuote(request, access, {
			lines: [{ designId: design.id, quantity: 1 }],
			address,
			scopeId: null,
		})
		await startPrintCheckout(request, access, orderId, 'https://app.test/x')
		const { order } = await getPrintOrderDetail(null, orderId)
		const [first, firstOptions] = stripeMock.checkout.sessions.create.mock
			.calls[0] as unknown as [
			{ expires_at: number },
			{ idempotencyKey: string },
		]
		expect(first.expires_at).toBe(
			Math.floor(order.quoteExpiresAt.getTime() / 1000) + 31 * 60,
		)

		// Stripe cannot say what became of the session: no second one.
		stripeMock.checkout.sessions.retrieve.mockRejectedValueOnce(
			new Error('Stripe is down'),
		)
		await expect(
			startPrintCheckout(request, access, orderId, 'https://app.test/x'),
		).rejects.toMatchObject({ code: 'checkout_unavailable' })
		expect(stripeMock.checkout.sessions.create).toHaveBeenCalledTimes(1)

		// An expired session gets a new one under a new key.
		stripeMock.checkout.sessions.retrieve.mockResolvedValueOnce({
			id: order.stripeCheckoutSessionId!,
			status: 'expired',
			payment_status: 'unpaid',
			url: null,
		} as never)
		await startPrintCheckout(request, access, orderId, 'https://app.test/x')
		const [, secondOptions] = stripeMock.checkout.sessions.create.mock
			.calls[1] as unknown as [unknown, { idempotencyKey: string }]
		expect(secondOptions.idempotencyKey).not.toBe(firstOptions.idempotencyKey)
	})

	it('refuses to price a print with more pieces than one order may have', async () => {
		const { access, design } = await setup()
		const big = snapshot(PRINT_MAX_PIECES_PER_DESIGN + 1)
		await db
			.update(PrintDesign)
			.set({ snapshot: big })
			.where(eq(PrintDesign.id, design.id))
		await expect(
			createPrintQuote(new Request('https://app.test/'), access, {
				lines: [{ designId: design.id, quantity: 1 }],
				address,
				scopeId: null,
			}),
		).rejects.toMatchObject({ code: 'too_many_pieces' })
	})

	/** Paid, with the submission left for later (as the webhook does). */
	async function paidOrderLater() {
		const { access, design } = await setup()
		const request = new Request('https://app.test/')
		const orderId = await createPrintQuote(request, access, {
			lines: [{ designId: design.id, quantity: 1 }],
			address,
			scopeId: null,
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
			{ later: () => {} },
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
				scopeId: null,
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
		const { order: before } = await getPrintOrderDetail(null, orderId)
		await expect(
			adminRefundPrintOrder(orderId, { amountCents: before.totalCents + 1 }),
		).rejects.toMatchObject({ code: 'invalid_amount' })
		await adminRefundPrintOrder(orderId, { amountCents: 100 })
		const { order } = await getPrintOrderDetail(null, orderId)
		expect(order).toMatchObject({ refundCents: 100, holdReason: null })
		expect(order.status).not.toBe('held')
		// Tracking again: a second part needs a new partial-cancel hold.
		await expect(
			adminRefundPrintOrder(orderId, { amountCents: 100 }),
		).rejects.toMatchObject({ code: 'not_partial' })
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

	it('refunds or records a maybe-sent order only after Admin checked the vendor', async () => {
		const { orderId } = await paidOrder()
		const [vendorOrder] = await db
			.select()
			.from(PrintVendorOrder)
			.where(eq(PrintVendorOrder.orderId, orderId))
		await db
			.update(PrintVendorOrder)
			.set({ status: 'pending', vendorOrderId: null })
			.where(eq(PrintVendorOrder.id, vendorOrder!.id))
		await db
			.update(PrintOrder)
			.set({ status: 'held', holdReason: 'vendor_unknown' })
			.where(eq(PrintOrder.id, orderId))
		await expect(adminRefundPrintOrder(orderId)).rejects.toMatchObject({
			code: 'check_vendor',
		})
		// The operator cannot cancel it either: support checks the vendor.
		const { access } = await setup()
		const [row] = await db
			.select()
			.from(PrintOrder)
			.where(eq(PrintOrder.id, orderId))
		await expect(
			cancelPrintOrder(
				{
					...access,
					organization: { ...access.organization, id: row!.organizationId },
				},
				orderId,
			),
		).rejects.toMatchObject({ code: 'needs_support' })
		await expect(
			adminRefundPrintOrder(orderId, { amountCents: 100, checkedVendor: true }),
		).rejects.toMatchObject({ code: 'not_partial' })

		await adminRecordVendorOrder(orderId, [
			{ id: vendorOrder!.id, vendorOrderId: `mock_${Date.now()}` },
		])
		const detail = await getPrintOrderDetail(null, orderId)
		expect(detail.order).toMatchObject({
			status: 'submitted',
			holdReason: null,
		})
		expect(detail.vendorOrders[0]).toMatchObject({ status: 'submitted' })
	})
	it('never moves a paid order back when a stalled tab finishes its checkout', async () => {
		const { access, design } = await setup()
		const request = new Request('https://app.test/')
		const orderId = await createPrintQuote(request, access, {
			lines: [{ designId: design.id, quantity: 1 }],
			address,
			scopeId: null,
		})
		// While this tab waits on Stripe, another tab's payment lands.
		stripeMock.checkout.sessions.create.mockImplementationOnce(async () => {
			await db
				.update(PrintOrder)
				.set({
					status: 'submitted',
					stripeCheckoutSessionId: 'cs_paid_elsewhere',
					stripePaymentIntentId: 'pi_paid_elsewhere',
				})
				.where(eq(PrintOrder.id, orderId))
			return { id: 'cs_stalled', url: 'https://checkout.example/cs_stalled' }
		})
		await expect(
			startPrintCheckout(request, access, orderId, 'https://app.test/x'),
		).rejects.toMatchObject({ code: 'not_payable' })
		const { order } = await getPrintOrderDetail(null, orderId)
		expect(order).toMatchObject({
			status: 'submitted',
			stripeCheckoutSessionId: 'cs_paid_elsewhere',
		})
		// The stalled tab's session cannot take a second payment.
		expect(stripeMock.checkout.sessions.expire).toHaveBeenCalledWith(
			'cs_stalled',
		)
	})

	it('never erases a hold taken while the vendor status rolls up', async () => {
		const { orderId } = await paidOrder()
		// Placed long ago, so the emulator reports it shipped.
		await db
			.update(PrintVendorOrder)
			.set({ vendorOrderId: `mock_1_${orderId}` })
			.where(eq(PrintVendorOrder.orderId, orderId))
		// A partial cancel holds the order between the roll-up's read and write.
		// `db` is a proxy, so the race is injected on drizzle's own update.
		const realUpdate = db.update.bind(db)
		const original = BaseSQLiteDatabase.prototype.update
		let raced = false
		const spy = vi
			.spyOn(BaseSQLiteDatabase.prototype, 'update')
			.mockImplementation(function (
				this: BaseSQLiteDatabase<'async', unknown>,
				table: typeof PrintOrder,
			) {
				const builder = original.call(this, table) as ReturnType<
					typeof realUpdate
				>
				if (table !== PrintOrder || raced) return builder
				const realSet = builder.set.bind(builder)
				builder.set = ((values: { status?: string; holdReason?: unknown }) => {
					const chain = realSet(values as never)
					if (
						raced ||
						!values.status ||
						!['in_production', 'shipped', 'delivered'].includes(values.status)
					) {
						return chain
					}
					raced = true
					const realWhere = chain.where.bind(chain)
					chain.where = ((condition: Parameters<typeof realWhere>[0]) => {
						const query = realWhere(condition)
						const hold = () =>
							realUpdate(PrintOrder)
								.set({ status: 'held', holdReason: 'partial_cancel' })
								.where(eq(PrintOrder.id, orderId))
						return {
							returning: (...args: Parameters<typeof query.returning>) =>
								hold().then(() => query.returning(...args)),
							then: (
								resolve: (value: unknown) => unknown,
								reject: (error: unknown) => unknown,
							) =>
								hold()
									.then(() => query)
									.then(resolve, reject),
						}
					}) as never
					return chain
				}) as never
				return builder
			} as never)
		try {
			await syncOpenPrintOrders()
		} finally {
			spy.mockRestore()
		}
		expect(raced).toBe(true)
		const { order } = await getPrintOrderDetail(null, orderId)
		expect(order).toMatchObject({
			status: 'held',
			holdReason: 'partial_cancel',
		})
	})

	it('records a full refund Stripe already made instead of refunding again', async () => {
		const { orderId } = await paidOrder()
		const { order } = await getPrintOrderDetail(null, orderId)
		// The refund went through, then the request died before the ledger.
		stripeRefunds.push({
			payment_intent: order.stripePaymentIntentId!,
			amount: order.totalCents,
			status: 'succeeded',
		})
		await db
			.update(PrintOrder)
			.set({ status: 'held', holdReason: 'refund_failed' })
			.where(eq(PrintOrder.id, orderId))
		await adminRefundPrintOrder(orderId, { keepPrinting: true })
		const { order: after } = await getPrintOrderDetail(null, orderId)
		expect(after).toMatchObject({
			status: 'refunded',
			refundCents: order.totalCents,
		})
		expect(stripeMock.refunds.create).not.toHaveBeenCalled()
	})

	it('keeps a partial refund Stripe made before its answer was lost', async () => {
		const { orderId } = await paidOrder()
		await db
			.update(PrintOrder)
			.set({ status: 'held', holdReason: 'partial_cancel' })
			.where(eq(PrintOrder.id, orderId))
		stripeMock.refunds.create.mockImplementationOnce(async (params) => {
			stripeRefunds.push({ ...params, status: 'succeeded' })
			throw new Error('Request timed out')
		})
		await adminRefundPrintOrder(orderId, { amountCents: 100 })
		const { order } = await getPrintOrderDetail(null, orderId)
		expect(order.refundCents).toBe(100)

		// A ledger behind Stripe is caught up before any new refund.
		await db
			.update(PrintOrder)
			.set({ status: 'held', holdReason: 'partial_cancel', refundCents: 0 })
			.where(eq(PrintOrder.id, orderId))
		await expect(
			adminRefundPrintOrder(orderId, { amountCents: 100 }),
		).rejects.toMatchObject({ code: 'refund_reconciled' })
		const { order: caughtUp } = await getPrintOrderDetail(null, orderId)
		expect(caughtUp.refundCents).toBe(100)
		expect(stripeMock.refunds.create).toHaveBeenCalledTimes(1)
	})
})
