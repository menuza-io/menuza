import {
	handoffNeedsPayment,
	type PosOnlineOrderCommand,
	type PosOnlineOrderContact,
	type PosOnlineOrderDetail,
	type PosOnlineOrderRefund,
	type PosOnlineOrdersGrants,
	type PosPhonePickup,
} from '@repo/common/pos-online-orders'
import { OrdersError, type OrdersApi } from './api.ts'

/**
 * Demo mode's online orders: a sample service that lives in this tab, with the
 * same rules as the region (stale versions refused, payment at handoff before
 * handing over, refunds never past what was paid). Nothing is sent; a reload
 * starts again. A new web order arrives half a minute after the screen opens,
 * so the alert can be seen.
 */

const DEMO_GRANTS: PosOnlineOrdersGrants = {
	view: true,
	manage: true,
	contact: true,
	cancel: true,
	refund: true,
}

type DemoOrder = PosOnlineOrderDetail & {
	contact: PosOnlineOrderContact
	revision: number
}

const version = (id: string, revision: number) =>
	Array.from(`${id}:${revision}`)
		.map((char) => char.charCodeAt(0).toString(16))
		.join('')
		.padEnd(64, '0')
		.slice(0, 64)

const MIN = 60_000

function sample(
	id: string,
	values: Partial<DemoOrder> &
		Pick<DemoOrder, 'number' | 'guestName' | 'lines'>,
	now: number,
): DemoOrder {
	const subtotal = values.lines.reduce((sum, line) => sum + line.totalCents, 0)
	const base: DemoOrder = {
		id,
		version: version(id, 1),
		revision: 1,
		status: 'accepted',
		fulfillment: 'pickup',
		channel: 'web',
		tableLabel: null,
		createdAt: now - 5 * MIN,
		dueAt: null,
		paymentMethod: 'online',
		paymentStatus: 'paid',
		onTab: false,
		currency: 'USD',
		totalCents: subtotal,
		refundedCents: 0,
		itemCount: values.lines.reduce((sum, line) => sum + line.quantity, 0),
		openedAt: null,
		completedAt: null,
		cancelledAt: null,
		phoneMasked: '•••• 0142',
		hasEmail: true,
		delivery: null,
		subtotalCents: subtotal,
		taxCents: 0,
		deliveryFeeCents: 0,
		tipCents: 0,
		discountCents: 0,
		loyaltyDiscountCents: 0,
		paidAt: now - 5 * MIN,
		refundableCents: 0,
		refunds: [],
		history: [],
		contact: { phone: '+1 555 010 0142', email: 'guest@example.com' },
		...values,
	}
	return refreshed(base)
}

function refreshed(order: DemoOrder): DemoOrder {
	return {
		...order,
		version: version(order.id, order.revision),
		refundableCents:
			order.paymentMethod === 'online' &&
			order.paymentStatus === 'paid' &&
			!order.onTab
				? Math.max(0, order.totalCents - order.refundedCents)
				: 0,
	}
}

const line = (
	name: string,
	quantity: number,
	totalCents: number,
	extra: { options?: string[]; instructions?: string } = {},
) => ({
	name,
	variantNames: [],
	quantity,
	totalCents,
	instructions: extra.instructions ?? null,
	options: (extra.options ?? []).map((option) => ({
		name: option,
		quantity: 1,
		half: null,
	})),
})

