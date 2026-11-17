import {
	DAILY_DISH_MAX_UNITS,
	type DailyDishStatusData,
	type DailyDishStatusRowData,
	dailyDishRemaining,
} from '@repo/common/daily-dish-limits'
import {
	handoffNeedsPayment,
	onlineOrderInInbox,
	onlineOrdersSearchSince,
	POS_ONLINE_ORDERS_SEARCH_LIMIT,
	type PosOnlineOrderSummary,
	type PosOnlineOrderCommand,
	type PosOnlineOrderContact,
	type PosOnlineOrderDetail,
	type PosOnlineOrderDetailResponse,
	type PosOnlineOrderRefund,
	type PosOnlineOrdersGrants,
	type PosPhonePickup,
} from '@repo/common/pos-online-orders'
import {
	type OrderingPauseDuration,
	type PosStationControls,
} from '@repo/common/pos-station-controls'
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

/** How long a demo provider refund stays pending before it settles. */
export const DEMO_REFUND_SETTLE_MS = 4_000

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
/** The region's tick runs a little after the deadline: "Time is up" shows in between. */
const EXPIRY_GRACE_MS = 20_000

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

const isOnlinePaid = (order: {
	paymentMethod: string
	paymentStatus: string
	onTab: boolean
}) =>
	order.paymentMethod === 'online' &&
	order.paymentStatus === 'paid' &&
	!order.onTab

