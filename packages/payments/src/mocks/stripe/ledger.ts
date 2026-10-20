import { type EmulatorContext } from '../context'
import { stripeId } from '../ids'
import { type MockObjectRow } from '../store'
import { type Json } from '../util'
import { profileOfPaymentMethod } from './customers'
import { invalidRequest, missingParam } from './errors'
import {
	ANY,
	boolParam,
	intParam,
	metadataParam,
	rejectUnknownParams,
	stringParam,
} from './params'
import {
	emitStripeEvent,
	findStripeObject,
	insertStripeObject,
	mutateStripeObject,
	publicObject,
	requireStripeObject,
	seconds,
} from './state'

/** Pending refunds settle on their own after this long (mock time). */
const PENDING_REFUND_SETTLES_AFTER_MS = 60 * 60 * 1000

export type ChargeInput = {
	paymentIntent: Json
	paymentMethod: Json
	captured: boolean
	billing?: { email?: string | null; name?: string | null }
}

/**
 * Create the charge for a succeeded PaymentIntent and, when captured, the
 * destination-charge ledger: transfer (amount minus fee) and application fee.
 */
export async function recordCharge(ctx: EmulatorContext, input: ChargeInput) {
	const { paymentIntent: pi, paymentMethod: pm } = input
	const amount = Number(pi.amount)
	const destination: string | null = pi.transfer_data?.destination ?? null
	const now = seconds(ctx.clock.now())
	const charge: Json = {
		id: stripeId('ch_', 24),
		object: 'charge',
		amount,
		amount_captured: input.captured ? amount : 0,
		amount_refunded: 0,
		application: null,
		application_fee: null as string | null,
		application_fee_amount: pi.application_fee_amount ?? null,
		balance_transaction: stripeId('txn_', 24),
		billing_details: pm.billing_details,
		captured: input.captured,
		created: now,
		currency: pi.currency,
		customer: pi.customer ?? null,
		description: null,
		destination,
		disputed: false,
		failure_code: null,
		failure_message: null,
		livemode: false,
		metadata: pi.metadata ?? {},
		outcome: {
			network_status: 'approved_by_network',
			risk_level: 'normal',
			seller_message: 'Payment complete.',
			type: 'authorized',
		},
		paid: true,
		payment_intent: pi.id,
		payment_method: pm.id,
		payment_method_details: { type: 'card', card: { ...pm.card } },
		receipt_email: input.billing?.email ?? pm.billing_details?.email ?? null,
		refunded: false,
		status: 'succeeded',
		transfer: null as string | null,
		transfer_data: pi.transfer_data ?? null,
		transfer_group: null,
		__mock: { profile: pm.__mock?.profile ?? null },
	}
	await insertStripeObject(ctx, 'charge', charge, { parentId: String(pi.id) })
	if (input.captured) await settleDestinationLedger(ctx, charge)
	return (await requireStripeObject(ctx, charge.id, 'charge', 'charge')).json
}

async function settleDestinationLedger(ctx: EmulatorContext, charge: Json) {
	const destination: string | null = charge.transfer_data?.destination ?? null
	if (!destination) return
	const captured = Number(charge.amount_captured)
	const fee = Math.min(Number(charge.application_fee_amount ?? 0), captured)
	const now = seconds(ctx.clock.now())
	const transfer = {
		id: stripeId('tr_', 24),
		object: 'transfer',
		amount: captured - fee,
		amount_reversed: 0,
		balance_transaction: stripeId('txn_', 24),
		created: now,
		currency: charge.currency,
		destination,
		destination_payment: stripeId('py_', 24),
		livemode: false,
		metadata: {},
		reversed: false,
		source_transaction: charge.id,
		source_type: 'card',
		transfer_group: null,
	}
	await insertStripeObject(ctx, 'transfer', transfer, {
		parentId: String(charge.id),
	})
	let feeId: string | null = null
	if (fee > 0) {
		feeId = stripeId('fee_', 24)
		await insertStripeObject(
			ctx,
			'application_fee',
			{
				id: feeId,
				object: 'application_fee',
				account: destination,
				amount: fee,
				amount_refunded: 0,
				balance_transaction: stripeId('txn_', 24),
				charge: charge.id,
				created: now,
				currency: charge.currency,
				livemode: false,
				refunded: false,
				refunds: { object: 'list', data: [], has_more: false },
			},
			{ parentId: String(charge.id) },
		)
	}
	await mutateStripeObject(ctx, String(charge.id), (json) => {
		json.transfer = transfer.id
		json.application_fee = feeId
	})
}

