import { t } from '@lingui/macro'
import {
	posCustomerPhoneSchema,
	posPickupTimeZoneSchema,
	type PosOrderSource,
} from '@repo/common/pos-orders'
import {
	db,
	type LineVoid,
	type OrderType,
	type Payment,
	type PosOrder,
	type Reason,
	type Refund,
	type SignInMode,
	type StaffRef,
} from './db.ts'
import { issueCreditNote, issueInvoice } from './fiscal.ts'
import {
	computeTotals,
	lineSignature,
	lineUnitCents,
	type Adjustment,
	type CartLine,
} from './pricing.ts'

/** Default end of a business day (04:00), matching the server's default for a terminal. */
export const DEFAULT_DAY_START_MINUTES = 240

/**
 * The business day (YYYY-MM-DD) in the restaurant's own time zone, so a tablet
 * set to the wrong zone cannot change the day under a service. A day runs from
 * `dayStartMinutes` after midnight to the same time the next day, so a service
 * that goes past midnight stays on one day (and one run of order numbers).
 * Falls back to the device zone when none is known or the name is not valid.
 */
export const localDate = (
	at = new Date(),
	timeZone?: string,
	dayStartMinutes = 0,
): string => {
	const shifted = new Date(
		at.getTime() - Math.max(0, Math.min(720, dayStartMinutes)) * 60_000,
	)
	if (timeZone) {
		try {
			return new Intl.DateTimeFormat('en-CA', {
				timeZone,
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
			}).format(shifted)
		} catch {
			/* unknown zone name: use the device clock */
		}
	}
	const y = shifted.getFullYear()
	const m = String(shifted.getMonth() + 1).padStart(2, '0')
	const d = String(shifted.getDate()).padStart(2, '0')
	return `${y}-${m}-${d}`
}

/** Limits of the wire contract. The till enforces them so a paid order is never refused later. */
export const MAX_ORDER_LINES = 50
export const MAX_PAYMENTS = 20
export const MAX_REFUNDS = 20
export const MAX_LINE_VOIDS = 200

export type OrderDraft = {
	terminalCode: string
	locationId: string
	currency: string
	taxRatePercent: number
	taxInclusive?: boolean
	/** When the menu being sold from was downloaded. */
	catalogFetchedAt?: number | null
	orderType: OrderType
	orderSource?: PosOrderSource
	customerPhone?: string | null
	pickupAt?: number | null
	pickupTimeZone?: string | null
	customerName: string
	tableLabel: string
	lines: CartLine[]
	adjustments: Adjustment[]
	tipCents: number
	/** Restaurant slug, or `demo`: where this order may be sent. */
	origin?: string
	/** Who is ringing this up, and how their PIN was checked. Null when sign-in is not required. */
	staff?: StaffRef | null
	signIn?: SignInMode | null
	/** The restaurant's IANA time zone, for the business date. */
	timeZone?: string
	/** Minutes after midnight when the business day turns over. */
	dayStartMinutes?: number
}

/** Who did something that needs a reason, and who approved it. */
export type Audit = {
	reason: Reason
	by: StaffRef | null
	approvedBy: StaffRef | null
}

export type NewPayment = Omit<Payment, 'id' | 'at'>

export const paidCents = (order: Pick<PosOrder, 'payments'>): number =>
	order.payments.reduce((s, p) => s + p.amountCents, 0)

export const refundedCents = (order: Pick<PosOrder, 'refunds'>): number =>
	(order.refunds ?? []).reduce((s, r) => s + r.amountCents, 0)

export const balanceCents = (order: PosOrder): number =>
	Math.max(0, order.totals.totalCents - paidCents(order))

/** What can still be given back on a closed sale. */
export const refundableCents = (order: PosOrder): number =>
	order.status === 'paid'
		? Math.max(0, paidCents(order) - refundedCents(order))
		: 0

/** An order is queued again whenever it changes, whatever state it was in. */
const touched = (order: PosOrder, now: number): Partial<PosOrder> => ({
	revision: order.revision + 1,
	updatedAt: now,
	sync: 'pending',
	attempts: 0,
	nextAttemptAt: 0,
	lastError: null,
	syncedAt: null,
	heldReason: null,
})

function statusFor(order: PosOrder): PosOrder['status'] {
	if (order.status === 'void') return 'void'
	return order.totals.totalCents > 0 &&
		paidCents(order) >= order.totals.totalCents
		? 'paid'
		: 'open'
}

