import { type PosFiscalDocument } from '@repo/common/pos-fiscal'
import { type PosOrderSource } from '@repo/common/pos-orders'
import Dexie, { type EntityTable } from 'dexie'
import { type Adjustment, type CartLine, type Totals } from './pricing.ts'
import { type CatalogSnapshot } from './types.ts'

export type OrderType = 'dine_in' | 'takeaway'
export type TenderMethod = 'cash' | 'card' | 'other'
export type SyncState = 'pending' | 'syncing' | 'synced' | 'rejected'

export type OrderStatus = 'open' | 'paid' | 'void' | 'refunded'

/** Who did something at the till. The name is a snapshot (first name, last initial). */
export type StaffRef = { id: string; name: string }
export type StaffRole = 'cashier' | 'manager'
export type SignInMode = 'online' | 'offline'
/** Why something came off a bill or money went back (the contract's `POS_REASON_VALUES`). */
export type Reason =
	| 'mistake'
	| 'guest_request'
	| 'out_of_stock'
	| 'quality'
	| 'wrong_charge'
	| 'other'

/** One payment toward a bill. A bill may take several (split payments). */
export type Payment = {
	id: string
	method: TenderMethod
	/** Cents applied to the bill. */
	amountCents: number
	/** Cash handed over (equals `amountCents` for card and other). */
	tenderedCents: number
	changeCents: number
	at: number
	/** Who took this payment (absent when the terminal does not require sign-in). */
	staff?: StaffRef | null
	/** Card terminal approval code or similar, for matching the processor's statement. */
	reference?: string | null
	/** The cash drawer shift it was taken in, when one was open. */
	shiftId?: string | null
}

/** Money given back against one payment, in the same tender. Never edited or removed. */
export type Refund = {
	id: string
	paymentId: string
	method: TenderMethod
	amountCents: number
	at: number
	by: StaffRef | null
	approvedBy: StaffRef | null
	reason: Reason
	reference: string | null
	shiftId?: string | null
}

/** Something taken off a saved order. Never edited or removed. */
/** A document signed for ZATCA (KSA), carried on its fiscal document and reported by the server. */
export type ZatcaDocument = {
	/** The number signed into the document; it never changes, even if the order is renumbered. */
	invoiceNumber: string
	uuid: string
	invoiceHash: string
	/** Signed UBL XML, base64. */
	xml: string
	/** Phase 2 QR payload (base64 TLV), printed on the receipt. */
	qr: string
	totalCents: number
	taxCents: number
}

/** One invoice or credit note in this till's fiscal chain. */
export type FiscalDocument = PosFiscalDocument & {
	zatca?: ZatcaDocument | null
}

export type LineVoid = {
	id: string
	itemId: string
	name: string
	variantLabel: string | null
	quantity: number
	unitCents: number
	at: number
	by: StaffRef | null
	approvedBy: StaffRef | null
	reason: Reason
}

/**
 * One row per order. It is both the receipt history and the upload queue: an
 * order is written here, in a single IndexedDB transaction, before the cashier
 * sees "paid", so nothing is lost if the tab or the network dies afterwards.
 */
export type PosOrder = {
	/** UUID, also the idempotency key on upload. */
	id: string
	/** Human number from this terminal, e.g. `T1-0042`. */
	number: string
	businessDate: string
	createdAt: number
	orderType: OrderType
	/** Optional for orders saved by an older till; absent means counter. */
	orderSource?: PosOrderSource
	customerPhone?: string | null
	pickupAt?: number | null
	pickupTimeZone?: string | null
	customerName: string
	tableLabel: string
	locationId: string
	currency: string
	taxRatePercent: number
	/** Menu prices already included `taxRatePercent`. */
	taxInclusive: boolean
	/** When the menu this was sold from was downloaded. */
	catalogFetchedAt: number | null
	/** The cash drawer shift it was rung up in, when one was open. */
	shiftId?: string | null
	lines: CartLine[]
	/** Items taken off after the order was saved. */
	lineVoids: LineVoid[]
	adjustments: Adjustment[]
	totals: Totals
	/** `open` is a tab: sent to the kitchen, paid later. */
	status: OrderStatus
	payments: Payment[]
	refunds: Refund[]
	/** The invoice (once closed) and a credit note per refund, in this till's fiscal chain. */
	fiscal: FiscalDocument[]
	/** Bumped on every change; the server keeps the highest it has seen. */
	revision: number
	updatedAt: number
	sync: SyncState
	attempts: number
	nextAttemptAt: number
	lastError: string | null
	syncedAt: number | null
	/** Number the server assigned, when it differs from the local one. */
	serverNumber: string | null
	/** Who rang the order up, and how their PIN was checked. */
	staff?: StaffRef | null
	signIn?: SignInMode | null
	/** Who cancelled it, when, why, and who approved it. */
	voidedBy?: StaffRef | null
	voidedAt?: number | null
	voidReason?: Reason | null
	voidApprovedBy?: StaffRef | null
	/** The server kept this upload for a manager to look at instead of applying it. */
	heldReason?: string | null
	/** Another terminal took this tab over (its code); this copy is history only. */
	transferredTo?: string | null
	/**
	 * Which restaurant this order was taken for (its slug), or `demo`. Orders are
	 * only ever sent to the restaurant they were taken for.
	 */
	origin?: string
	/** The number first shown, when a collision forced a new one. */
	renumberedFrom?: string | null
}

