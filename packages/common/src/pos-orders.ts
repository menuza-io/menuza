import { z } from 'zod'
import { POS_FISCAL_KINDS, posRefundTaxCents } from './pos-fiscal.ts'

/**
 * Point-of-sale contract, shared by the regional tenant-api and its tests.
 * Phone pickup orders carry a customer name and phone, browser-direct to the
 * regional data plane only. Contact details are not permanent audit history.
 *
 * Credentials (same shape as kiosk credentials, organization id as a plain
 * prefix so the regional router can pick the database before anything is
 * verified):
 *
 *   pairing code  `ppc1.<orgId>.<random>`            one time, 10 minutes
 *   device secret `pdv1.<orgId>.<deviceId>.<random>` bound to one terminal
 *
 * A terminal is trusted to say what it sold (it may have been offline when it
 * sold it), so the order carries a snapshot of what was rung up and collected.
 * The server verifies the arithmetic, reprices against the live menu only to
 * flag differences for review, and never rejects a sale the till has already
 * taken money for because the menu changed in the meantime.
 */

export const POS_PAIRING_CODE_PREFIX = 'ppc1'
export const POS_DEVICE_SECRET_PREFIX = 'pdv1'
export const POS_PAIRING_CODE_TTL_MS = 10 * 60 * 1000
export const POS_RANDOM_BYTES = 32

const ORG_ID = '[A-Za-z0-9_-]{1,64}'
const RANDOM_PART = '[A-Za-z0-9_-]{43}'
const DEVICE_ID = '[A-Za-z0-9_-]{8,64}'

const PAIRING_CODE_PATTERN = new RegExp(
	`^${POS_PAIRING_CODE_PREFIX}\\.(${ORG_ID})\\.(${RANDOM_PART})$`,
)
const DEVICE_SECRET_PATTERN = new RegExp(
	`^${POS_DEVICE_SECRET_PREFIX}\\.(${ORG_ID})\\.(${DEVICE_ID})\\.(${RANDOM_PART})$`,
)

export function randomPosToken(byteLength = POS_RANDOM_BYTES): string {
	const bytes = new Uint8Array(byteLength)
	crypto.getRandomValues(bytes)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function formatPosPairingCode(orgId: string, random: string): string {
	const code = `${POS_PAIRING_CODE_PREFIX}.${orgId}.${random}`
	if (!PAIRING_CODE_PATTERN.test(code))
		throw new Error('Invalid pairing code parts')
	return code
}

export function formatPosDeviceSecret(
	orgId: string,
	deviceId: string,
	random: string,
): string {
	const secret = `${POS_DEVICE_SECRET_PREFIX}.${orgId}.${deviceId}.${random}`
	if (!DEVICE_SECRET_PATTERN.test(secret))
		throw new Error('Invalid device secret parts')
	return secret
}

export function parsePosPairingCode(
	value: unknown,
): { orgId: string; random: string } | null {
	if (typeof value !== 'string' || value.length > 160) return null
	const match = PAIRING_CODE_PATTERN.exec(value)
	return match ? { orgId: match[1]!, random: match[2]! } : null
}

export function parsePosDeviceSecret(
	value: unknown,
): { orgId: string; deviceId: string; random: string } | null {
	if (typeof value !== 'string' || value.length > 200) return null
	const match = DEVICE_SECRET_PATTERN.exec(value)
	return match
		? { orgId: match[1]!, deviceId: match[2]!, random: match[3]! }
		: null
}

/** Messages fed to HMAC for stored credential hashes. */
export const posSecretHashMessage = (secret: string) => `pos-device:${secret}`
export const posPairingCodeHashMessage = (code: string) => `pos-pair:${code}`

// ---------------------------------------------------------------------------
// Order wire format (terminal -> regional tenant-api)
// ---------------------------------------------------------------------------

/**
 * Version of the order upload contract the till speaks, sent as the
 * `Pos-Contract` header. A server that cannot read an upload (an older or newer
 * contract, a till and a regional node deployed at different times) holds it
 * for review instead of refusing it, so a paid sale is never stranded on a
 * tablet. Every field added since version 1 has a default, so version 1 tills
 * keep working. Version 4 adds each line's id and when it was sent (both
 * optional): deploy the regional API first, as a version 3 node holds them.
 */
export const POS_CONTRACT_VERSION = 4
export const POS_CONTRACT_HEADER = 'Pos-Contract'

export const POS_ORDER_STATUS_VALUES = [
	'open',
	'paid',
	'void',
	'refunded',
] as const
export type PosOrderStatus = (typeof POS_ORDER_STATUS_VALUES)[number]
export const POS_PAYMENT_METHOD_VALUES = ['cash', 'card', 'other'] as const
export const POS_ORDER_TYPE_VALUES = ['dine_in', 'takeaway'] as const
export const POS_ORDER_SOURCE_VALUES = ['counter', 'phone'] as const
export type PosOrderSource = (typeof POS_ORDER_SOURCE_VALUES)[number]

/** Local or international callback number, not an authenticated customer account. */
export const posCustomerPhoneSchema = z
	.string()
	.trim()
	.max(32)
	.transform((value) =>
		value
			.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x660))
			.replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x6f0))
			.replace(/[ ()-]/g, ''),
	)
	.pipe(z.string().regex(/^\+?[0-9]{7,15}$/, 'Enter a valid callback number'))

