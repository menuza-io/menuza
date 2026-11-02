import { type EmulatorContext } from '../context'
import { stripeId } from '../ids'
import { type MockObjectRow } from '../store'
import { type Json } from '../util'
import { profileOfPaymentMethod, resolvePaymentMethod } from './customers'
import {
	cardError,
	invalidRequest,
	missingParam,
	noSuchResource,
	type StripeApiError,
} from './errors'
import { captureCharge, recordCharge } from './ledger'
import {
	ANY,
	assertChargeableAmount,
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

const PAYMENT_INTENT_PARAMS = {
	amount: true,
	currency: true,
	customer: true,
	payment_method: true,
	payment_method_types: [true],
	off_session: true,
	confirm: true,
	application_fee_amount: true,
	transfer_data: { destination: true, amount: true },
	metadata: ANY,
	statement_descriptor_suffix: true,
	capture_method: true,
	setup_future_usage: true,
	description: true,
	receipt_email: true,
	return_url: true,
	expand: [true],
} as const

export async function assertTransferDestination(
	ctx: EmulatorContext,
	destination: string,
	param: string,
) {
	const account = await findStripeObject(ctx, destination, 'account')
	if (!account) throw noSuchResource('destination', destination, param)
	if (account.json.capabilities?.transfers !== 'active') {
		throw invalidRequest(
			'Your destination account needs to have at least one of the following capabilities enabled: transfers, crypto_transfers, legacy_payments',
			{ code: 'transfers_not_allowed', param },
		)
	}
}

export async function createPaymentIntent(ctx: EmulatorContext, params: Json) {
	rejectUnknownParams(params, PAYMENT_INTENT_PARAMS)
	const amount = intParam(params.amount, 'amount', { required: true })!
	const currency = stringParam(params.currency, 'currency')?.toLowerCase()
	if (!currency) throw missingParam('currency')
	if (amount < 1) {
		throw invalidRequest('Invalid positive integer', {
			code: 'parameter_invalid_integer',
			param: 'amount',
		})
	}
	assertChargeableAmount(amount, currency, 'amount')
	const fee = intParam(params.application_fee_amount, 'application_fee_amount')
	const destination = stringParam(
		params.transfer_data?.destination,
		'transfer_data[destination]',
	)
	if (fee !== undefined && !destination) {
		throw invalidRequest(
			'application_fee_amount requires a destination (transfer_data[destination]).',
			{ param: 'application_fee_amount' },
		)
	}
	if (fee !== undefined && fee > amount) {
		throw invalidRequest(
			'Application fee amount cannot be larger than the payment amount.',
			{
				code: 'application_fee_amount_too_large',
				param: 'application_fee_amount',
			},
		)
	}
	if (destination) {
		await assertTransferDestination(
			ctx,
			destination,
			'transfer_data[destination]',
		)
	}
	const captureMethod =
		stringParam(params.capture_method, 'capture_method') ?? 'automatic'
	if (!['automatic', 'manual'].includes(captureMethod)) {
		throw invalidRequest(`Invalid capture_method: ${captureMethod}`, {
			code: 'parameter_invalid_enum',
			param: 'capture_method',
		})
	}
	const customer = stringParam(params.customer, 'customer')
	if (customer)
		await requireStripeObject(ctx, customer, 'customer', 'customer', 'customer')

	const id = stripeId('pi_', 24)
	const intent: Json = {
		id,
		object: 'payment_intent',
		amount,
		amount_capturable: 0,
		amount_received: 0,
		application: null,
		application_fee_amount: fee ?? null,
		automatic_payment_methods: null,
		canceled_at: null,
		cancellation_reason: null,
		capture_method: captureMethod,
		client_secret: `${id}_secret_${stripeId('', 24)}`,
		confirmation_method: 'automatic',
		created: seconds(ctx.clock.now()),
		currency,
		customer: customer ?? null,
		description: stringParam(params.description, 'description') ?? null,
		last_payment_error: null,
		latest_charge: null,
		livemode: false,
		metadata: metadataParam(params.metadata),
		next_action: null,
		payment_method: null,
		payment_method_types: ['card'],
		receipt_email: stringParam(params.receipt_email, 'receipt_email') ?? null,
		setup_future_usage:
			stringParam(params.setup_future_usage, 'setup_future_usage') ?? null,
		statement_descriptor: null,
		statement_descriptor_suffix:
			stringParam(
				params.statement_descriptor_suffix,
				'statement_descriptor_suffix',
			) ?? null,
		status: 'requires_payment_method',
		transfer_data: destination ? { destination } : null,
		transfer_group: null,
	}
	await insertStripeObject(ctx, 'payment_intent', intent)

	const paymentMethod = stringParam(params.payment_method, 'payment_method')
	if (paymentMethod) {
		const pm = await resolvePaymentMethod(ctx, paymentMethod)
		const attachedTo = pm.json.customer as string | null
		if (customer && attachedTo !== customer) {
			throw invalidRequest(
				`The customer does not have a payment method with the ID ${pm.id}. The payment method must be attached to the customer.`,
				{ code: 'resource_missing', param: 'payment_method' },
			)
		}
		if (!customer && attachedTo) {
			throw invalidRequest(
				`The provided PaymentMethod is attached to a customer. To use it, pass that customer in the \`customer\` parameter.`,
				{ code: 'payment_method_unexpected_state', param: 'payment_method' },
			)
		}
		await mutateStripeObject(ctx, id, (json) => {
			json.payment_method = pm.id
			json.status = 'requires_confirmation'
		})
	}

	if (boolParam(params.confirm, 'confirm')) {
		if (!paymentMethod) {
			throw invalidRequest(
				'You cannot confirm this PaymentIntent because it is missing a payment method.',
				{ code: 'payment_intent_unexpected_state', param: 'payment_method' },
			)
		}
		const offSession = boolParam(params.off_session, 'off_session') ?? false
		const outcome = await confirmPaymentIntent(ctx, id, { offSession })
		if (outcome.kind === 'declined') throw outcome.error
		return publicObject(outcome.intent.json)
	}
	const row = await requireStripeObject(
		ctx,
		id,
		'payment_intent',
		'payment_intent',
	)
	return publicObject(row.json)
}

export type ConfirmOutcome =
	| { kind: 'succeeded'; intent: MockObjectRow }
	| { kind: 'requires_action'; intent: MockObjectRow }
	| { kind: 'requires_capture'; intent: MockObjectRow }
	| { kind: 'declined'; intent: MockObjectRow; error: StripeApiError }

/**
 * Charge a PaymentIntent with its PaymentMethod. `authenticated` is the 3DS
 * result when the cardholder was present: `undefined` means "not asked yet"
 * (a 3DS card then ends in `requires_action`), `false` a failed challenge.
 */
export async function confirmPaymentIntent(
	ctx: EmulatorContext,
	intentId: string,
	options: {
		offSession?: boolean
		authenticated?: boolean
		billing?: { email?: string | null; name?: string | null }
	} = {},
): Promise<ConfirmOutcome> {
	const intent = await requireStripeObject(
		ctx,
		intentId,
		'payment_intent',
		'payment_intent',
	)
	if (
		![
			'requires_confirmation',
			'requires_action',
			'requires_payment_method',
		].includes(String(intent.json.status))
	) {
		throw invalidRequest(
			`This PaymentIntent's status is ${String(intent.json.status)} and cannot be confirmed.`,
			{ code: 'payment_intent_unexpected_state' },
		)
	}
	const pmId = intent.json.payment_method as string | null
	if (!pmId) {
		throw invalidRequest('This PaymentIntent is missing a payment method.', {
			code: 'payment_intent_unexpected_state',
			param: 'payment_method',
		})
	}
	const pm = await requireStripeObject(
		ctx,
		pmId,
		'payment_method',
		'PaymentMethod',
	)
	const profile = profileOfPaymentMethod(pm.json)

	const fail = async (decline: {
		code: string
		declineCode: string
		message: string
	}): Promise<ConfirmOutcome> => {
		const { row } = await mutateStripeObject(ctx, intentId, (json) => {
			json.status = 'requires_payment_method'
			json.payment_method = null
			json.next_action = null
			json.last_payment_error = {
				type: 'card_error',
				code: decline.code,
				decline_code: decline.declineCode,
				message: decline.message,
				payment_method: publicObject(pm.json),
			}
		})
		await emitStripeEvent(ctx, 'payment_intent.payment_failed', row.json)
		return {
			kind: 'declined',
			intent: row,
			error: cardError(decline.message, {
				code: decline.code,
				declineCode: decline.declineCode,
				paymentIntent: publicObject(row.json),
				paymentMethod: publicObject(pm.json),
			}),
		}
	}

	if (options.offSession) {
		if (profile.offSessionAuthRequired) {
			return fail({
				code: 'authentication_required',
				declineCode: 'authentication_not_handled',
				message:
					'Your card was declined. This transaction requires authentication.',
			})
		}
	} else if (profile.threeDS && options.authenticated !== true) {
		if (options.authenticated === false) {
			return fail({
				code: 'payment_intent_authentication_failure',
				declineCode: 'authentication_failure',
				message:
					'We are unable to authenticate your payment method. Please choose a different payment method and try again.',
			})
		}
		const { row } = await mutateStripeObject(ctx, intentId, (json) => {
			json.status = 'requires_action'
			json.next_action = {
				type: 'use_stripe_sdk',
				use_stripe_sdk: { type: 'three_d_secure_redirect' },
			}
		})
		await emitStripeEvent(ctx, 'payment_intent.requires_action', row.json)
		return { kind: 'requires_action', intent: row }
	}
	if (profile.chargeDecline) {
		return fail({
			code: profile.chargeDecline.code,
			declineCode: profile.chargeDecline.declineCode,
			message: profile.chargeDecline.message,
		})
	}

	const manual = intent.json.capture_method === 'manual'
	const charge = await recordCharge(ctx, {
		paymentIntent: intent.json,
		paymentMethod: pm.json,
		captured: !manual,
		billing: options.billing,
	})
	const { row } = await mutateStripeObject(ctx, intentId, (json) => {
		json.latest_charge = charge.id
		json.next_action = null
		json.last_payment_error = null
		if (manual) {
			json.status = 'requires_capture'
			json.amount_capturable = json.amount
		} else {
			json.status = 'succeeded'
			json.amount_received = json.amount
		}
	})
	if (manual) {
		await emitStripeEvent(
			ctx,
			'payment_intent.amount_capturable_updated',
			row.json,
		)
		return { kind: 'requires_capture', intent: row }
	}
	await emitStripeEvent(ctx, 'payment_intent.succeeded', row.json)
	await emitStripeEvent(ctx, 'charge.succeeded', charge)
	return { kind: 'succeeded', intent: row }
}

export async function retrievePaymentIntent(
	ctx: EmulatorContext,
	id: string,
	params: Json,
) {
	rejectUnknownParams(params, { expand: [true] })
	const row = await requireStripeObject(
		ctx,
		id,
		'payment_intent',
		'payment_intent',
	)
	const result = publicObject(row.json)
	for (const path of toList(params.expand)) {
		if (path === 'payment_method' && row.json.payment_method) {
			const pm = await findStripeObject(
				ctx,
				String(row.json.payment_method),
				'payment_method',
			)
			if (pm) result.payment_method = publicObject(pm.json)
		} else if (path === 'latest_charge' && row.json.latest_charge) {
			const charge = await findStripeObject(
				ctx,
				String(row.json.latest_charge),
				'charge',
			)
			if (charge) result.latest_charge = publicObject(charge.json)
		} else if (path === 'customer' && row.json.customer) {
			const customer = await findStripeObject(
				ctx,
				String(row.json.customer),
				'customer',
			)
			if (customer) result.customer = publicObject(customer.json)
		} else {
			throw invalidRequest(`This property cannot be expanded (${path}).`, {
				code: 'parameter_invalid_empty',
				param: 'expand',
			})
		}
	}
	return result
}

export function toList(value: unknown): string[] {
	if (value === undefined) return []
	return (Array.isArray(value) ? value : [value]).map(String)
}

export async function cancelPaymentIntent(
	ctx: EmulatorContext,
	id: string,
	params: Json,
) {
	rejectUnknownParams(params, { cancellation_reason: true })
	const row = await requireStripeObject(
		ctx,
		id,
		'payment_intent',
		'payment_intent',
	)
	const status = String(row.json.status)
	if (
		![
			'requires_payment_method',
			'requires_capture',
			'requires_confirmation',
			'requires_action',
		].includes(status)
	) {
		throw invalidRequest(
			`You cannot cancel this PaymentIntent because it has a status of ${status}. Only a PaymentIntent with one of the following statuses may be canceled: requires_payment_method, requires_capture, requires_confirmation, requires_action.`,
			{ code: 'payment_intent_unexpected_state' },
		)
	}
	const { row: canceled } = await mutateStripeObject(ctx, id, (json) => {
		json.status = 'canceled'
		json.canceled_at = seconds(ctx.clock.now())
		json.cancellation_reason =
			stringParam(params.cancellation_reason, 'cancellation_reason') ??
			'requested_by_customer'
		json.amount_capturable = 0
		json.next_action = null
	})
	await emitStripeEvent(ctx, 'payment_intent.canceled', canceled.json)
	return publicObject(canceled.json)
}

export async function capturePaymentIntent(
	ctx: EmulatorContext,
	id: string,
	params: Json,
) {
	rejectUnknownParams(params, { amount_to_capture: true })
	const row = await requireStripeObject(
		ctx,
		id,
		'payment_intent',
		'payment_intent',
	)
	if (row.json.status !== 'requires_capture') {
		throw invalidRequest(
			`This PaymentIntent could not be captured because it has a status of ${String(row.json.status)}. Only a PaymentIntent with one of the following statuses may be captured: requires_capture.`,
			{ code: 'payment_intent_unexpected_state' },
		)
	}
	const requested = intParam(params.amount_to_capture, 'amount_to_capture')
	const charge = await captureCharge(
		ctx,
		String(row.json.latest_charge),
		requested,
	)
	const { row: captured } = await mutateStripeObject(ctx, id, (json) => {
		json.status = 'succeeded'
		json.amount_received = charge.amount_captured
		json.amount_capturable = 0
	})
	await emitStripeEvent(ctx, 'payment_intent.succeeded', captured.json)
	return publicObject(captured.json)
}

export async function retrieveSetupIntent(ctx: EmulatorContext, id: string) {
	const row = await requireStripeObject(ctx, id, 'setup_intent', 'setup_intent')
	return publicObject(row.json)
}