/** Cash put into or taken out of the drawer outside a sale. Never edited or removed. */
export type CashMovement = {
	id: string
	kind: 'pay_in' | 'pay_out'
	amountCents: number
	note: string
	at: number
	by: StaffRef | null
	approvedBy: StaffRef | null
}

/**
 * A cash drawer session on this terminal: opened with a float, closed with a
 * blind count. Uploaded like an order (each change is a new revision).
 */
export type Shift = {
	id: string
	status: 'open' | 'closed'
	businessDate: string
	openedAt: number
	openedBy: StaffRef | null
	openingFloatCents: number
	movements: CashMovement[]
	closedAt: number | null
	closedBy: StaffRef | null
	countedCashCents: number | null
	expectedCashCents: number | null
	revision: number
	sync: SyncState
	attempts: number
	nextAttemptAt: number
	lastError: string | null
	heldReason?: string | null
	/** Restaurant slug it was opened for (see `PosOrder.origin`). */
	origin?: string
}

export type KeyValue = { key: string; value: unknown }

/**
 * A person this device has seen sign in online, so they can sign in again with no
 * connection. `key` is a slow salted hash of their PIN (never the PIN).
 */
export type CachedStaff = {
	id: string
	name: string
	role: StaffRole
	key: string
	cachedAt: number
}

/**
 * Someone this till has seen at its time clock online, so an offline punch can
 * greet them and offer their roles. `key` is the same slow salted hash of the
 * PIN as `CachedStaff`; nothing here can punch on its own (the server checks
 * the PIN when the punch goes out).
 */
export type ClockPerson = {
	key: string
	/** Opaque: a saved punch carries it, so it never lands on whoever has the PIN later. */
	staffId?: string
	firstName: string
	positions: Array<{ id: string; name: string; nameAr: string | null }>
	/** The breaks their workplace offers (meal and rest), when it offers a choice. */
	breakKinds?: Array<'meal' | 'rest'>
	cachedAt: number
}

class PosDatabase extends Dexie {
	orders!: EntityTable<PosOrder, 'id'>
	catalog!: EntityTable<CatalogSnapshot, 'key'>
	meta!: EntityTable<KeyValue, 'key'>
	staff!: EntityTable<CachedStaff, 'id'>
	shifts!: EntityTable<Shift, 'id'>
	clockPeople!: EntityTable<ClockPerson, 'key'>

	constructor() {
		super('pos')
		this.version(1).stores({
			orders: 'id, sync, createdAt, businessDate, nextAttemptAt',
			catalog: 'key',
			meta: 'key',
		})
		this.version(2)
			.stores({
				orders: 'id, sync, status, createdAt, businessDate, nextAttemptAt',
			})
			.upgrade((tx) =>
				tx
					.table('orders')
					.toCollection()
					.modify((order: Record<string, unknown>) => {
						// v1 stored one `tender` and every order was already paid.
						const tender = order.tender as
							| {
									method: Payment['method']
									tenderedCents: number
									changeCents: number
							  }
							| undefined
						const totals = order.totals as Totals
						order.status = 'paid'
						order.revision = 1
						order.updatedAt = order.createdAt
						order.payments = tender
							? [
									{
										id: crypto.randomUUID(),
										method: tender.method,
										amountCents: totals.totalCents,
										tenderedCents: tender.tenderedCents,
										changeCents: tender.changeCents,
										at: order.createdAt,
									},
								]
							: []
						delete order.tender
					}),
			)
		// v3: people remembered from online sign-ins, for signing in with no connection.
		this.version(3).stores({ staff: 'id, key' })
		// v4: refunds, removed items, fiscal documents and tax mode on every order.
		this.version(4)
			.stores({})
			.upgrade((tx) =>
				tx
					.table('orders')
					.toCollection()
					.modify((order: Record<string, unknown>) => {
						order.lineVoids ??= []
						order.refunds ??= []
						order.fiscal ??= []
						order.taxInclusive ??= false
						order.catalogFetchedAt ??= null
					}),
			)
		// v5: cash drawer shifts.
		this.version(5).stores({ shifts: 'id, status, sync, openedAt' })
		// v6: people seen at the time clock, for offline punches.
		this.version(6).stores({ clockPeople: 'key' })
	}
}

export const db = new PosDatabase()

export async function getMeta<T>(key: string): Promise<T | undefined> {
	return (await db.meta.get(key))?.value as T | undefined
}

export async function setMeta(key: string, value: unknown): Promise<void> {
	await db.meta.put({ key, value })
}