function refreshed(order: DemoOrder): DemoOrder {
	const pending = order.refunds
		.filter((row) => row.status === 'pending')
		.reduce((sum, row) => sum + row.amountCents, 0)
	const newest = order.refunds.at(-1)
	const refundStatus: NonNullable<PosOnlineOrderDetail['refundStatus']> =
		pending > 0
			? 'pending'
			: newest?.status === 'failed'
				? 'failed'
				: order.refundedCents <= 0
					? 'none'
					: order.refundedCents >= order.totalCents
						? 'full'
						: 'partial'
	return {
		...order,
		version: version(order.id, order.revision),
		refundPendingCents: pending,
		refundStatus,
		refundableCents: isOnlinePaid(order)
			? Math.max(0, order.totalCents - order.refundedCents - pending)
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
				// 24.00 + 6.50 of items and a 1.00 bag fee.
				totalCents: 3150,
				packagingFeeCents: 100,
				packagingFeeLabel: 'Packaging fee',
				utensilsRequested: false,
				pickupInstructions:
					'Park in the side lot.\nAsk at the bar for online orders.',
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
	// Waits for a person to accept or reject it (manual acceptance), paid online.
	add(
		sample(
			'demo-1043',
			{
				number: 'W-1043',
				guestName: 'Noor',
				status: 'pending_acceptance',
				createdAt: start - MIN,
				acceptanceDeadlineAt: start + 4 * MIN,
				lines: [
					line('Lamb Kofta Plate', 2, 3200, { instructions: 'Extra sauce' }),
					line('Mint Lemonade', 2, 700),
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
				disputed: true,
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
	// Past the inbox: only search finds these, and they open read-only.
	const DAY = 24 * 60 * MIN
	add(
		sample(
			'demo-0988',
			{
				number: 'W-0988',
				guestName: 'Maya',
				status: 'completed',
				openedAt: start - DAY - 40 * MIN,
				createdAt: start - DAY - 45 * MIN,
				completedAt: start - DAY - 20 * MIN,
				lines: [line('Classic Burger', 1, 1200), line('Lemonade', 1, 450)],
			},
			start,
		),
	)
	add(
		sample(
			'demo-0951',
			{
				number: 'W-0951',
				guestName: 'Jordan',
				fulfillment: 'delivery',
				status: 'cancelled',
				openedAt: start - 3 * DAY - 30 * MIN,
				createdAt: start - 3 * DAY - 35 * MIN,
				cancelledAt: start - 3 * DAY - 25 * MIN,
				phoneMasked: '•••• 0177',
				hasEmail: false,
				contact: { phone: '+1 555 010 0177', email: null },
				delivery: {
					address: '4 Elm Road',
					city: 'Springfield',
					unit: null,
					postalCode: null,
					notes: null,
				},
				lines: [line('Margherita Pizza', 2, 2800)],
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

	const respond = (
		order: DemoOrder,
		refundOutcome?: PosOnlineOrderDetailResponse['refundOutcome'],
	) => {
		const { contact: _contact, revision: _revision, ...shown } = order
		return Promise.resolve({
			order: shown,
			grants: DEMO_GRANTS,
			serverNow: Date.now(),
			...(refundOutcome ? { refundOutcome } : {}),
		})
	}
	/** A provider refund settles a few seconds after it is booked, like a real one. */
	const settleAt = new Map<string, number>()
	const settleDue = () => {
		const now = Date.now()
		for (const [id, at] of settleAt) {
			if (at > now) continue
			settleAt.delete(id)
			const order = orders.get(id)
			if (!order) continue
			const settled = order.refunds.map((row) =>
				row.status === 'pending'
					? { ...row, status: 'succeeded' as const }
					: row,
			)
			const refundedCents = settled
				.filter((row) => row.status !== 'failed' && row.status !== 'pending')
				.reduce((sum, row) => sum + row.amountCents, 0)
			orders.set(
				id,
				refreshed({
					...order,
					refunds: settled,
					refundedCents,
					revision: order.revision + 1,
				}),
			)
		}
	}
	/**
	 * Turns down an order waiting for acceptance, refunding a paid online order
	 * in full like the region does (the answer says whether the refund started).
	 */
	const turnDown = (order: DemoOrder, reason: string, action: string) => {
		const rejected = change(
			order,
			{
				status: 'cancelled',
				cancelledAt: Date.now(),
				rejectedReason: reason,
			},
			action,
			{ reason },
		)
		if (!isOnlinePaid(rejected)) return { order: rejected, outcome: undefined }
		const block = refundBlock(rejected)
		if (block)
			return { order: rejected, outcome: { started: false, code: block } }
		const amount = rejected.refundableCents
		settleAt.set(order.id, Date.now() + DEMO_REFUND_SETTLE_MS)
		return {
			order: change(
				rejected,
				{
					refunds: [
						...rejected.refunds,
						{
							amountCents: amount,
							note: '',
							at: Date.now(),
							kind: 'provider',
							status: 'pending',
							failureCode: null,
						},
					],
				},
				'refunded',
				{ amountCents: amount, reason: 'full' },
			),
			outcome: { started: true, code: null },
		}
	}
	/** Past its deadline the region's tick turns an order down: so does the demo. */
	const expireDue = () => {
		const now = Date.now()
		for (const order of orders.values())
			if (
				order.status === 'pending_acceptance' &&
				order.acceptanceDeadlineAt != null &&
				order.acceptanceDeadlineAt + EXPIRY_GRACE_MS <= now
			)
				turnDown(order, 'not_accepted_in_time', 'rejected')
	}
	/** Why a provider refund cannot start now, or null. */
	const refundBlock = (order: DemoOrder) => {
		if (!isOnlinePaid(order)) return 'order_not_refundable'
		if (order.disputed) return 'payment_disputed'
		if ((order.refundPendingCents ?? 0) > 0) return 'refund_pending'
		if (order.refundableCents === 0) return 'refund_complete'
		return null
	}
	const find = (id: string) => {
		expireDue()
		settleDue()
		const order = orders.get(id)
		if (!order) throw new OrdersError('order_not_found', 404)
		return order
	}
	/** Changes, contacts and reprints reach only the inbox, like the region. */
	const findInInbox = (id: string) => {
		const order = find(id)
		if (!onlineOrderInInbox(order, Date.now()))
			throw new OrdersError('order_not_found', 404)
		return order
	}
	const summaryOf = ({
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
	}: DemoOrder): PosOnlineOrderSummary => summary
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

	// Manager controls: the pause here and one dish that stock holds off.
	let pause: PosStationControls['pause'] = null
	let heldByStock: PosStationControls['heldByStock'] = [
		{
			id: 'demo-held-ribs',
			entityType: 'item',
			entityId: 'i-ribs',
			causeItemName: 'Pork ribs',
		},
	]
	const controlsNow = (): PosStationControls => ({
		locationId: 'demo',
		pause:
			pause && pause.until !== null && pause.until <= Date.now() ? null : pause,
		heldByStock,
		serverNow: Date.now(),
	})
	// Daily limits (#409): two capped dishes with what is sold and held today.
	const limits: Array<
		Omit<DailyDishStatusRowData, 'remaining'> & { key: string }
	> = [
		{
			key: 'item:i-lamb-shank',
			kind: 'item',
			id: 'i-lamb-shank',
			name: 'Lamb shank special',
			limit: 20,
			showRemaining: true,
			toppedUpUnits: 0,
			soldUnits: 14,
			heldUnits: 2,
		},
		{
			key: 'option:o-baklava',
			kind: 'option',
			id: 'o-baklava',
			name: 'Baklava',
			limit: 12,
			showRemaining: false,
			toppedUpUnits: 0,
			soldUnits: 12,
			heldUnits: 0,
		},
	]
	const limitRow = (row: (typeof limits)[number]): DailyDishStatusRowData => ({
		...row,
		remaining: dailyDishRemaining(row),
	})
	const PAUSE_MS: Record<OrderingPauseDuration, number | null> = {
		'15m': 15 * MIN,
		'30m': 30 * MIN,
		'60m': 60 * MIN,
		rest_of_day: null,
		until_resumed: null,
	}

	return {
		arrive,
		feed: () => {
			expireDue()
			settleDue()
			if (Date.now() - start > 30_000) arrive()
			return Promise.resolve({
				orders: [...orders.values()]
					.filter((order) => onlineOrderInInbox(order, Date.now()))
					.map(summaryOf),
				phonePickups: phones,
				grants: DEMO_GRANTS,
				serverNow: Date.now(),
				truncated: false,
			})
		},
		detail: async (id) => respond(find(id)),
		contact: async (id) => findInInbox(id).contact,
		controls: async () => controlsNow(),
		pause: async (command) => {
			const now = Date.now()
			if (command.action === 'resume') pause = null
			else {
				const length = PAUSE_MS[command.duration]
				const midnight = new Date(now)
				midnight.setHours(24, 0, 0, 0)
				pause = {
					pausedAt: now,
					until:
						length !== null
							? now + length
							: command.duration === 'rest_of_day'
								? midnight.getTime()
								: null,
				}
			}
			return controlsNow()
		},
		availability: async (command) => {
			const held = heldByStock.find(
				(entry) =>
					entry.entityType === command.entityType &&
					entry.entityId === command.entityId,
			)
			if (command.available && held) {
				if (!command.overrideStock) throw new OrdersError('held_by_stock', 409)
				heldByStock = heldByStock.filter((entry) => entry !== held)
			}
			return { ...controlsNow(), changed: true }
		},
		dailyLimits: async (): Promise<DailyDishStatusData> => ({
			enabled: true,
			businessDate: new Date().toISOString().slice(0, 10),
			rows: limits.map(limitRow),
		}),
		topUpDailyLimit: async (change) => {
			const row = limits.find((entry) => entry.key === change.key)
			if (!row) throw new OrdersError('daily_limit_not_found', 404)
			// The region's rule: add units, or state the amount left (which sets
			// the day's adjustment so sold, held and the amount left add up).
			const next =
				change.addUnits !== undefined
					? row.toppedUpUnits + change.addUnits
					: (change.amountLeft ?? 0) + row.soldUnits + row.heldUnits - row.limit
			row.toppedUpUnits = Math.max(
				-DAILY_DISH_MAX_UNITS,
				Math.min(DAILY_DISH_MAX_UNITS, next),
			)
			return limitRow(row)
		},
		search: async (query) => {
			const now = Date.now()
			const since = Math.max(onlineOrdersSearchSince(now), query.since ?? 0)
			const text = query.q?.trim().toLocaleLowerCase()
			const digits = query.phone?.trim()
			if (digits && !DEMO_GRANTS.contact)
				throw new OrdersError('permission_required', 403)
			const states: Record<string, string[]> = {
				open: ['pending_acceptance', 'accepted', 'preparing'],
				ready: ['ready'],
				completed: ['completed'],
				cancelled: ['cancelled'],
			}
			const matches = [...orders.values()]
				.filter(
					(order) =>
						order.createdAt >= since &&
						(!query.state ||
							query.state === 'all' ||
							states[query.state]!.includes(order.status)) &&
						(!query.fulfillment ||
							query.fulfillment === 'all' ||
							order.fulfillment === query.fulfillment) &&
						(text
							? order.number.toLocaleLowerCase().includes(text) ||
								order.guestName.toLocaleLowerCase().includes(text)
							: digits
								? order.contact.phone.replace(/\D/g, '').endsWith(digits)
								: false),
				)
				.sort((a, b) => b.createdAt - a.createdAt)
			return {
				results: matches
					.slice(0, POS_ONLINE_ORDERS_SEARCH_LIMIT)
					.map(summaryOf),
				truncated: matches.length > POS_ONLINE_ORDERS_SEARCH_LIMIT,
				since,
				serverNow: now,
			}
		},
		command: async (id, command: PosOnlineOrderCommand) => {
			const order = findInInbox(id)
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
			if (command.action === 'accept') {
				if (order.status !== 'pending_acceptance')
					throw new OrdersError('order_not_pending', 409)
				return respond(change(order, { status: 'accepted' }, 'accepted'))
			}
			if (command.action === 'reject') {
				if (order.status !== 'pending_acceptance')
					throw new OrdersError('order_not_pending', 409)
				const result = turnDown(order, command.reason, 'rejected')
				return respond(result.order, result.outcome)
			}
			if (command.action !== 'cancel')
				throw new OrdersError('invalid_transition', 422)
			if (done) throw new OrdersError('invalid_transition', 422)
			if (command.refund === 'full' && !isOnlinePaid(order))
				throw new OrdersError('order_not_refundable', 400)
			const cancelled = change(
				order,
				{ status: 'cancelled', cancelledAt: Date.now() },
				'cancelled',
				{ reason: command.reason },
			)
			if (command.refund !== 'full') return respond(cancelled)
			const block = refundBlock(cancelled)
			if (block) return respond(cancelled, { started: false, code: block })
			const amount = cancelled.refundableCents
			settleAt.set(order.id, Date.now() + DEMO_REFUND_SETTLE_MS)
			return respond(
				change(
					cancelled,
					{
						refunds: [
							...cancelled.refunds,
							{
								amountCents: amount,
								note: '',
								at: Date.now(),
								kind: 'provider',
								status: 'pending',
								failureCode: null,
							},
						],
					},
					'refunded',
					{ amountCents: amount, reason: 'full' },
				),
				{ started: true, code: null },
			)
		},
		refund: async (id, refund: PosOnlineOrderRefund, key) => {
			const order = findInInbox(id)
			if (keys.has(key)) return respond(order)
			if (refund.expectedVersion !== order.version)
				throw new OrdersError('stale_version', 409)
			if (order.disputed) throw new OrdersError('payment_disputed', 409)
			if ((order.refundPendingCents ?? 0) > 0)
				throw new OrdersError('refund_pending', 409)
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
			settleAt.set(order.id, Date.now() + DEMO_REFUND_SETTLE_MS)
			return respond(
				change(
					order,
					{
						refunds: [
							...order.refunds,
							{
								amountCents: amount,
								note: refund.note,
								at: Date.now(),
								kind: 'provider',
								status: 'pending',
								failureCode: null,
							},
						],
					},
					'refunded',
					{
						amountCents: amount,
						reason:
							amount >= order.refundableCents && order.refundedCents === 0
								? 'full'
								: 'partial',
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