/** The open cash drawer shift, if any. Call inside a transaction that includes `db.shifts`. */
const openShiftId = async (): Promise<string | null> =>
	(await db.shifts.where('status').equals('open').first())?.id ?? null

function applyPayment(
	order: PosOrder,
	payment: NewPayment,
	now: number,
	shiftId: string | null = null,
): PosOrder {
	const balance = balanceCents(order)
	if (order.payments.length >= MAX_PAYMENTS) {
		throw new Error(t`A bill can take at most ${MAX_PAYMENTS} payments`)
	}
	if (payment.amountCents <= 0)
		throw new Error(t`Payment must be more than zero`)
	if (payment.amountCents > balance)
		throw new Error(t`Payment is more than the balance due`)
	const reference = payment.reference?.trim() || null
	if (reference && !/^[\w .#/-]{1,64}$/.test(reference)) {
		throw new Error(
			t`A reference may hold letters, digits, spaces and . # / - only`,
		)
	}
	const next: PosOrder = {
		...order,
		payments: [
			...order.payments,
			{ ...payment, reference, shiftId, id: crypto.randomUUID(), at: now },
		],
	}
	return { ...next, status: statusFor(next) }
}

/** Closing a sale issues its invoice, in the same transaction. */
async function withInvoiceIfClosed(
	order: PosOrder,
	now: number,
): Promise<PosOrder> {
	if (order.status !== 'paid' || order.fiscal.some((d) => d.kind === 'invoice'))
		return order
	return { ...order, fiscal: [...order.fiscal, await issueInvoice(order, now)] }
}

export function validateOrderDraft(draft: OrderDraft) {
	if (draft.lines.length === 0) throw new Error(t`Cannot save an empty order`)
	if (draft.lines.length > MAX_ORDER_LINES) {
		throw new Error(
			t`An order can have at most ${MAX_ORDER_LINES} different items. Split it across two orders.`,
		)
	}
	if (draft.orderSource === 'phone') {
		if (draft.orderType !== 'takeaway' || draft.tableLabel.trim())
			throw new Error(t`Phone orders are pickup only`)
		if (!draft.customerName.trim() || draft.customerName.trim().length > 120)
			throw new Error(t`Enter a customer name for this phone order`)
		if (!posCustomerPhoneSchema.safeParse(draft.customerPhone).success)
			throw new Error(t`Enter a valid callback number`)
		if (!posPickupTimeZoneSchema.safeParse(draft.pickupTimeZone).success)
			throw new Error(t`Choose a valid pickup time zone`)
		if (
			draft.pickupAt != null &&
			!Number.isFinite(new Date(draft.pickupAt).getTime())
		)
			throw new Error(t`Choose a valid pickup time`)
	}
}

const contactDetails = (draft: OrderDraft) =>
	draft.orderSource === 'phone'
		? {
				orderSource: 'phone' as const,
				customerPhone: posCustomerPhoneSchema.parse(draft.customerPhone),
				pickupAt: draft.pickupAt ?? null,
				pickupTimeZone: draft.pickupTimeZone ?? null,
			}
		: {
				orderSource: 'counter' as const,
				customerPhone: null,
				pickupAt: null,
				pickupTimeZone: null,
			}

/**
 * What a new version of a saved order takes off it: lines that are gone, the
 * part of a quantity that was lowered, and the old form of a line whose options
 * changed. Adding never needs a reason; taking off always does.
 */
export function removedLines(
	saved: CartLine[],
	next: CartLine[],
): Array<{ line: CartLine; quantity: number }> {
	const byId = new Map(next.map((l) => [l.id, l]))
	const removed: Array<{ line: CartLine; quantity: number }> = []
	for (const line of saved) {
		const now = byId.get(line.id)
		if (!now || lineSignature(now) !== lineSignature(line))
			removed.push({ line, quantity: line.quantity })
		else if (now.quantity < line.quantity)
			removed.push({ line, quantity: line.quantity - now.quantity })
	}
	return removed
}

/**
 * Saves a new order, optionally taking its first payment in the same
 * transaction. Numbers restart each business day and are allocated in that
 * transaction too, so two taps can never share one. With no payment the order
 * is an open tab.
 */
export async function createOrder(
	draft: OrderDraft,
	payment?: NewPayment,
	options: { closeIfFree?: boolean } = {},
): Promise<PosOrder> {
	validateOrderDraft(draft)
	const now = Date.now()
	const businessDate = localDate(
		new Date(now),
		draft.timeZone,
		draft.dayStartMinutes ?? DEFAULT_DAY_START_MINUTES,
	)
	return db.transaction('rw', db.orders, db.meta, db.shifts, async () => {
		const shiftId = await openShiftId()
		const counterKey = `seq:${businessDate}`
		const row = await db.meta.get(counterKey)
		const seq = ((row?.value as number | undefined) ?? 0) + 1
		await db.meta.put({ key: counterKey, value: seq })

		let order: PosOrder = {
			id: crypto.randomUUID(),
			number: `${draft.terminalCode}-${String(seq).padStart(4, '0')}`,
			businessDate,
			createdAt: now,
			orderType: draft.orderType,
			...contactDetails(draft),
			customerName: draft.customerName.trim(),
			tableLabel: draft.tableLabel.trim(),
			locationId: draft.locationId,
			currency: draft.currency,
			taxRatePercent: draft.taxRatePercent,
			taxInclusive: draft.taxInclusive ?? false,
			catalogFetchedAt: draft.catalogFetchedAt ?? null,
			shiftId,
			lines: draft.lines,
			lineVoids: [],
			adjustments: draft.adjustments,
			totals: computeTotals({
				lines: draft.lines,
				taxRatePercent: draft.taxRatePercent,
				taxInclusive: draft.taxInclusive,
				tipCents: draft.tipCents,
				adjustments: draft.adjustments,
			}),
			origin: draft.origin,
			staff: draft.staff ?? null,
			signIn: draft.signIn ?? null,
			voidedBy: null,
			status: 'open',
			payments: [],
			refunds: [],
			fiscal: [],
			revision: 1,
			updatedAt: now,
			sync: 'pending',
			attempts: 0,
			nextAttemptAt: 0,
			lastError: null,
			syncedAt: null,
			serverNumber: null,
		}
		if (payment) order = applyPayment(order, payment, now, shiftId)
		else if (options.closeIfFree) {
			if (order.totals.totalCents !== 0)
				throw new Error(t`This bill still has an amount to pay`)
			order = { ...order, status: 'paid', ...touched(order, now) }
		}
		order = await withInvoiceIfClosed(order, now)
		await db.orders.add(order)
		return order
	})
}

/**
 * Replaces an open tab's contents (items added or removed at the table).
 * Anything taken off the saved tab is recorded with who did it, why and who
 * approved it; the till never forgets what was on a bill. A tab that already
 * took a payment is frozen: the money taken was for a specific bill.
 */
export async function updateTab(
	id: string,
	draft: OrderDraft,
	audit: Audit | null = null,
): Promise<PosOrder> {
	validateOrderDraft(draft)
	const now = Date.now()
	return db.transaction('rw', db.orders, async () => {
		const order = await db.orders.get(id)
		if (!order) throw new Error(t`Order not found`)
		if (order.status !== 'open')
			throw new Error(t`This order is already closed`)
		if (order.transferredTo)
			throw new Error(
				t`This tab was taken over by terminal ${order.transferredTo}`,
			)
		if (order.payments.length > 0)
			throw new Error(t`Part of this bill is already paid`)
		const removed = removedLines(order.lines, draft.lines)
		if (removed.length > 0 && !audit)
			throw new Error(t`Say why items are coming off this tab`)
		const lineVoids: LineVoid[] = [
			...order.lineVoids,
			...removed.map(({ line, quantity }) => ({
				id: crypto.randomUUID(),
				itemId: line.itemId,
				name: line.name,
				variantLabel: line.variantLabel,
				quantity,
				unitCents: lineUnitCents(line),
				at: now,
				by: audit?.by ?? null,
				approvedBy: audit?.approvedBy ?? null,
				reason: audit?.reason ?? 'other',
			})),
		]
		if (lineVoids.length > MAX_LINE_VOIDS)
			throw new Error(
				t`Too many changes to one tab. Cancel it and start a new one.`,
			)
		const next: PosOrder = {
			...order,
			orderType: draft.orderType,
			...contactDetails(draft),
			customerName: draft.customerName.trim(),
			tableLabel: draft.tableLabel.trim(),
			lines: draft.lines,
			lineVoids,
			adjustments: draft.adjustments,
			totals: computeTotals({
				lines: draft.lines,
				taxRatePercent: order.taxRatePercent,
				taxInclusive: order.taxInclusive,
				tipCents: draft.tipCents,
				adjustments: draft.adjustments,
			}),
		}
		const saved = { ...next, ...touched(order, now) }
		await db.orders.put(saved)
		return saved
	})
}

/** Takes one payment toward an existing tab. Several may be taken (split bill). */
export async function addPayment(
	id: string,
	payment: NewPayment,
	tipCents?: number,
): Promise<PosOrder> {
	const now = Date.now()
	return db.transaction('rw', db.orders, db.meta, db.shifts, async () => {
		const shiftId = await openShiftId()
		const order = await db.orders.get(id)
		if (!order) throw new Error(t`Order not found`)
		if (order.status !== 'open')
			throw new Error(t`This order is already closed`)
		if (order.transferredTo)
			throw new Error(
				t`This tab was taken over by terminal ${order.transferredTo}`,
			)
		let base = order
		// The tip is fixed before the first payment so shares never drift.
		if (tipCents !== undefined && order.payments.length === 0) {
			base = {
				...order,
				totals: computeTotals({
					lines: order.lines,
					taxRatePercent: order.taxRatePercent,
					taxInclusive: order.taxInclusive,
					tipCents,
					adjustments: order.adjustments,
				}),
			}
		}
		const saved = await withInvoiceIfClosed(
			{ ...applyPayment(base, payment, now, shiftId), ...touched(order, now) },
			now,
		)
		await db.orders.put(saved)
		return saved
	})
}

/**
 * Cancels an unpaid tab. Kept (not deleted) so the cancellation syncs and shows in
 * history, with who cancelled it, when, why and who approved it.
 */
export async function voidTab(id: string, audit: Audit): Promise<void> {
	const now = Date.now()
	await db.transaction('rw', db.orders, async () => {
		const order = await db.orders.get(id)
		if (!order) return
		if (order.payments.length > 0)
			throw new Error(
				t`This bill took a payment: refund it instead of cancelling`,
			)
		if (order.status !== 'open') return
		await db.orders.put({
			...order,
			status: 'void',
			voidedBy: audit.by,
			voidedAt: now,
			voidReason: audit.reason,
			voidApprovedBy: audit.approvedBy,
			...touched(order, now),
		})
	})
}

/**
 * Gives money back on a closed sale, in the tenders it was paid with, newest
 * payment first. Each refund gets a credit note in the fiscal chain. A sale
 * refunded in full is marked refunded.
 */
export async function refundOrder(
	id: string,
	input: Audit & { amountCents: number; reference?: string | null },
): Promise<PosOrder> {
	const now = Date.now()
	return db.transaction('rw', db.orders, db.meta, db.shifts, async () => {
		const shiftId = await openShiftId()
		const order = await db.orders.get(id)
		if (!order) throw new Error(t`Order not found`)
		if (order.status !== 'paid')
			throw new Error(t`Only a paid order can be refunded`)
		const available = refundableCents(order)
		if (input.amountCents <= 0) throw new Error(t`Enter an amount to refund`)
		if (input.amountCents > available)
			throw new Error(t`That is more than was paid and not yet refunded`)
		const reference = input.reference?.trim() || null
		if (reference && !/^[\w .#/-]{1,64}$/.test(reference)) {
			throw new Error(
				t`A reference may hold letters, digits, spaces and . # / - only`,
			)
		}
		let left = input.amountCents
		const fresh: Refund[] = []
		for (const payment of [...order.payments].reverse()) {
			if (left === 0) break
			const already = order.refunds
				.filter((r) => r.paymentId === payment.id)
				.reduce((s, r) => s + r.amountCents, 0)
			const take = Math.min(left, payment.amountCents - already)
			if (take <= 0) continue
			fresh.push({
				id: crypto.randomUUID(),
				paymentId: payment.id,
				method: payment.method,
				amountCents: take,
				at: now,
				by: input.by,
				approvedBy: input.approvedBy,
				reason: input.reason,
				reference,
				shiftId,
			})
			left -= take
		}
		if (order.refunds.length + fresh.length > MAX_REFUNDS)
			throw new Error(t`A bill can take at most ${MAX_REFUNDS} refunds`)
		const fiscal = [...order.fiscal]
		// A sale closed before this till kept a fiscal chain gets its invoice now.
		if (!fiscal.some((d) => d.kind === 'invoice'))
			fiscal.push(await issueInvoice(order, now))
		for (const refund of fresh)
			fiscal.push(await issueCreditNote({ ...order, fiscal }, refund))
		const refunds = [...order.refunds, ...fresh]
		const full =
			refunds.reduce((s, r) => s + r.amountCents, 0) === paidCents(order)
		const saved: PosOrder = {
			...order,
			refunds,
			fiscal,
			status: full ? 'refunded' : 'paid',
			...touched(order, now),
		}
		await db.orders.put(saved)
		return saved
	})
}

export const todaysOrders = (
	timeZone?: string,
	dayStartMinutes = DEFAULT_DAY_START_MINUTES,
): Promise<PosOrder[]> =>
	db.orders
		.where('businessDate')
		.equals(localDate(new Date(), timeZone, dayStartMinutes))
		.reverse()
		.sortBy('createdAt')

/** Open tabs from any day: a tab may outlive the shift that started it. Not the ones another terminal took over. */
export const openTabs = (): Promise<PosOrder[]> =>
	db.orders
		.where('status')
		.equals('open')
		.filter((o) => !o.transferredTo)
		.sortBy('createdAt')

/** Includes prepaid pickups from earlier days, not just today's payments. */
export const phoneOrders = (): Promise<PosOrder[]> =>
	db.orders
		.filter((o) => o.orderSource === 'phone' && !o.transferredTo)
		.reverse()
		.sortBy('createdAt')

/** Puts a refused order back in the queue (a refusal that was really a transient fault). */
export async function requeueRejected(id: string): Promise<void> {
	await db.orders
		.where('id')
		.equals(id)
		.filter((o) => o.sync === 'rejected')
		.modify({
			sync: 'pending',
			attempts: 0,
			nextAttemptAt: 0,
			lastError: null,
		})
}

/** Settled history kept on the device. Open tabs and anything unsent are never pruned. */
export const RETENTION_DAYS = 14

/**
 * Removes orders that are fully finished AND already safe on the server, so a
 * shared tablet does not keep guest names and sales forever. Returns how many.
 */
export async function pruneSettledOrders(
	now = Date.now(),
	days = RETENTION_DAYS,
): Promise<number> {
	const cutoff = now - days * 24 * 60 * 60 * 1000
	return db.orders
		.where('createdAt')
		.below(cutoff)
		.filter(
			(o) =>
				o.sync === 'synced' &&
				(o.pickupAt ?? o.createdAt) < cutoff &&
				(o.status !== 'open' || Boolean(o.transferredTo)),
		)
		.delete()
}

/**
 * A bill that comes to nothing (a comp, a free item) has no payment to take, so
 * it is closed as paid without one. Only a bill whose total really is zero.
 */
export async function closeFreeOrder(id: string): Promise<PosOrder> {
	const now = Date.now()
	return db.transaction('rw', db.orders, db.meta, async () => {
		const order = await db.orders.get(id)
		if (!order) throw new Error(t`Order not found`)
		if (order.status !== 'open')
			throw new Error(t`This order is already closed`)
		if (order.totals.totalCents !== 0)
			throw new Error(t`This bill still has an amount to pay`)
		const saved = await withInvoiceIfClosed(
			{ ...order, status: 'paid' as const, ...touched(order, now) },
			now,
		)
		await db.orders.put(saved)
		return saved
	})
}

/** Saves a new bill that totals zero and closes it in one step. */
export async function createFreeOrder(draft: OrderDraft): Promise<PosOrder> {
	// One transaction: a sync between "open" and "paid" must never see a half-made order.
	return createOrder(draft, undefined, { closeIfFree: true })
}

/**
 * Notes that another terminal took these tabs over: this copy stops being an
 * open tab here and is kept as history. Returns how many changed.
 */
export async function markTransferredAway(
	transfers: Array<{ orderId: string; terminalCode: string }>,
): Promise<number> {
	let changed = 0
	await db.transaction('rw', db.orders, async () => {
		for (const t of transfers) {
			const order = await db.orders.get(t.orderId)
			if (!order || order.transferredTo || order.status !== 'open') continue
			await db.orders.update(order.id, { transferredTo: t.terminalCode })
			changed++
		}
	})
	return changed
}

/** The server's copy of a tab this terminal just took over, stored as one of its own. */
export type ServerTab = {
	id: string
	revision: number
	number: string
	businessDate: string
	createdAt: string
	locationId: string
	currency: string
	taxRatePercent: number | null
	taxInclusive: boolean
	orderType: OrderType
	orderSource?: PosOrderSource
	customerPhone?: string | null
	pickupAt?: string | null
	pickupTimeZone?: string | null
	customerName: string | null
	tableLabel: string | null
	staff: StaffRef | null
	signIn: SignInMode | null
	lines: Array<Omit<CartLine, 'id'>>
	lineVoids: Array<Omit<LineVoid, 'at'> & { at: string }>
	adjustments: Adjustment[]
	totals: PosOrder['totals']
	payments: Array<Omit<Payment, 'at' | 'changeCents'> & { at: string }>
}

/** A tab the server sent without a tax rate cannot be billed here: guessing 0 % would undercharge. */
export const canAdoptTab = (tab: Pick<ServerTab, 'taxRatePercent'>): boolean =>
	typeof tab.taxRatePercent === 'number' &&
	Number.isFinite(tab.taxRatePercent) &&
	tab.taxRatePercent >= 0

/**
 * Stores the server's copy of a tab this terminal just took over. Never
 * replaces a local copy that is newer, or has a change not yet sent: that copy
 * is what this till last did, and it goes up on the next sync.
 */
export async function adoptTab(
	tab: ServerTab,
	origin: string,
): Promise<PosOrder> {
	if (!canAdoptTab(tab))
		throw new Error(
			t`This tab has no tax rate on the server, so it cannot be billed here. Settle it on the terminal that opened it.`,
		)
	const taxRatePercent = tab.taxRatePercent as number
	const now = Date.now()
	const order: PosOrder = {
		id: tab.id,
		number: tab.number,
		businessDate: tab.businessDate,
		createdAt: Date.parse(tab.createdAt),
		orderType: tab.orderType,
		orderSource: tab.orderSource ?? 'counter',
		customerPhone: tab.customerPhone ?? null,
		pickupAt: tab.pickupAt ? Date.parse(tab.pickupAt) : null,
		pickupTimeZone: tab.pickupTimeZone ?? null,
		customerName: tab.customerName ?? '',
		tableLabel: tab.tableLabel ?? '',
		locationId: tab.locationId,
		currency: tab.currency,
		taxRatePercent,
		taxInclusive: tab.taxInclusive,
		catalogFetchedAt: null,
		lines: tab.lines.map((l) => ({ ...l, id: crypto.randomUUID() })),
		lineVoids: tab.lineVoids.map((v) => ({ ...v, at: Date.parse(v.at) })),
		adjustments: tab.adjustments,
		totals: tab.totals,
		status: 'open',
		payments: tab.payments.map((p) => ({
			...p,
			at: Date.parse(p.at),
			changeCents: 0,
		})),
		refunds: [],
		fiscal: [],
		revision: tab.revision,
		updatedAt: now,
		// Exactly what the server holds: nothing to send until it changes here.
		sync: 'synced',
		attempts: 0,
		nextAttemptAt: 0,
		lastError: null,
		syncedAt: now,
		serverNumber: null,
		staff: tab.staff,
		signIn: tab.signIn,
		voidedBy: null,
		origin,
	}
	return db.transaction('rw', db.orders, async () => {
		const local = await db.orders.get(tab.id)
		const unsent =
			local !== undefined &&
			local.sync !== 'synced' &&
			local.revision >= tab.revision
		if (local && (local.revision > tab.revision || unsent)) {
			// Keep this till's newer copy; it is open here again, not elsewhere.
			if (local.transferredTo)
				await db.orders.update(local.id, { transferredTo: null })
			return { ...local, transferredTo: null }
		}
		await db.orders.put(order)
		return order
	})
}

/** Marks orders taken in demo mode. Not a valid slug, so it can never equal a real restaurant. */
export const DEMO_ORIGIN = '@demo'

/** Is this order one the till may send to the restaurant it is currently set up for? */
export const isSendable = (
	order: Pick<PosOrder, 'origin'>,
	settings: { slug: string; demo: boolean },
): boolean =>
	!settings.demo &&
	order.origin !== DEMO_ORIGIN &&
	(order.origin === undefined ||
		order.origin === settings.slug.trim().toLowerCase())