export const posPickupTimeZoneSchema = z
	.string()
	.max(100)
	.refine((value) => {
		try {
			new Intl.DateTimeFormat('en', { timeZone: value }).format()
			return true
		} catch {
			return false
		}
	}, 'Invalid pickup time zone')
/** Why an item was taken off a saved order, an order was cancelled, or money was given back. */
export const POS_REASON_VALUES = [
	'mistake',
	'guest_request',
	'out_of_stock',
	'quality',
	'wrong_charge',
	'other',
] as const
export type PosReason = (typeof POS_REASON_VALUES)[number]

/** Most line removals one order can record. */
export const POS_MAX_LINE_VOIDS = 200
export const POS_MAX_REFUNDS = 20

const cents = z.number().int().min(0).max(100_000_000)
const uuid = z.string().uuid()
const instant = z.string().datetime({ offset: true })
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
/** A card terminal approval code, last four digits or similar: never a card number. */
const tenderReference = z
	.string()
	.trim()
	.max(64)
	.regex(
		/^[\w .#/-]*$/,
		'reference may hold letters, digits, spaces and . # / - only',
	)
	.nullable()
	.default(null)

/**
 * Characters XML 1.0 does not allow (C0 controls other than tab, newline and
 * carriage return, U+FFFE, U+FFFF) and lone surrogates. Text that ends up in a
 * signed ZATCA document (item names and variant labels) is stored without
 * them, as the till signs it (`xmlSafe` in `@repo/zatca`): refusing them here
 * would hold a sale that is already closed and signed.
 */
const XML_ILLEGAL =
	// eslint-disable-next-line no-control-regex
	/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const signedText = (max: number) =>
	z
		.string()
		.transform((v) => v.replace(XML_ILLEGAL, ''))
		.pipe(z.string().min(1).max(max))

export const posOrderOptionSchema = z.strictObject({
	groupId: z.string().min(1).max(100),
	groupName: z.string().max(200),
	optionId: z.string().min(1).max(100),
	optionName: z.string().max(200),
	quantity: z.number().int().min(1).max(50),
	unitCents: cents,
	taxable: z.boolean(),
})

export const posOrderLineSchema = z.strictObject({
	/**
	 * The till's own id for the line, the same in every revision (contract 4).
	 * The kitchen tells dishes apart by it, so taking one off does not reset the
	 * progress of the dishes after it.
	 */
	id: z.string().min(1).max(100).optional(),
	itemId: z.string().min(1).max(100),
	name: signedText(200),
	variantId: z.string().min(1).max(100).nullable(),
	variantLabel: z
		.string()
		.transform((v) => v.replace(XML_ILLEGAL, ''))
		.pipe(z.string().max(200))
		.nullable(),
	quantity: z.number().int().min(1).max(50),
	baseCents: cents,
	instructions: z.string().trim().max(280),
	options: z.array(posOrderOptionSchema).max(50),
	/** When the till sent the line to the kitchen: its round on a tab (contract 4). */
	sentAt: instant.optional(),
})

/**
 * Who did something at the till, as signed in there. The name is a snapshot (first
 * name and last initial) so history reads correctly after a rename or departure.
 */
export const posStaffSchema = z.strictObject({
	id: z.string().min(1).max(100),
	name: z.string().trim().min(1).max(120),
})
export type PosStaff = z.infer<typeof posStaffSchema>

export const posPaymentSchema = z.strictObject({
	id: uuid,
	method: z.enum(POS_PAYMENT_METHOD_VALUES),
	amountCents: cents.min(1),
	tenderedCents: cents,
	at: instant,
	/** Who took this payment. Null when the terminal does not require sign-in. */
	staff: posStaffSchema.nullable(),
	/** Card terminal approval code or similar, so the sale can be matched to the processor's statement. */
	reference: tenderReference,
	/** The cash drawer shift it was taken in (terminals that track shifts). */
	shiftId: uuid.nullable().default(null),
})

/**
 * Something taken off an order after it was saved (an item removed from a tab,
 * or its quantity lowered). Append-only: the order's `lines` say what is on the
 * bill now, these say what came off, when, by whom and why.
 */
export const posLineVoidSchema = z.strictObject({
	id: uuid,
	itemId: z.string().min(1).max(100),
	name: z.string().min(1).max(200),
	variantLabel: z.string().max(200).nullable(),
	quantity: z.number().int().min(1).max(50),
	/** Price of one unit including its options, as it was on the bill. */
	unitCents: cents,
	at: instant,
	by: posStaffSchema.nullable(),
	/** The manager who approved it, when the person doing it was not one. */
	approvedBy: posStaffSchema.nullable(),
	reason: z.enum(POS_REASON_VALUES),
})

/** Money given back against one payment, in the same tender. Append-only. */
export const posRefundSchema = z.strictObject({
	id: uuid,
	paymentId: uuid,
	method: z.enum(POS_PAYMENT_METHOD_VALUES),
	amountCents: cents.min(1),
	at: instant,
	by: posStaffSchema.nullable(),
	approvedBy: posStaffSchema.nullable(),
	reason: z.enum(POS_REASON_VALUES),
	reference: tenderReference,
	shiftId: uuid.nullable().default(null),
})

/** An invoice or credit note in the till's fiscal chain (see `pos-fiscal.ts`). */
export const posFiscalDocumentSchema = z.strictObject({
	chainId: uuid,
	counter: z.number().int().min(1).max(1_000_000_000),
	kind: z.enum(POS_FISCAL_KINDS),
	docId: uuid,
	orderId: uuid,
	at: instant,
	currency: z.string().regex(/^[A-Z]{3}$/),
	totalCents: cents,
	taxCents: cents,
	previousHash: sha256,
	hash: sha256,
	/**
	 * The signed ZATCA document, when the till is an onboarded EGS unit (KSA).
	 * The server reports it to ZATCA; `invoiceHash` is the next document's PIH.
	 */
	zatca: z
		.strictObject({
			/** The invoice or note number signed into the document (cbc:ID); fixed once signed. */
			invoiceNumber: z.string().trim().min(1).max(127),
			uuid,
			invoiceHash: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
			/** Signed UBL XML, base64. */
			xml: z
				.string()
				.regex(/^[A-Za-z0-9+/]+={0,2}$/)
				.max(150_000),
			/** The Phase 2 QR payload printed on the receipt. */
			qr: z
				.string()
				.regex(/^[A-Za-z0-9+/]+={0,2}$/)
				.max(2_000),
			totalCents: cents,
			taxCents: cents,
		})
		.nullable()
		.default(null),
})

export const posAdjustmentSchema = z.strictObject({
	id: z.string().min(1).max(100),
	kind: z.enum(['discount', 'loyalty']),
	label: z.string().max(120),
	amountCents: cents.min(1),
})

export const posTotalsSchema = z.strictObject({
	subtotalCents: cents,
	adjustmentCents: cents,
	taxCents: cents,
	tipCents: cents,
	totalCents: cents,
})

export type PosOrderLine = z.infer<typeof posOrderLineSchema>
export type PosLineVoid = z.infer<typeof posLineVoidSchema>
export type PosRefund = z.infer<typeof posRefundSchema>
export type PosFiscalDocumentWire = z.infer<typeof posFiscalDocumentSchema>

export const posLineTotalCents = (line: PosOrderLine): number =>
	(line.baseCents +
		line.options.reduce((sum, o) => sum + o.unitCents * o.quantity, 0)) *
	line.quantity

export const posOrderRequestSchema = z
	.strictObject({
		id: uuid,
		revision: z.number().int().min(1).max(100_000),
		status: z.enum(POS_ORDER_STATUS_VALUES),
		number: z.string().trim().min(1).max(24),
		/** The restaurant's business day (it may end after midnight). Numbers restart daily, so `number` is unique per terminal per day. */
		businessDate: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/, 'businessDate must be YYYY-MM-DD'),
		createdAt: instant,
		locationId: z.string().min(1).max(100),
		/** What was actually charged, so a sale is storable even when the menu cannot be checked. */
		currency: z
			.string()
			.regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO code'),
		/** The tax rate the bill was priced with. Lets another terminal take the tab over. */
		taxRatePercent: z
			.number()
			.finite()
			.min(0)
			.max(100)
			.nullable()
			.default(null),
		/** Whether menu prices already included that tax. */
		taxInclusive: z.boolean().default(false),
		/** When the till last downloaded the menu it sold from (tells stale prices from wrong ones). */
		catalogFetchedAt: instant.nullable().default(null),
		/** The cash drawer shift it was rung up in (terminals that track shifts). */
		shiftId: uuid.nullable().default(null),
		orderType: z.enum(POS_ORDER_TYPE_VALUES),
		orderSource: z.enum(POS_ORDER_SOURCE_VALUES).default('counter'),
		customerPhone: posCustomerPhoneSchema.nullable().default(null),
		/** Null means ASAP; otherwise an absolute instant in the restaurant's time zone. */
		pickupAt: instant.nullable().default(null),
		pickupTimeZone: posPickupTimeZoneSchema.nullable().default(null),
		customerName: z.string().trim().max(120).nullable(),
		tableLabel: z.string().trim().max(40).nullable(),
		/** Who rang the order up. Null when the terminal does not require sign-in. */
		staff: posStaffSchema.nullable(),
		/** Whether that person's PIN was checked by the server or only by the till (offline). */
		signIn: z.enum(['online', 'offline']).nullable(),
		/** Who cancelled it, on a cancelled order. */
		voidedBy: posStaffSchema.nullable(),
		/** When, why and with whose approval it was cancelled. */
		voidedAt: instant.nullable().default(null),
		voidReason: z.enum(POS_REASON_VALUES).nullable().default(null),
		voidApprovedBy: posStaffSchema.nullable().default(null),
		lines: z.array(posOrderLineSchema).min(1).max(50),
		lineVoids: z.array(posLineVoidSchema).max(POS_MAX_LINE_VOIDS).default([]),
		adjustments: z.array(posAdjustmentSchema).max(10).default([]),
		totals: posTotalsSchema,
		payments: z.array(posPaymentSchema).max(20),
		refunds: z.array(posRefundSchema).max(POS_MAX_REFUNDS).default([]),
		fiscal: z
			.array(posFiscalDocumentSchema)
			.max(POS_MAX_REFUNDS + 1)
			.default([]),
	})
	.superRefine((order, ctx) => {
		const issue = (message: string, path: (string | number)[] = []) =>
			ctx.addIssue({ code: z.ZodIssueCode.custom, message, path })
		if (order.orderSource === 'phone') {
			if (order.orderType !== 'takeaway' || order.tableLabel)
				issue('phone orders are pickup only', ['orderType'])
			// Both may be null after regional contact erasure; a transferred tab
			// must still be payable without collecting the person's details again.
			if (Boolean(order.customerName) !== Boolean(order.customerPhone))
				issue('phone order contact is incomplete', ['customerPhone'])
			if (!order.pickupTimeZone)
				issue('phone orders need a pickup time zone', ['pickupTimeZone'])
		} else if (order.customerPhone || order.pickupAt || order.pickupTimeZone) {
			issue('pickup contact details belong to phone orders', ['orderSource'])
		}
		const subtotal = order.lines.reduce((s, l) => s + posLineTotalCents(l), 0)
		if (subtotal !== order.totals.subtotalCents) {
			issue('subtotal does not match the lines', ['totals', 'subtotalCents'])
		}
		const adjustments = order.adjustments.reduce((s, a) => s + a.amountCents, 0)
		if (Math.min(subtotal, adjustments) !== order.totals.adjustmentCents) {
			issue('adjustments do not match the totals', [
				'totals',
				'adjustmentCents',
			])
		}
		// Inclusive tax is already inside the subtotal; exclusive tax is added to it.
		const total =
			order.totals.subtotalCents -
			order.totals.adjustmentCents +
			(order.taxInclusive ? 0 : order.totals.taxCents) +
			order.totals.tipCents
		if (total !== order.totals.totalCents) {
			issue('total does not add up', ['totals', 'totalCents'])
		}
		const ids = new Set(order.payments.map((p) => p.id))
		if (ids.size !== order.payments.length)
			issue('duplicate payment id', ['payments'])
		const paid = order.payments.reduce((s, p) => s + p.amountCents, 0)
		if (paid > order.totals.totalCents)
			issue('payments exceed the total', ['payments'])
		const closed = order.status === 'paid' || order.status === 'refunded'
		if (closed && paid !== order.totals.totalCents) {
			issue('a paid order must be fully paid', ['status'])
		}
		if (
			order.status === 'open' &&
			order.totals.totalCents > 0 &&
			paid >= order.totals.totalCents
		) {
			issue('a fully paid order cannot stay open', ['status'])
		}
		if (order.status === 'void' && order.payments.length > 0) {
			issue('a cancelled order cannot hold payments; refund it instead', [
				'status',
			])
		}
		for (const [index, p] of order.payments.entries()) {
			if (
				p.method === 'cash'
					? p.tenderedCents < p.amountCents
					: p.tenderedCents !== p.amountCents
			) {
				issue('tendered amount is not valid for this method', [
					'payments',
					index,
					'tenderedCents',
				])
			}
		}

		if (
			new Set(order.lineVoids.map((v) => v.id)).size !== order.lineVoids.length
		) {
			issue('duplicate line void id', ['lineVoids'])
		}

		// Refunds: against a payment of this order, in its tender, never more than it.
		const refundIds = new Set(order.refunds.map((r) => r.id))
		if (refundIds.size !== order.refunds.length)
			issue('duplicate refund id', ['refunds'])
		if (order.refunds.length > 0 && !closed) {
			issue('only a paid order can be refunded', ['refunds'])
		}
		const byPayment = new Map(order.payments.map((p) => [p.id, p]))
		const refundedPerPayment = new Map<string, number>()
		for (const [index, r] of order.refunds.entries()) {
			const payment = byPayment.get(r.paymentId)
			if (!payment) {
				issue('a refund must name a payment of this order', [
					'refunds',
					index,
					'paymentId',
				])
				continue
			}
			if (payment.method !== r.method) {
				issue('a refund goes back in the tender it was paid with', [
					'refunds',
					index,
					'method',
				])
			}
			const sum = (refundedPerPayment.get(r.paymentId) ?? 0) + r.amountCents
			refundedPerPayment.set(r.paymentId, sum)
			if (sum > payment.amountCents) {
				issue('refunds exceed the payment', ['refunds', index, 'amountCents'])
			}
		}
		const refunded = order.refunds.reduce((s, r) => s + r.amountCents, 0)
		if (order.status === 'refunded' && (paid === 0 || refunded !== paid)) {
			issue('a refunded order must be refunded in full', ['status'])
		}
		if (order.status === 'paid' && paid > 0 && refunded === paid) {
			issue('a fully refunded order must be marked refunded', ['status'])
		}

		// Fiscal documents (optional for version 1 tills): one invoice for a closed
		// sale, one credit note per refund, amounts matching what they document.
		if (order.fiscal.length > 0) {
			const invoices = order.fiscal.filter((d) => d.kind === 'invoice')
			const credits = order.fiscal.filter((d) => d.kind === 'credit_note')
			if (!closed && order.fiscal.length > 0)
				issue('only a closed sale has fiscal documents', ['fiscal'])
			// A closed sale with fiscal documents has exactly one invoice (a till
			// that refunds a sale closed before it kept a chain issues it then).
			if (invoices.length !== 1)
				issue('a closed sale has exactly one invoice', ['fiscal'])
			const invoice = invoices[0]
			if (
				invoice &&
				(invoice.docId !== order.id ||
					invoice.totalCents !== order.totals.totalCents ||
					invoice.taxCents !== order.totals.taxCents)
			) {
				issue('the invoice does not match the bill', ['fiscal'])
			}
			const refundsById = new Map(order.refunds.map((r) => [r.id, r]))
			if (credits.length !== order.refunds.length)
				issue('every refund has one credit note', ['fiscal'])
			for (const d of credits) {
				const refund = refundsById.get(d.docId)
				if (
					!refund ||
					d.totalCents !== refund.amountCents ||
					d.taxCents !== posRefundTaxCents(order.totals, refund.amountCents)
				) {
					issue('a credit note does not match its refund', ['fiscal'])
				}
			}
			for (const d of order.fiscal) {
				if (d.orderId !== order.id || d.currency !== order.currency) {
					issue('a fiscal document belongs to another order', ['fiscal'])
				}
				// The signed document is for the same amount (its VAT may differ by
				// rounding: ZATCA's VAT is computed from the document's own net amounts).
				if (d.zatca && d.zatca.totalCents !== d.totalCents) {
					issue(
						'the signed ZATCA document does not match its fiscal document',
						['fiscal'],
					)
				}
			}
		} else if (order.refunds.length > 0 && order.fiscal.length === 0) {
			// A refund is only made by a version 2 till, which always documents it.
			issue('a refund needs its credit note', ['fiscal'])
		}
	})

