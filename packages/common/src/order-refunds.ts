import { z } from 'zod'

/**
 * Refunds of restaurant orders (#80): shared, PII-free contracts.
 *
 * Two kinds of refund row live in the regional `restaurant_order_refunds`:
 *
 * - `record`: money an operator says went back outside Menuza (cash or card at
 *   the counter). Written `succeeded` at once; no provider is ever called.
 * - `provider`: money returned through the order's payment provider. The
 *   region books it `pending` (a reservation of the amount), the App calls
 *   Stripe or Checkout.com, and the provider's answer (direct, webhook or
 *   reconcile) moves it to `succeeded` or `failed`. Only `succeeded` refunds
 *   add to `restaurant_orders.refunded_cents`; a `pending` one only lowers
 *   what is still refundable; `failed` gives the amount back.
 *
 * The App and the US Worker only ever see order ids, refund ids, amounts,
 * currency, processor and provider ids through these contracts.
 */

export const ORDER_REFUND_KINDS = ['record', 'provider'] as const
export type OrderRefundKind = (typeof ORDER_REFUND_KINDS)[number]

export const ORDER_REFUND_STATUSES = ['pending', 'succeeded', 'failed'] as const
export type OrderRefundStatus = (typeof ORDER_REFUND_STATUSES)[number]

/**
 * Who started a refund. `operator` (App), `station` (Station Orders app),
 * `guest` (guest self-cancel), `system` (acceptance timeout). No PII: an
 * operator refund carries the member's user id in `actorId`, nothing else.
 */
export const ORDER_REFUND_ORIGINS = [
	'operator',
	'station',
	'guest',
	'system',
] as const
export type OrderRefundOrigin = (typeof ORDER_REFUND_ORIGINS)[number]

/** The payment processors an online order or tab can be paid through. */
export const ORDER_PAYMENT_PROCESSORS = ['connect', 'checkout'] as const
export type OrderPaymentProcessor = (typeof ORDER_PAYMENT_PROCESSORS)[number]

/**
 * State of a payment dispute (chargeback) on an order or tab:
 * `open` (needs response or under review), `won`, `lost`. The App maps the
 * provider's own words onto these (Stripe `warning_closed` reads as `won`).
 */
export const ORDER_DISPUTE_STATUSES = ['open', 'won', 'lost'] as const
export type OrderDisputeStatus = (typeof ORDER_DISPUTE_STATUSES)[number]

/**
 * A dispute that is open, or lost (the provider already took the money back),
 * blocks refunds: 409 `payment_disputed`. A won dispute does not.
 */
export function disputeBlocksRefund(
	status: string | null | undefined,
): boolean {
	return status === 'open' || status === 'lost'
}

/** Machine codes the refund routes answer with (never echoing input). */
export const ORDER_REFUND_ERROR_CODES = [
	'order_not_found',
	'refund_pending',
	'payment_disputed',
	'refund_exceeds_payment',
	'order_not_refundable',
	'refund_complete',
	'idempotency_conflict',
	'refund_not_found',
	/** A record-only refund of an order paid online: use the provider path. */
	'refund_requires_provider',
	/** Cancel with a refund without the token's `refundProvider` claim. */
	'refund_forbidden',
	/** A status report names a refund with another amount, currency or provider. */
	'refund_mismatch',
	/** The order carries loyalty points and the member may not move them. */
	'loyalty_refund_forbidden',
] as const
export type OrderRefundErrorCode = (typeof ORDER_REFUND_ERROR_CODES)[number]

/** A provider's failure reason, as a short machine code (no free text). */
export const refundFailureCodeSchema = z
	.string()
	.regex(/^[a-z0-9_.-]{1,64}$/i)
	.transform((value) => value.toLowerCase())

/** The operator's note on a refund (required by every refund body). */
export const refundNoteSchema = z.string().trim().min(3).max(280)

/** An `Idempotency-Key` as the refund routes accept it. */
export const refundIdempotencyKeySchema = z.string().min(8).max(200)

const orgIdSchema = z.string().min(1).max(100)
/** An order id, or `tab:<id>` for a QR tab paid from the phone. */
const orderRefSchema = z.string().min(1).max(100)
const refundIdSchema = z.string().min(1).max(100)
const providerIdSchema = z.string().min(1).max(200)
const amountCentsSchema = z.number().int().min(1).max(100_000_000)