export function createDemoOrders(start = Date.now()): OrdersApi & {
	/** Brings in the next sample order now (tests; the screen waits half a minute). */
	arrive: () => void
} {
	const orders = new Map<string, DemoOrder>()
	const add = (order: DemoOrder) => orders.set(order.id, order)
	add(
		sample(
			'demo-1041',
			{
				number: 'W-1041',
				guestName: 'Maya',
				createdAt: start - 2 * MIN,
				paymentMethod: 'handoff',
				paymentStatus: 'unpaid',
				paidAt: null,
				lines: [
					line('Classic Burger', 2, 2400, {
						options: ['Cheddar'],
						instructions: 'No onion',
					}),
					line('Truffle Fries', 1, 650),
				],
			},
			start,
		),
	)
	add(
		sample(
			'demo-qr12',
			{
				number: 'QR-0018',
				guestName: 'Table 12',
				channel: 'qr',
				fulfillment: 'dine_in',
				tableLabel: '12',
				paymentMethod: 'handoff',
				paymentStatus: 'unpaid',
				paidAt: null,
				onTab: true,
				status: 'preparing',
				openedAt: start - 6 * MIN,
				createdAt: start - 8 * MIN,
				lines: [line('Margherita Pizza', 1, 1400), line('Lemonade', 2, 900)],
			},
			start,
		),
	)
	add(
		sample(
			'demo-1039',
			{
				number: 'W-1039',
				guestName: 'Daniel',
				fulfillment: 'delivery',
				status: 'preparing',
				openedAt: start - 10 * MIN,
				createdAt: start - 12 * MIN,
				dueAt: start + 15 * MIN,
				delivery: {
					address: '12 Harbor Street',
					city: 'Springfield',
					unit: 'Apt 4',
					postalCode: null,
					notes: 'Ring the side door',
				},
				deliveryFeeCents: 300,
				lines: [line('Caesar Salad', 1, 1100), line('Iced Tea', 1, 400)],
			},
			start,
		),
	)
	add(
		sample(
			'demo-1037',
			{
				number: 'W-1037',
				guestName: 'Priya',
				status: 'ready',
				openedAt: start - 25 * MIN,
				createdAt: start - 30 * MIN,
				dueAt: start - 10 * MIN,
				lines: [line('Chicken Wrap', 2, 1800)],
			},
			start,
		),
	)
	add(
		sample(
			'demo-1030',
			{
				number: 'W-1030',
				guestName: 'Sam',
				status: 'completed',
				openedAt: start - 70 * MIN,
				createdAt: start - 80 * MIN,
				completedAt: start - 50 * MIN,
				lines: [line('Veggie Bowl', 1, 1300), line('Brownie', 1, 450)],
			},
			start,
		),
	)
	const phones: PosPhonePickup[] = [
		{
			id: 'demo-phone-1',
			number: 'C1-0012',
			guestName: 'Omar',
			pickupAt: start + 20 * MIN,
			status: 'open',
			currency: 'USD',
			totalCents: 1550,
		},
	]
	let arrived = false
	const arrive = () => {
		if (arrived) return
		arrived = true
		add(
			sample(
				'demo-1042',
				{
					number: 'W-1042',
					guestName: 'Lena',
					createdAt: Date.now(),
					lines: [line('Pancake Stack', 1, 950, { options: ['Maple syrup'] })],
				},
				Date.now(),
			),
		)
	}

	const respond = (order: DemoOrder) => {
		const { contact: _contact, revision: _revision, ...shown } = order
		return Promise.resolve({
			order: shown,
			grants: DEMO_GRANTS,
			serverNow: Date.now(),
		})
	}
	const find = (id: string) => {
		const order = orders.get(id)
		if (!order) throw new OrdersError('order_not_found', 404)
		return order
	}
	const change = (
		order: DemoOrder,
		patch: Partial<DemoOrder>,
		action: string,
		extra: { reason?: string; amountCents?: number } = {},
	) => {
		const next = refreshed({
			...order,
			...patch,
			revision: order.revision + 1,
			history: [
				{
					action,
					staffName: 'Demo',
					reason: extra.reason ?? null,
					amountCents: extra.amountCents ?? null,
					at: Date.now(),
				},
				...order.history,
			],
		})
		orders.set(order.id, next)
		return next
	}
	const keys = new Set<string>()

	return {
		arrive,
		feed: () => {
			if (Date.now() - start > 30_000) arrive()
			return Promise.resolve({
				orders: [...orders.values()].map(
					({
						contact: _c,
						revision: _r,
						lines: _l,
						phoneMasked: _p,
						hasEmail: _e,
						delivery: _d,
						subtotalCents: _s,
						taxCents: _t,
						deliveryFeeCents: _f,
						tipCents: _tip,
						discountCents: _dc,
						loyaltyDiscountCents: _ldc,
						paidAt: _paid,
						refundableCents: _rc,
						refunds: _refunds,
						history: _h,
						...summary
					}) => summary,
				),
				phonePickups: phones,
				grants: DEMO_GRANTS,
				serverNow: Date.now(),
				truncated: false,
			})
		},
		detail: async (id) => respond(find(id)),
		contact: async (id) => find(id).contact,
		command: async (id, command: PosOnlineOrderCommand) => {
			const order = find(id)
			if (command.action === 'open') {
				const next = order.openedAt
					? order
					: change(order, { openedAt: Date.now() }, 'opened')
				return respond(next)
			}
			if (command.action === 'reprint')
				return respond(
					change(order, {}, 'reprinted', { reason: command.ticket }),
				)
			if (command.expectedVersion !== order.version)
				throw new OrdersError('stale_version', 409)
			const done = order.status === 'completed' || order.status === 'cancelled'
			if (command.action === 'ready') {
				if (done || order.status === 'ready')
					throw new OrdersError('invalid_transition', 422)
				return respond(change(order, { status: 'ready' }, 'ready'))
			}
			if (command.action === 'handed_over') {
				if (done) throw new OrdersError('invalid_transition', 422)
				if (!command.markPaid && handoffNeedsPayment(order))
					throw new OrdersError('payment_required', 409)
				const paid =
					command.markPaid && handoffNeedsPayment(order)
						? { paymentStatus: 'paid', paidAt: Date.now() }
						: {}
				return respond(
					change(
						order,
						{ status: 'completed', completedAt: Date.now(), ...paid },
						'handed_over',
					),
				)
			}
			if (done) throw new OrdersError('invalid_transition', 422)
			return respond(
				change(
					order,
					{ status: 'cancelled', cancelledAt: Date.now() },
					'cancelled',
					{ reason: command.reason },
				),
			)
		},
		refund: async (id, refund: PosOnlineOrderRefund, key) => {
			const order = find(id)
			if (keys.has(key)) return respond(order)
			if (refund.expectedVersion !== order.version)
				throw new OrdersError('stale_version', 409)
			if (order.refundableCents === 0)
				throw new OrdersError('refund_complete', 409)
			const amount =
				'full' in refund ? order.refundableCents : refund.amountCents
			if (amount > order.refundableCents)
				throw new OrdersError(
					'refund_exceeds_payment',
					422,
					order.refundableCents,
				)
			keys.add(key)
			const refundedCents = order.refundedCents + amount
			return respond(
				change(
					order,
					{
						refundedCents,
						refunds: [
							...order.refunds,
							{ amountCents: amount, note: refund.note, at: Date.now() },
						],
					},
					'refunded',
					{
						amountCents: amount,
						reason: refundedCents >= order.totalCents ? 'full' : 'partial',
					},
				),
			)
		},
	}
}

let shared: ReturnType<typeof createDemoOrders> | null = null
/** The tab's one sample service: switching apps keeps what was done to it. */
export function demoOrders() {
	shared ??= createDemoOrders()
	return shared
}