export type PosOrderRequest = z.infer<typeof posOrderRequestSchema>

// ---------------------------------------------------------------------------
// Cash drawer shifts (terminal -> regional tenant-api)
// ---------------------------------------------------------------------------

export const POS_SHIFT_STATUS_VALUES = ['open', 'closed'] as const
export const POS_CASH_MOVEMENT_KINDS = ['pay_in', 'pay_out'] as const
export const POS_MAX_CASH_MOVEMENTS = 200

/** Cash put into or taken out of the drawer for something other than a sale. Append-only. */
export const posCashMovementSchema = z.strictObject({
	id: uuid,
	kind: z.enum(POS_CASH_MOVEMENT_KINDS),
	amountCents: cents.min(1),
	note: z.string().trim().min(1).max(200),
	at: instant,
	by: posStaffSchema.nullable(),
	approvedBy: posStaffSchema.nullable(),
})

/**
 * One drawer session on one terminal: opened with a float, closed with a blind
 * count. The till says what it expected in the drawer; the server works the
 * figure out again from the payments it holds, so the two can be compared.
 */
export const posShiftRequestSchema = z
	.strictObject({
		id: uuid,
		revision: z.number().int().min(1).max(100_000),
		status: z.enum(POS_SHIFT_STATUS_VALUES),
		businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
		openedAt: instant,
		openedBy: posStaffSchema.nullable(),
		openingFloatCents: cents,
		movements: z.array(posCashMovementSchema).max(POS_MAX_CASH_MOVEMENTS),
		closedAt: instant.nullable(),
		closedBy: posStaffSchema.nullable(),
		/** What the person closing counted, without being shown the expected figure first. */
		countedCashCents: cents.nullable(),
		/** What the till expected in the drawer when it closed. */
		expectedCashCents: z
			.number()
			.int()
			.min(-100_000_000)
			.max(100_000_000)
			.nullable(),
	})
	.superRefine((shift, ctx) => {
		const issue = (message: string, path: (string | number)[] = []) =>
			ctx.addIssue({ code: z.ZodIssueCode.custom, message, path })
		if (
			new Set(shift.movements.map((m) => m.id)).size !== shift.movements.length
		) {
			issue('duplicate movement id', ['movements'])
		}
		const closing = [
			shift.closedAt,
			shift.countedCashCents,
			shift.expectedCashCents,
		]
		if (shift.status === 'closed' && closing.some((v) => v === null)) {
			issue('a closed shift needs its closing time, count and expected cash', [
				'status',
			])
		}
		if (shift.status === 'open' && closing.some((v) => v !== null)) {
			issue('an open shift has no closing figures', ['status'])
		}
	})