/** Most locations one refund request may be limited to. */
export const ORDER_REFUND_MAX_LOCATION_IDS = 200

/**
 * The locations a member limited to some locations may refund in (their
 * `UserOrganizationLocation` ids). Opaque ids, bounded; the region never
 * echoes them.
 */
export const orderRefundLocationIdsSchema = z
	.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/))
	.max(ORDER_REFUND_MAX_LOCATION_IDS)

/**
 * Body of the App's operator action `POST /:orgSlug/orders/:orderId/refund`
 * (a provider refund): an amount, or `full` for everything still refundable,
 * plus a required note. Same shape as the record body
 * (`operatorOrderRefundRequestSchema`), which stays for handoff orders.
 */
export const orderProviderRefundRequestSchema = z.union([
	z.strictObject({
		amountCents: amountCentsSchema,
		/**
		 * Also give back the guest service fee (#123), on top of `amountCents`.
		 * Only with an amount: a full refund always includes the fee.
		 */
		includeServiceFee: z.boolean().optional(),
		note: refundNoteSchema,
	}),
	z.strictObject({
		full: z.literal(true),
		note: refundNoteSchema,
	}),
])
export type OrderProviderRefundRequest = z.infer<
	typeof orderProviderRefundRequestSchema
>

/** Who asked for a refund; ids only. */
export const orderRefundActorSchema = z.strictObject({
	origin: z.enum(ORDER_REFUND_ORIGINS),
	/** The member's user id for `operator`; omitted otherwise. */
	actorId: z.string().min(1).max(100).optional(),
})
export type OrderRefundActor = z.infer<typeof orderRefundActorSchema>

// ---------------------------------------------------------------------------
// Region system routes (App → region, Bearer INTERNAL_COMMAND_TOKEN, mounted
// at /api/orders). Unknown properties are refused.
// ---------------------------------------------------------------------------

/**
 * `POST /api/orders/refund-intent`: books a `pending` `provider` refund.
 * `orderId` may be `tab:<id>`; then `tabPaymentId` names a `qr_tab_payments`
 * row (money kept for review), and leaving it out means the tab's own settling
 * payment. Exactly one of `amountCents` and `full`.
 */
export const orderRefundIntentRequestSchema = z
	.strictObject({
		orgId: orgIdSchema,
		orderId: orderRefSchema,
		tabPaymentId: z.string().min(1).max(100).optional(),
		amountCents: amountCentsSchema.optional(),
		full: z.literal(true).optional(),
		/**
		 * Also refund the service fee (#123) on top of `amountCents` (an order,
		 * not a tab payment). Refused with `full`, which always includes it.
		 */
		includeServiceFee: z.boolean().optional(),
		note: refundNoteSchema,
		idempotencyKey: refundIdempotencyKeySchema,
		actor: orderRefundActorSchema,
		/**
		 * A member limited to some locations: the region answers the uniform
		 * 404 for an order (or tab) at any other location, and confirms the
		 * check with `locationScoped: true`. Null or absent: every location.
		 * An empty list reaches nothing.
		 */
		locationIds: orderRefundLocationIdsSchema.nullable().optional(),
		/**
		 * Whether the member may move loyalty points (`update:loyalty_redemption:any`,
		 * never while impersonating). Present: the region refuses an order loyalty
		 * tracks with 403 `loyalty_refund_forbidden` unless `refundLoyalty`, and
		 * confirms the check with `loyaltyChecked: true`. Absent: the caller
		 * decided (system refunds).
		 */
		loyaltyAccess: z.strictObject({ refundLoyalty: z.boolean() }).optional(),
	})
	.refine(
		(body) => (body.amountCents === undefined) !== (body.full === undefined),
		{
			message: 'Send either amountCents or full.',
			path: ['amountCents'],
		},
	)
	.refine((body) => !(body.full === true && body.includeServiceFee), {
		message: 'A full refund already includes the service fee.',
		path: ['includeServiceFee'],
	})
export type OrderRefundIntentRequest = z.infer<
	typeof orderRefundIntentRequestSchema
>