/** Capture an uncaptured charge (manual capture). */
export async function captureCharge(
	ctx: EmulatorContext,
	chargeId: string,
	amountToCapture?: number,
) {
	const { row } = await mutateStripeObject(ctx, chargeId, (json) => {
		if (json.captured) {
			throw invalidRequest('This charge has already been captured.', {
				code: 'charge_already_captured',
			})
		}
		const amount = amountToCapture ?? Number(json.amount)
		if (amount > Number(json.amount)) {
			throw invalidRequest(
				'Cannot capture more than the amount authorized on the charge.',
				{ code: 'amount_too_large', param: 'amount_to_capture' },
			)
		}
		json.captured = true
		json.amount_captured = amount
	})
	await settleDestinationLedger(ctx, row.json)
	return (await requireStripeObject(ctx, chargeId, 'charge', 'charge')).json
}

// ------------------------------------------------------------------ refunds

const REFUND_PARAMS = {
	payment_intent: true,
	charge: true,
	amount: true,
	reason: true,
	reverse_transfer: true,
	refund_application_fee: true,
	metadata: ANY,
} as const

function dollars(amount: number, currency: string) {
	return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`
}

async function chargeForRefund(ctx: EmulatorContext, params: Json) {
	const paymentIntent = stringParam(params.payment_intent, 'payment_intent')
	const chargeId = stringParam(params.charge, 'charge')
	if (!paymentIntent && !chargeId) {
		throw invalidRequest(
			'Must provide either the `charge` or `payment_intent` parameter when creating a refund.',
			{ param: 'payment_intent' },
		)
	}
	if (chargeId) {
		return requireStripeObject(ctx, chargeId, 'charge', 'charge', 'charge')
	}
	const intent = await requireStripeObject(
		ctx,
		paymentIntent!,
		'payment_intent',
		'payment_intent',
		'payment_intent',
	)
	if (!intent.json.latest_charge) {
		throw invalidRequest(
			`The PaymentIntent ${paymentIntent} does not have a successful charge to refund.`,
			{ code: 'charge_not_refundable', param: 'payment_intent' },
		)
	}
	return requireStripeObject(
		ctx,
		String(intent.json.latest_charge),
		'charge',
		'charge',
		'payment_intent',
	)
}

export async function createRefund(ctx: EmulatorContext, params: Json) {
	rejectUnknownParams(params, REFUND_PARAMS)
	const charge = await chargeForRefund(ctx, params)
	if (!charge.json.captured || charge.json.status !== 'succeeded') {
		throw invalidRequest('This charge is not refundable.', {
			code: 'charge_not_refundable',
		})
	}
	const requested = intParam(params.amount, 'amount')
	if (requested !== undefined && requested < 1) {
		throw invalidRequest('Invalid positive integer', {
			code: 'parameter_invalid_integer',
			param: 'amount',
		})
	}
	const reverseTransfer =
		boolParam(params.reverse_transfer, 'reverse_transfer') ?? false
	const refundFee =
		boolParam(params.refund_application_fee, 'refund_application_fee') ?? false
	if (refundFee && !reverseTransfer) {
		throw invalidRequest(
			'refund_application_fee on a destination charge requires reverse_transfer.',
			{ param: 'refund_application_fee' },
		)
	}
	const metadata = metadataParam(params.metadata)
	const reason = stringParam(params.reason, 'reason') ?? null
	if (
		reason &&
		!['duplicate', 'fraudulent', 'requested_by_customer'].includes(reason)
	) {
		throw invalidRequest(`Invalid reason: ${reason}`, {
			code: 'parameter_invalid_enum',
			param: 'reason',
		})
	}

	let refundAmount = 0
	// The charge's refunded counter is the single-shot guard: the check and the
	// increment happen in one compare-and-set, so concurrent refunds cannot
	// exceed the charge.
	const { row: after } = await mutateStripeObject(ctx, charge.id, (json) => {
		const remaining =
			Number(json.amount_captured) - Number(json.amount_refunded)
		if (remaining <= 0) {
			throw invalidRequest(`Charge ${json.id} has already been refunded.`, {
				code: 'charge_already_refunded',
			})
		}
		const amount = requested ?? remaining
		if (amount > remaining) {
			throw invalidRequest(
				`Refund amount (${dollars(amount, json.currency)}) is greater than unrefunded amount on charge (${dollars(remaining, json.currency)})`,
				{ code: 'amount_too_large', param: 'amount' },
			)
		}
		refundAmount = amount
		json.amount_refunded = Number(json.amount_refunded) + amount
		json.refunded = json.amount_refunded >= Number(json.amount_captured)
	})
	const chargeJson = after.json
	const pm = await findStripeObject(
		ctx,
		String(chargeJson.payment_method),
		'payment_method',
	)
	const profile = pm ? profileOfPaymentMethod(pm.json) : null
	const asyncOutcome = profile?.asyncRefund ?? null

	const reversal = reverseTransfer
		? await reverseTransferFor(ctx, chargeJson, refundAmount)
		: null
	const feeRefund = refundFee
		? await refundApplicationFee(ctx, chargeJson, refundAmount)
		: null

	const now = ctx.clock.now()
	const refund: Json = {
		id: stripeId('re_', 24),
		object: 'refund',
		amount: refundAmount,
		balance_transaction: stripeId('txn_', 24),
		charge: chargeJson.id,
		created: seconds(now),
		currency: chargeJson.currency,
		metadata,
		payment_intent: chargeJson.payment_intent,
		reason,
		receipt_number: null,
		source_transfer_reversal: reversal?.id ?? null,
		status: asyncOutcome ? 'pending' : 'succeeded',
		transfer_reversal: reversal?.id ?? null,
		__mock: {
			asyncOutcome,
			reversalId: reversal?.id ?? null,
			reversalAmount: reversal?.amount ?? 0,
			feeRefundId: feeRefund?.id ?? null,
			feeRefundAmount: feeRefund?.amount ?? 0,
		},
	}
	await insertStripeObject(ctx, 'refund', refund, {
		parentId: String(chargeJson.id),
		transitionAt: asyncOutcome ? now + PENDING_REFUND_SETTLES_AFTER_MS : null,
	})
	await emitStripeEvent(ctx, 'refund.created', refund)
	if (!asyncOutcome) await emitStripeEvent(ctx, 'charge.refunded', chargeJson)
	return refund
}

function proportional(total: number, part: number, whole: number) {
	return Math.round((total * part) / whole)
}

async function reverseTransferFor(
	ctx: EmulatorContext,
	charge: Json,
	refundAmount: number,
) {
	if (!charge.transfer) return null
	let reversalAmount = 0
	await mutateStripeObject(ctx, String(charge.transfer), (json) => {
		const left = Number(json.amount) - Number(json.amount_reversed)
		const finalRefund =
			Number(charge.amount_refunded) >= Number(charge.amount_captured)
		reversalAmount = finalRefund
			? left
			: Math.min(
					left,
					proportional(
						Number(json.amount),
						refundAmount,
						Number(charge.amount_captured),
					),
				)
		json.amount_reversed = Number(json.amount_reversed) + reversalAmount
		json.reversed = json.amount_reversed >= Number(json.amount)
	})
	if (reversalAmount <= 0) return null
	const reversal = {
		id: stripeId('trr_', 24),
		object: 'transfer_reversal',
		amount: reversalAmount,
		balance_transaction: stripeId('txn_', 24),
		created: seconds(ctx.clock.now()),
		currency: charge.currency,
		metadata: {},
		transfer: charge.transfer,
	}
	await insertStripeObject(ctx, 'transfer_reversal', reversal, {
		parentId: String(charge.transfer),
	})
	return reversal
}

async function refundApplicationFee(
	ctx: EmulatorContext,
	charge: Json,
	refundAmount: number,
) {
	if (!charge.application_fee) return null
	let feeAmount = 0
	await mutateStripeObject(ctx, String(charge.application_fee), (json) => {
		const left = Number(json.amount) - Number(json.amount_refunded)
		const finalRefund =
			Number(charge.amount_refunded) >= Number(charge.amount_captured)
		feeAmount = finalRefund
			? left
			: Math.min(
					left,
					proportional(
						Number(json.amount),
						refundAmount,
						Number(charge.amount_captured),
					),
				)
		json.amount_refunded = Number(json.amount_refunded) + feeAmount
		json.refunded = json.amount_refunded >= Number(json.amount)
	})
	if (feeAmount <= 0) return null
	const feeRefund = {
		id: stripeId('fr_', 24),
		object: 'fee_refund',
		amount: feeAmount,
		balance_transaction: stripeId('txn_', 24),
		created: seconds(ctx.clock.now()),
		currency: charge.currency,
		fee: charge.application_fee,
		metadata: {},
	}
	await insertStripeObject(ctx, 'fee_refund', feeRefund, {
		parentId: String(charge.application_fee),
	})
	return feeRefund
}

export async function retrieveRefund(ctx: EmulatorContext, id: string) {
	const row = await requireStripeObject(ctx, id, 'refund', 'refund')
	return publicObject(row.json)
}

/**
 * Settle a pending refund. Without `outcome` the card's profile decides
 * (`...7726` succeeds, `...5126` fails). A failed refund gives the amount back
 * to the charge and unwinds its transfer reversal and fee refund.
 */
export async function settleRefund(
	ctx: EmulatorContext,
	refundId: string,
	outcome?: 'succeeded' | 'failed',
) {
	const row = await requireStripeObject(ctx, refundId, 'refund', 'refund')
	if (row.json.status !== 'pending') return publicObject(row.json)
	const decided =
		outcome ??
		(row.json.__mock?.asyncOutcome as 'succeeded' | 'failed') ??
		'succeeded'
	let applied = false
	const { row: settled } = await mutateStripeObject(
		ctx,
		refundId,
		(json) => {
			if (json.status !== 'pending') return
			applied = true
			json.status = decided
			if (decided === 'failed') json.failure_reason = 'expired_or_canceled_card'
		},
		() => null,
	)
	if (!applied) return publicObject(settled.json)
	const charge = await requireStripeObject(
		ctx,
		String(settled.json.charge),
		'charge',
		'charge',
	)
	if (decided === 'succeeded') {
		await emitStripeEvent(ctx, 'refund.updated', settled.json)
		await emitStripeEvent(ctx, 'charge.refunded', charge.json)
		return publicObject(settled.json)
	}
	const internal = settled.json.__mock ?? {}
	const { row: chargeAfter } = await mutateStripeObject(
		ctx,
		charge.id,
		(json) => {
			json.amount_refunded = Math.max(
				0,
				Number(json.amount_refunded) - Number(settled.json.amount),
			)
			json.refunded = false
		},
	)
	if (internal.reversalId && internal.reversalAmount) {
		await mutateStripeObject(ctx, String(chargeAfter.json.transfer), (json) => {
			json.amount_reversed = Math.max(
				0,
				Number(json.amount_reversed) - Number(internal.reversalAmount),
			)
			json.reversed = false
		})
	}
	if (internal.feeRefundId && internal.feeRefundAmount) {
		await mutateStripeObject(
			ctx,
			String(chargeAfter.json.application_fee),
			(json) => {
				json.amount_refunded = Math.max(
					0,
					Number(json.amount_refunded) - Number(internal.feeRefundAmount),
				)
				json.refunded = false
			},
		)
	}
	await emitStripeEvent(ctx, 'refund.updated', settled.json)
	await emitStripeEvent(ctx, 'refund.failed', settled.json)
	await emitStripeEvent(ctx, 'charge.refund.updated', settled.json)
	return publicObject(settled.json)
}

// ----------------------------------------------------------------- disputes

export async function createDispute(
	ctx: EmulatorContext,
	input: { paymentIntent?: string; charge?: string; reason?: string },
) {
	if (!input.paymentIntent && !input.charge)
		throw missingParam('payment_intent')
	const charge = await chargeForRefund(ctx, {
		payment_intent: input.paymentIntent,
		charge: input.charge,
	})
	const dispute = {
		id: stripeId('dp_', 24),
		object: 'dispute',
		amount: charge.json.amount,
		balance_transactions: [],
		charge: charge.id,
		created: seconds(ctx.clock.now()),
		currency: charge.json.currency,
		evidence_details: {
			due_by: seconds(ctx.clock.now()) + 7 * 86400,
			has_evidence: false,
			past_due: false,
			submission_count: 0,
		},
		is_charge_refundable: false,
		livemode: false,
		metadata: {},
		payment_intent: charge.json.payment_intent,
		reason: input.reason ?? 'fraudulent',
		status: 'needs_response',
	}
	await insertStripeObject(ctx, 'dispute', dispute, { parentId: charge.id })
	await mutateStripeObject(ctx, charge.id, (json) => {
		json.disputed = true
	})
	await emitStripeEvent(ctx, 'charge.dispute.created', dispute)
	return dispute
}

export async function closeDispute(
	ctx: EmulatorContext,
	disputeId: string,
	outcome: 'won' | 'lost',
) {
	await requireStripeObject(ctx, disputeId, 'dispute', 'dispute')
	const { row } = await mutateStripeObject(ctx, disputeId, (json) => {
		json.status = outcome
	})
	await emitStripeEvent(ctx, 'charge.dispute.closed', row.json)
	return publicObject(row.json)
}

// ------------------------------------------------------------ dashboard view

export type AccountLedger = {
	charges: Json[]
	transfers: Json[]
	applicationFees: Json[]
	refunds: Json[]
	reversals: Json[]
	feeRefunds: Json[]
	disputes: Json[]
}

/** Everything the Express dashboard page shows for one connected account. */
export async function accountLedger(
	ctx: EmulatorContext,
	accountId: string,
): Promise<AccountLedger> {
	const all = async (type: string) =>
		(await ctx.store.listObjects('stripe', { type, limit: 500 })).map(
			(row: MockObjectRow) => publicObject(row.json),
		)
	const [charges, transfers, fees, refunds, reversals, feeRefunds, disputes] =
		await Promise.all([
			all('charge'),
			all('transfer'),
			all('application_fee'),
			all('refund'),
			all('transfer_reversal'),
			all('fee_refund'),
			all('dispute'),
		])
	const ownCharges = charges.filter(
		(charge) => charge.destination === accountId,
	)
	const chargeIds = new Set(ownCharges.map((charge) => charge.id))
	const ownTransfers = transfers.filter(
		(transfer) => transfer.destination === accountId,
	)
	const transferIds = new Set(ownTransfers.map((transfer) => transfer.id))
	const ownFees = fees.filter((fee) => fee.account === accountId)
	const feeIds = new Set(ownFees.map((fee) => fee.id))
	return {
		charges: ownCharges,
		transfers: ownTransfers,
		applicationFees: ownFees,
		refunds: refunds.filter((refund) => chargeIds.has(refund.charge)),
		reversals: reversals.filter((reversal) =>
			transferIds.has(reversal.transfer),
		),
		feeRefunds: feeRefunds.filter((entry) => feeIds.has(entry.fee)),
		disputes: disputes.filter((dispute) => chargeIds.has(dispute.charge)),
	}
}