export type PosShiftRequest = z.infer<typeof posShiftRequestSchema>

export const posPairRequestSchema = z.strictObject({
	code: z.string().min(1).max(160),
})

// ---------------------------------------------------------------------------
// Staff sign-in
// ---------------------------------------------------------------------------

export const posSignInRequestSchema = z.strictObject({
	pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits'),
})

export type PosSignInResponse = {
	staff: PosStaff
	role: 'cashier' | 'manager'
	/**
	 * Proof of this sign-in for the Station apps that act on the server as the
	 * person (reservations), sent back in `POS_STAFF_SESSION_HEADER`. Only an
	 * online sign-in has one; the till forgets it when it locks.
	 */
	sessionToken?: string
	/** Epoch milliseconds when the session token stops working. */
	sessionExpiresAt?: number
}

/** Header carrying a signed-in person's session token on Station app calls. */
export const POS_STAFF_SESSION_HEADER = 'Pos-Staff-Session'

// ---------------------------------------------------------------------------
// Station apps beside the till
// ---------------------------------------------------------------------------

/**
 * Which Station apps a terminal offers: the terminal's own setting, and the
 * organization's feature flag, both on. The till sells regardless.
 */
export type PosDeviceApps = { timeclock: boolean; reservations: boolean }

export const NO_POS_DEVICE_APPS: PosDeviceApps = {
	timeclock: false,
	reservations: false,
}