/** One provider refund as the App needs it to call the provider. */
export const orderProviderRefundSchema = z.object({
	refundId: refundIdSchema,
	/** The order id, or `tab:<id>`. */
	orderId: orderRefSchema,
	/** For a tab refund of a review payment; null otherwise. */
	tabPaymentId: z.string().nullable(),
	amountCents: z.number().int().positive(),
	currency: z.string().length(3),
	processor: z.enum(ORDER_PAYMENT_PROCESSORS),
	/**
	 * The payment reference the money came in on: the Stripe Checkout Session
	 * id (`connect`) or the Checkout.com payment id / session reference
	 * (`checkout`), exactly as the region stored it.
	 */
	sessionId: z.string().min(1),
	/**
	 * The provider's payment id (`restaurant_orders.payment_id`: Stripe `pi_…`,
	 * Checkout.com `pay_…`) when the region knows it; null means the App
	 * resolves the payment from `sessionId`.
	 */
	paymentId: z.string().nullable(),
	status: z.enum(ORDER_REFUND_STATUSES),
	/** Set once the provider accepted the refund; null before. */
	providerRefundId: z.string().nullable(),
	/** Epoch-ms ISO strings. */
	createdAt: z.string(),
	updatedAt: z.string(),
})
export type OrderProviderRefund = z.infer<typeof orderProviderRefundSchema>

/**
 * Answer of `POST /api/orders/refund-intent`. `replayed` is true when the same
 * `idempotencyKey` (and the same request) came again: the existing refund is
 * returned, whatever its status now.
 */
export const orderRefundIntentResponseSchema = orderProviderRefundSchema.extend(
	{
		replayed: z.boolean(),
		/**
		 * True when the request carried `locationIds` and the region checked
		 * the order's location against them. A region that predates the field
		 * leaves it out, so a caller that sent `locationIds` must refuse an
		 * answer without it (the scope was not enforced).
		 */
		locationScoped: z.boolean().optional(),
		/**
		 * True when the request carried `loyaltyAccess` and the region applied
		 * it. A region that predates the field leaves it out; a caller whose
		 * member lacks the loyalty grant must then refuse the answer.
		 */
		loyaltyChecked: z.boolean().optional(),
	},
)
export type OrderRefundIntentResponse = z.infer<
	typeof orderRefundIntentResponseSchema
>

/**
 * `POST /api/orders/refund-status`: the provider's answer for one refund
 * (direct, from a webhook, or the reconcile job). Names the refund by
 * `refundId` or by `providerRefundId`. Idempotent: the first `succeeded` adds
 * the amount to the refunded total; a replay changes nothing. `pending` with a
 * `providerRefundId` records the provider id only. A final status never
 * changes again.
 */
export const orderRefundStatusRequestSchema = z
	.strictObject({
		orgId: orgIdSchema,
		/** The order id or `tab:<id>`; lets the region pick the right ledger. */
		orderId: orderRefSchema.optional(),
		refundId: refundIdSchema.optional(),
		providerRefundId: providerIdSchema.optional(),
		processor: z.enum(ORDER_PAYMENT_PROCESSORS).optional(),
		status: z.enum(ORDER_REFUND_STATUSES),
		failureCode: refundFailureCodeSchema.optional(),
		/** As the provider reported it; the region refuses a mismatch. */
		amountCents: amountCentsSchema.optional(),
		currency: z.string().length(3).optional(),
	})
	.refine(
		(body) =>
			body.refundId !== undefined || body.providerRefundId !== undefined,
		{
			message: 'Send refundId or providerRefundId.',
			path: ['refundId'],
		},
	)
export type OrderRefundStatusRequest = z.infer<
	typeof orderRefundStatusRequestSchema
>

export const orderRefundStatusResponseSchema = z.object({
	refundId: refundIdSchema,
	orderId: orderRefSchema,
	status: z.enum(ORDER_REFUND_STATUSES),
	/** True only for the write that moved the refund (false on a replay). */
	applied: z.boolean(),
})
export type OrderRefundStatusResponse = z.infer<
	typeof orderRefundStatusResponseSchema
>

/**
 * `POST /api/orders/dispute-status`: a provider dispute on an order (or a tab)
 * opened or closed. Names the order by `orderId` (or `tab:<id>`) or by the
 * payment `sessionId` (+ `processor`).
 */
export const orderDisputeStatusRequestSchema = z
	.strictObject({
		orgId: orgIdSchema,
		orderId: orderRefSchema.optional(),
		sessionId: providerIdSchema.optional(),
		processor: z.enum(ORDER_PAYMENT_PROCESSORS).optional(),
		status: z.enum(ORDER_DISPUTE_STATUSES),
		/** Provider dispute fee in minor units, when closed (#187). */
		feeCents: z.number().int().min(0).max(100_000_000).optional(),
	})
	.refine(
		(body) => body.orderId !== undefined || body.sessionId !== undefined,
		{
			message: 'Send orderId or sessionId.',
			path: ['orderId'],
		},
	)
export type OrderDisputeStatusRequest = z.infer<
	typeof orderDisputeStatusRequestSchema
>

/**
 * Answer of `POST /api/orders/dispute-status`: the order (or `tab:<id>`) the
 * dispute was recorded on, its state now, whether refunds are blocked, and
 * whether this report changed anything.
 */
export const orderDisputeStatusResponseSchema = z.object({
	orderId: orderRefSchema,
	disputeStatus: z.enum(ORDER_DISPUTE_STATUSES),
	disputed: z.boolean(),
	applied: z.boolean(),
})
export type OrderDisputeStatusResponse = z.infer<
	typeof orderDisputeStatusResponseSchema
>

/**
 * `POST /api/orders/refunds-pending`: provider refunds still `pending`, oldest
 * first, for the App's execute and reconcile paths. `refundId` narrows to one
 * refund (the execute kick). `olderThanMs` keeps those not updated within that
 * many milliseconds.
 */
export const orderRefundsPendingRequestSchema = z.strictObject({
	orgId: orgIdSchema,
	refundId: refundIdSchema.optional(),
	olderThanMs: z
		.number()
		.int()
		.min(0)
		.max(30 * 86_400_000)
		.optional(),
	limit: z.number().int().min(1).max(200).optional(),
})
export type OrderRefundsPendingRequest = z.infer<
	typeof orderRefundsPendingRequestSchema
>

export const orderRefundsPendingResponseSchema = z.object({
	refunds: z.array(orderProviderRefundSchema),
})
export type OrderRefundsPendingResponse = z.infer<
	typeof orderRefundsPendingResponseSchema
>

/**
 * Region → App kick after the region booked a refund itself (Station cancel,
 * guest self-cancel, acceptance reject or timeout):
 * `POST <APP_URL>/resources/orders/refund-execute`, internal token. Ids only:
 * the App reads the refund back with `refunds-pending`.
 */
export const orderRefundExecuteRequestSchema = z.strictObject({
	orgId: orgIdSchema,
	refundId: refundIdSchema,
})
export type OrderRefundExecuteRequest = z.infer<
	typeof orderRefundExecuteRequestSchema
>

// ---------------------------------------------------------------------------
// Refund summary (operator and guest views)
// ---------------------------------------------------------------------------

/**
 * The order's refund state for lists and badges:
 * - `pending`: a provider refund is waiting on the provider.
 * - `failed`: the newest provider refund failed (and none is pending); the
 *   amount is refundable again.
 * - `full` / `partial` / `none`: by what succeeded.
 */
export const ORDER_REFUND_SUMMARY_STATUSES = [
	'none',
	'pending',
	'failed',
	'partial',
	'full',
] as const
export type OrderRefundSummaryStatus =
	(typeof ORDER_REFUND_SUMMARY_STATUSES)[number]

export type OrderRefundSummary = {
	/**
	 * What is really back: succeeded refunds (`restaurant_orders.refunded_cents`)
	 * less those the provider reversed afterwards.
	 */
	refundedCents: number
	/** Succeeded refunds the provider reported failed afterwards. */
	reversedCents: number
	/** Provider refunds still pending. */
	pendingCents: number
	/** paid - refunded - pending + reversed, never below 0. */
	refundableCents: number
	refundStatus: OrderRefundSummaryStatus
	/**
	 * The newest failed (or reversed) provider refund's code, when
	 * `refundStatus` is `failed`.
	 */
	failureCode: string | null
}

type RefundRowLike = {
	amountCents: number
	status: OrderRefundStatus | string
	kind?: OrderRefundKind | string
	failureCode?: string | null
	/** Epoch ms, a Date or an ISO string; orders the rows. */
	createdAt?: number | string | Date | null
	/** Set when the provider reversed this succeeded refund afterwards. */
	reversedAt?: number | string | Date | null
	reversalCode?: string | null
}

function timeOf(value: RefundRowLike['createdAt']): number {
	if (value == null) return 0
	if (value instanceof Date) return value.getTime()
	if (typeof value === 'number') return value
	const parsed = Date.parse(value)
	return Number.isFinite(parsed) ? parsed : 0
}