/**
 * A short-lived reservations operator token for the signed-in person, scoped to
 * the host stand (`book`) at the terminal's location.
 */
export type PosReservationsTokenResponse = {
	token: string
	/** Epoch milliseconds. */
	expiresAt: number
	locationId: string
	/** Contact details, notes and allergies: hosts the manager gave guest details. */
	canReadGuest: boolean
	features: {
		waitlist: boolean
		online: boolean
	}
}

/**
 * `GET /pos/reservations/servers`: who can take a section of the floor for a
 * service, for the host stand to assign. People clocked in at the terminal's
 * workplace and people with a published shift in the window, first name and
 * last initial only. `available` is false when the staff module (or both its
 * time clock and scheduling) is off: the host then types names.
 */
export type PosServer = {
	staffId: string
	firstName: string
	/** One letter, to tell two people of the same first name apart. */
	lastInitial: string
	/** The position they clocked in as, or their shift's. */
	position: string | null
	onClock: boolean
	/** Their published shift that overlaps the window, epoch milliseconds. */
	shift: { startAt: number; endAt: number } | null
}
export type PosServersResponse = {
	available: boolean
	servers: PosServer[]
}

/** Shown on receipts and lists: first name and last initial. */
export function posStaffDisplayName(first: string, last: string): string {
	const initial = last.trim().slice(0, 1)
	return (
		`${first.trim()}${initial ? ` ${initial.toUpperCase()}.` : ''}`.trim() ||
		'Staff'
	)
}