/** A succeeded refund the provider reported failed afterwards. */
export function refundRowReversed(refund: {
	status: string
	reversedAt?: RefundRowLike['reversedAt']
}): boolean {
	return refund.status === 'succeeded' && refund.reversedAt != null
}

/**
 * How a refund row reads: a reversed one is `failed` with its reversal code,
 * as of when it was reversed. Every other row as stored.
 */
export function effectiveRefundRow(refund: RefundRowLike): {
	status: string
	failureCode: string | null
	at: number
} {
	if (refundRowReversed(refund)) {
		return {
			status: 'failed',
			failureCode: refund.reversalCode ?? null,
			at: timeOf(refund.reversedAt),
		}
	}
	return {
		status: refund.status,
		failureCode: refund.failureCode ?? null,
		at: timeOf(refund.createdAt),
	}
}

/**
 * What a payment can still give back: paid - refunded - pending + reversed,
 * never below 0 and never above what was paid. `refunded_cents` never
 * shrinks, so a refund the provider reversed after it succeeded is added back
 * here instead.
 */
export function refundableAmountCents(input: {
	paidCents: number
	refundedCents: number
	reversedCents?: number
	pendingCents: number
}): number {
	const back = Math.max(0, input.refundedCents - (input.reversedCents ?? 0))
	return Math.min(
		Math.max(0, input.paidCents),
		Math.max(0, input.paidCents - back - input.pendingCents),
	)
}

/**
 * Folds an order's refund rows. `paidCents` is what was captured (the order
 * total for a paid online order, 0 when nothing was paid). `refundedCents` is
 * the order's stored total of succeeded refunds, which wins over the rows;
 * `reversedCents` its stored total of reversals (summed from the rows when
 * absent).
 */
export function summarizeOrderRefunds(
	order: { paidCents: number; refundedCents: number; reversedCents?: number },
	refunds: readonly RefundRowLike[],
): OrderRefundSummary {
	let pendingCents = 0
	let rowsReversed = 0
	for (const refund of refunds) {
		if (refund.status === 'pending') pendingCents += refund.amountCents
		if (refundRowReversed(refund)) rowsReversed += refund.amountCents
	}
	const grossCents = Math.max(0, order.refundedCents)
	const reversedCents = Math.min(
		grossCents,
		Math.max(0, order.reversedCents ?? rowsReversed),
	)
	const refundedCents = grossCents - reversedCents
	const refundableCents = refundableAmountCents({
		paidCents: order.paidCents,
		refundedCents: grossCents,
		reversedCents,
		pendingCents,
	})
	let refundStatus: OrderRefundSummaryStatus
	let failureCode: string | null = null
	if (pendingCents > 0) {
		refundStatus = 'pending'
	} else {
		// The newest thing that happened: a refund settling, or one reversed.
		const newest = refunds
			.filter((refund) => refund.status !== 'pending')
			.map(effectiveRefundRow)
			.sort((a, b) => b.at - a.at)[0]
		if (newest?.status === 'failed') {
			refundStatus = 'failed'
			failureCode = newest.failureCode
		} else if (refundedCents <= 0) {
			refundStatus = 'none'
		} else {
			refundStatus = refundedCents >= order.paidCents ? 'full' : 'partial'
		}
	}
	return {
		refundedCents,
		reversedCents,
		pendingCents,
		refundableCents,
		refundStatus,
		failureCode,
	}
}

/** One refund in the operator order JSON (`refunds[]`). */
export const operatorOrderRefundSchema = z.object({
	id: z.string(),
	amountCents: z.number().int(),
	currency: z.string(),
	full: z.boolean(),
	note: z.string().nullable(),
	actorId: z.string(),
	createdAt: z.string(),
	/** Missing from an older region: read as `record` / `succeeded`. */
	kind: z.enum(ORDER_REFUND_KINDS).default('record').catch('record'),
	status: z.enum(ORDER_REFUND_STATUSES).default('succeeded').catch('succeeded'),
	origin: z.enum(ORDER_REFUND_ORIGINS).default('operator').catch('operator'),
	failureCode: z.string().nullable().default(null).catch(null),
	settledAt: z.string().nullable().default(null).catch(null),
	/**
	 * When the provider reversed this refund after it succeeded (then
	 * `status` reads `failed` and `failureCode` is the reversal's code).
	 * Missing from an older region: null.
	 */
	reversedAt: z.string().nullable().default(null).catch(null),
})
export type OperatorOrderRefund = z.infer<typeof operatorOrderRefundSchema>
