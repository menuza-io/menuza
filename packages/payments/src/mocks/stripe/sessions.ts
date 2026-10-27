import {
	NON_TEST_CARD_MESSAGE,
	stripeProfileForDigits,
	validateCardInput,
	type CardInput,
} from '../cards'
import { type EmulatorContext } from '../context'
import { stripeId } from '../ids'
import { type Json } from '../util'
import {
	attachPaymentMethodRaw,
	createCustomer,
	createPaymentMethodFromCard,
} from './customers'
import { invalidRequest, missingParam } from './errors'
import {
	confirmPaymentIntent,
	createPaymentIntent,
	toList,
	assertTransferDestination,
} from './intents'
import { createDispute } from './ledger'
import {
	ANY,
	assertChargeableAmount,
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

const THIRTY_MINUTES = 30 * 60
const TWENTY_FOUR_HOURS = 24 * 60 * 60

const SESSION_PARAMS = {
	mode: true,
	currency: true,
	customer: true,
	customer_email: true,
	client_reference_id: true,
	payment_method_types: [true],
	line_items: [
		{
			quantity: true,
			price: true,
			price_data: {
				currency: true,
				unit_amount: true,
				tax_behavior: true,
				product_data: {
					name: true,
					description: true,
					tax_code: true,
					images: [true],
					metadata: ANY,
				},
			},
		},
	],
	payment_intent_data: {
		application_fee_amount: true,
		transfer_data: { destination: true },
		metadata: ANY,
		setup_future_usage: true,
		capture_method: true,
		statement_descriptor_suffix: true,
		description: true,
	},
	setup_intent_data: { metadata: ANY, description: true },
	success_url: true,
	cancel_url: true,
	metadata: ANY,
	expires_at: true,
	custom_text: { submit: { message: true }, after_submit: { message: true } },
	payment_method_collection: true,
	allow_promotion_codes: true,
	locale: true,
	expand: [true],
} as const

export async function createCheckoutSession(
	ctx: EmulatorContext,
	params: Json,
) {
	rejectUnknownParams(params, SESSION_PARAMS)
	const mode = stringParam(params.mode, 'mode')
	if (!mode) throw missingParam('mode')
	if (mode !== 'payment' && mode !== 'setup') {
		throw invalidRequest(
			`The mock emulator supports mode=payment and mode=setup; got ${mode}.`,
			{ code: 'parameter_invalid_enum', param: 'mode' },
		)
	}
	for (const field of ['success_url', 'cancel_url'] as const) {
		const value = stringParam(params[field], field)
		if (field === 'success_url' && !value) throw missingParam(field)
		if (value && !/^https?:\/\//.test(value)) {
			throw invalidRequest('Not a valid URL', {
				code: 'url_invalid',
				param: field,
			})
		}
	}
	const types = toList(params.payment_method_types)
	if (types.some((type) => type !== 'card')) {
		throw invalidRequest('The mock emulator only supports card payments.', {
			code: 'parameter_invalid_enum',
			param: 'payment_method_types',
		})
	}
	const message = params.custom_text?.submit?.message
	if (typeof message === 'string' && message.length > 1200) {
		throw invalidRequest(
			'custom_text[submit][message] must be at most 1200 characters.',
			{
				code: 'parameter_invalid_string_length',
				param: 'custom_text[submit][message]',
			},
		)
	}
	const now = seconds(ctx.clock.now())
	const expiresAt =
		intParam(params.expires_at, 'expires_at') ?? now + TWENTY_FOUR_HOURS
	if (expiresAt < now + THIRTY_MINUTES || expiresAt > now + TWENTY_FOUR_HOURS) {
		throw invalidRequest(
			'The `expires_at` timestamp must be between 30 minutes and 24 hours from now.',
			{ code: 'parameter_invalid_integer', param: 'expires_at' },
		)
	}
	const customer = stringParam(params.customer, 'customer')
	if (customer)
		await requireStripeObject(ctx, customer, 'customer', 'customer', 'customer')

	let currency = stringParam(params.currency, 'currency')?.toLowerCase()
	let amountTotal = 0
	const lineItems: Json[] = []
	let intentData: Json | null = null
	if (mode === 'payment') {
		const items = (
			Array.isArray(params.line_items) ? params.line_items : []
		) as Json[]
		if (items.length === 0) throw missingParam('line_items')
		for (const [index, item] of items.entries()) {
			const priceData = item.price_data
			if (!priceData) {
				throw invalidRequest(
					'The mock emulator requires line_items[][price_data].',
					{
						code: 'parameter_missing',
						param: `line_items[${index}][price_data]`,
					},
				)
			}
			const itemCurrency = stringParam(
				priceData.currency,
				'currency',
			)?.toLowerCase()
			if (!itemCurrency)
				throw missingParam(`line_items[${index}][price_data][currency]`)
			if (currency && currency !== itemCurrency) {
				throw invalidRequest('All line items must share one currency.', {
					param: `line_items[${index}][price_data][currency]`,
				})
			}
			currency = itemCurrency
			const unit = intParam(
				priceData.unit_amount,
				`line_items[${index}][price_data][unit_amount]`,
				{ required: true },
			)!
			const quantity =
				intParam(item.quantity, `line_items[${index}][quantity]`) ?? 1
			const name = stringParam(priceData.product_data?.name, 'name')
			if (!name)
				throw missingParam(
					`line_items[${index}][price_data][product_data][name]`,
				)
			amountTotal += unit * quantity
			lineItems.push({
				name,
				description: priceData.product_data?.description ?? null,
				unit_amount: unit,
				quantity,
			})
		}
		assertChargeableAmount(amountTotal, currency!, 'line_items')
		const data = params.payment_intent_data ?? {}
		const fee = intParam(
			data.application_fee_amount,
			'payment_intent_data[application_fee_amount]',
		)
		const destination = stringParam(
			data.transfer_data?.destination,
			'payment_intent_data[transfer_data][destination]',
		)
		if (fee !== undefined && !destination) {
			throw invalidRequest(
				'application_fee_amount requires a destination (transfer_data[destination]).',
				{ param: 'payment_intent_data[application_fee_amount]' },
			)
		}
		if (fee !== undefined && fee > amountTotal) {
			throw invalidRequest(
				'Application fee amount cannot be larger than the payment amount.',
				{
					code: 'application_fee_amount_too_large',
					param: 'payment_intent_data[application_fee_amount]',
				},
			)
		}
		if (destination) {
			await assertTransferDestination(
				ctx,
				destination,
				'payment_intent_data[transfer_data][destination]',
			)
		}
		intentData = {
			application_fee_amount: fee,
			destination,
			metadata: metadataParam(data.metadata),
			setup_future_usage: data.setup_future_usage ?? null,
			capture_method: data.capture_method ?? 'automatic',
			statement_descriptor_suffix: data.statement_descriptor_suffix ?? null,
		}
	} else if (!currency && types.length === 0) {
		throw invalidRequest(
			'You must provide either `currency` or `payment_method_types` when `mode=setup`.',
			{ code: 'parameter_missing', param: 'currency' },
		)
	}

	const id = stripeId('cs_test_', 58)
	const session: Json = {
		id,
		object: 'checkout.session',
		mode,
		status: 'open',
		payment_status: 'unpaid',
		amount_subtotal: mode === 'payment' ? amountTotal : null,
		amount_total: mode === 'payment' ? amountTotal : null,
		currency: currency ?? 'usd',
		client_reference_id:
			stringParam(params.client_reference_id, 'client_reference_id') ?? null,
		created: now,
		customer: customer ?? null,
		customer_details: null,
		customer_email:
			stringParam(params.customer_email, 'customer_email') ?? null,
		custom_text: {
			submit: message ? { message } : null,
			after_submit: null,
			shipping_address: null,
			terms_of_service_acceptance: null,
		},
		expires_at: expiresAt,
		livemode: false,
		locale: null,
		metadata: metadataParam(params.metadata),
		payment_intent: null,
		payment_method_types: ['card'],
		setup_intent: null,
		success_url: params.success_url,
		cancel_url: params.cancel_url ?? null,
		url: `${ctx.origin}/mock-payments/stripe/checkout/${id}`,
		__mock: {
			lineItems,
			intentData,
			setupMetadata: metadataParam(params.setup_intent_data?.metadata),
			completing: false,
		},
	}
	await insertStripeObject(ctx, 'checkout.session', session, {
		transitionAt: expiresAt * 1000,
	})
	return publicObject(session)
}

export async function retrieveCheckoutSession(
	ctx: EmulatorContext,
	id: string,
	params: Json,
) {
	rejectUnknownParams(params, { expand: [true] })
	const row = await requireStripeObject(
		ctx,
		id,
		'checkout.session',
		'checkout.session',
	)
	const result = publicObject(row.json)
	for (const path of toList(params.expand)) {
		if (path === 'payment_intent' && row.json.payment_intent) {
			const intent = await findStripeObject(
				ctx,
				String(row.json.payment_intent),
				'payment_intent',
			)
			if (intent) result.payment_intent = publicObject(intent.json)
		} else if (path === 'setup_intent' && row.json.setup_intent) {
			const intent = await findStripeObject(
				ctx,
				String(row.json.setup_intent),
				'setup_intent',
			)
			if (intent) result.setup_intent = publicObject(intent.json)
		} else if (path === 'customer' && row.json.customer) {
			const customer = await findStripeObject(
				ctx,
				String(row.json.customer),
				'customer',
			)
			if (customer) result.customer = publicObject(customer.json)
		} else if (!['payment_intent', 'setup_intent', 'customer'].includes(path)) {
			throw invalidRequest(`This property cannot be expanded (${path}).`, {
				code: 'parameter_invalid_empty',
				param: 'expand',
			})
		}
	}
	return result
}

export async function expireCheckoutSession(ctx: EmulatorContext, id: string) {
	const row = await requireStripeObject(
		ctx,
		id,
		'checkout.session',
		'checkout.session',
	)
	if (row.json.status !== 'open') {
		throw invalidRequest(
			'Only Checkout Sessions with a status in (open) can be expired.',
			{ code: 'checkout_session_not_open' },
		)
	}
	return markSessionExpired(ctx, id)
}

/** Idempotent: only an open session expires, and its event fires once. */
export async function markSessionExpired(ctx: EmulatorContext, id: string) {
	let expired = false
	const { row } = await mutateStripeObject(
		ctx,
		id,
		(json) => {
			if (json.status !== 'open') return
			expired = true
			json.status = 'expired'
		},
		() => null,
	)
	if (expired) await emitStripeEvent(ctx, 'checkout.session.expired', row.json)
	return publicObject(row.json)
}

export type CheckoutSubmission = CardInput & {
	email?: string
	name?: string
	postalCode?: string
	/** The cardholder's choice on a 3DS challenge (headless runs). */
	threeDS?: 'complete' | 'fail'
}

export type CheckoutResult =
	| { status: 'paid' | 'saved'; redirectUrl: string }
	| { status: 'requires_3ds'; attemptId: string }
	| { status: 'declined'; code: string; message: string }
	| { status: 'invalid'; field: 'number' | 'expiry' | 'cvc'; message: string }
	| { status: 'inactive' }

type CardDetails = {
	profileKey: string
	last4: string
	expMonth: number
	expYear: number
	billing: {
		email: string | null
		name: string | null
		postalCode: string | null
	}
}

export function successRedirect(session: Json) {
	return String(session.success_url).replaceAll(
		'{CHECKOUT_SESSION_ID}',
		String(session.id),
	)
}

async function isOpen(ctx: EmulatorContext, id: string) {
	const row = await findStripeObject(ctx, id, 'checkout.session')
	if (!row) return null
	if (
		row.json.status === 'open' &&
		Number(row.json.expires_at) * 1000 <= ctx.clock.now()
	) {
		await markSessionExpired(ctx, id)
		return null
	}
	return row.json.status === 'open' ? row : null
}

/** The hosted page's Pay / Save card button, and the headless equivalent. */
export async function submitCheckoutCard(
	ctx: EmulatorContext,
	sessionId: string,
	submission: CheckoutSubmission,
): Promise<CheckoutResult> {
	const session = await isOpen(ctx, sessionId)
	if (!session) return { status: 'inactive' }
	const valid = validateCardInput(submission, ctx.clock.now())
	if (!valid.ok) {
		return {
			status: 'invalid',
			field:
				valid.code === 'invalid_number'
					? 'number'
					: valid.code === 'invalid_expiry'
						? 'expiry'
						: 'cvc',
			message: valid.message,
		}
	}
	const profile = stripeProfileForDigits(valid.digits)
	if (!profile) {
		return {
			status: 'declined',
			code: 'card_declined',
			message: NON_TEST_CARD_MESSAGE,
		}
	}
	const card: CardDetails = {
		profileKey: profile.key,
		last4: valid.digits.slice(-4),
		expMonth: valid.expMonth,
		expYear: valid.expYear,
		billing: {
			email:
				submission.email?.trim() ||
				(session.json.customer_email as string | null) ||
				null,
			name: submission.name?.trim() || null,
			postalCode: submission.postalCode?.trim() || null,
		},
	}
	if (profile.threeDS && !submission.threeDS) {
		const attemptId = stripeId('mockattempt_', 24)
		await insertStripeObject(
			ctx,
			'checkout.attempt',
			{
				id: attemptId,
				object: 'checkout.attempt',
				session: sessionId,
				status: 'open',
				card,
			},
			{ parentId: sessionId },
		)
		return { status: 'requires_3ds', attemptId }
	}
	return finishAttempt(
		ctx,
		sessionId,
		card,
		profile.threeDS ? submission.threeDS === 'complete' : undefined,
	)
}

export async function describeAttempt(ctx: EmulatorContext, attemptId: string) {
	const attempt = await findStripeObject(ctx, attemptId, 'checkout.attempt')
	if (!attempt) return null
	const session = await findStripeObject(
		ctx,
		String(attempt.json.session),
		'checkout.session',
	)
	if (!session) return null
	return {
		attempt: attempt.json,
		session: publicObject(session.json),
		open: attempt.json.status === 'open' && session.json.status === 'open',
	}
}

/** Complete or fail the 3DS challenge the hosted page redirected to. */
export async function resolveThreeDSChallenge(
	ctx: EmulatorContext,
	attemptId: string,
	decision: 'complete' | 'fail',
): Promise<CheckoutResult & { sessionId?: string }> {
	const attempt = await findStripeObject(ctx, attemptId, 'checkout.attempt')
	if (!attempt) return { status: 'inactive' }
	const sessionId = String(attempt.json.session)
	let claimed = false
	await mutateStripeObject(ctx, attemptId, (json) => {
		if (json.status !== 'open') return
		claimed = true
		json.status = 'used'
	})
	if (!claimed) return { status: 'inactive', sessionId }
	const result = await finishAttempt(
		ctx,
		sessionId,
		attempt.json.card as CardDetails,
		decision === 'complete',
	)
	return { ...result, sessionId }
}

async function finishAttempt(
	ctx: EmulatorContext,
	sessionId: string,
	card: CardDetails,
	authenticated: boolean | undefined,
): Promise<CheckoutResult> {
	const profile =
		stripeProfileForDigits(card.profileKey) ??
		stripeProfileForDigits('4242424242424242')!
	// Single-shot: the claim and the status check are one compare-and-set.
	let claimed = false
	const { row: claimedRow } = await mutateStripeObject(
		ctx,
		sessionId,
		(json) => {
			if (json.status !== 'open' || json.__mock?.completing) return
			claimed = true
			json.__mock = { ...json.__mock, completing: true }
		},
	)
	if (!claimed) return { status: 'inactive' }
	const release = () =>
		mutateStripeObject(ctx, sessionId, (json) => {
			json.__mock = { ...json.__mock, completing: false }
		})

	if (profile.threeDS && authenticated === false) {
		await release()
		return {
			status: 'declined',
			code: 'payment_intent_authentication_failure',
			message:
				'We are unable to authenticate your payment method. Please choose a different payment method and try again.',
		}
	}
	const session = claimedRow.json
	const method = await createPaymentMethodFromCard(
		ctx,
		{
			profile,
			last4: card.last4,
			expMonth: card.expMonth,
			expYear: card.expYear,
		},
		card.billing,
	)
	const customerDetails = {
		email: card.billing.email,
		name: card.billing.name,
		phone: null,
		address: { country: 'US', postal_code: card.billing.postalCode },
		tax_exempt: 'none',
		tax_ids: [],
	}

	if (session.mode === 'setup') {
		if (profile.setupDecline) {
			await release()
			return {
				status: 'declined',
				code: profile.setupDecline.declineCode,
				message: profile.setupDecline.message,
			}
		}
		let customerId = session.customer as string | null
		if (!customerId) {
			customerId = (
				await createCustomer(
					ctx,
					card.billing.email ? { email: card.billing.email } : {},
				)
			).id
		}
		await attachPaymentMethodRaw(ctx, method.id, customerId)
		const setupIntent = {
			id: stripeId('seti_', 24),
			object: 'setup_intent',
			created: seconds(ctx.clock.now()),
			customer: customerId,
			livemode: false,
			metadata: session.__mock?.setupMetadata ?? {},
			payment_method: method.id,
			payment_method_types: ['card'],
			status: 'succeeded',
			usage: 'off_session',
			last_setup_error: null,
		}
		await insertStripeObject(ctx, 'setup_intent', setupIntent)
		const { row } = await mutateStripeObject(
			ctx,
			sessionId,
			(json) => {
				json.status = 'complete'
				json.payment_status = 'no_payment_required'
				json.setup_intent = setupIntent.id
				json.customer = customerId
				json.customer_details = customerDetails
				json.__mock = { ...json.__mock, completing: false }
			},
			() => null,
		)
		await emitStripeEvent(ctx, 'setup_intent.succeeded', setupIntent)
		await emitStripeEvent(ctx, 'checkout.session.completed', row.json)
		return { status: 'saved', redirectUrl: successRedirect(row.json) }
	}

	const data = (session.__mock?.intentData ?? {}) as Json
	let customerId = session.customer as string | null
	if (data.setup_future_usage && !customerId) {
		customerId = (
			await createCustomer(
				ctx,
				card.billing.email ? { email: card.billing.email } : {},
			)
		).id
	}
	if (customerId) await attachPaymentMethodRaw(ctx, method.id, customerId)
	const intent = await createPaymentIntent(ctx, {
		amount: session.amount_total,
		currency: session.currency,
		...(customerId ? { customer: customerId } : {}),
		payment_method: method.id,
		...(data.application_fee_amount !== undefined &&
		data.application_fee_amount !== null
			? { application_fee_amount: data.application_fee_amount }
			: {}),
		...(data.destination
			? { transfer_data: { destination: data.destination } }
			: {}),
		metadata: data.metadata ?? {},
		capture_method: data.capture_method ?? 'automatic',
		...(data.setup_future_usage
			? { setup_future_usage: data.setup_future_usage }
			: {}),
		...(data.statement_descriptor_suffix
			? { statement_descriptor_suffix: data.statement_descriptor_suffix }
			: {}),
		receipt_email: card.billing.email ?? undefined,
	})
	const outcome = await confirmPaymentIntent(ctx, String(intent.id), {
		authenticated: authenticated ?? undefined,
		billing: card.billing,
	})
	if (outcome.kind === 'declined') {
		await release()
		return {
			status: 'declined',
			code:
				outcome.error.extra.declineCode ??
				outcome.error.extra.code ??
				'card_declined',
			message: outcome.error.message,
		}
	}
	const { row } = await mutateStripeObject(
		ctx,
		sessionId,
		(json) => {
			json.status = 'complete'
			json.payment_status = 'paid'
			json.payment_intent = intent.id
			json.customer = customerId
			json.customer_details = customerDetails
			json.__mock = { ...json.__mock, completing: false }
		},
		() => null,
	)
	await emitStripeEvent(ctx, 'checkout.session.completed', row.json)
	if (profile.dispute) {
		await createDispute(ctx, { paymentIntent: String(intent.id) })
	}
	return { status: 'paid', redirectUrl: successRedirect(row.json) }
}

export async function describeCheckoutSession(
	ctx: EmulatorContext,
	id: string,
) {
	const row = await findStripeObject(ctx, id, 'checkout.session')
	if (!row) return null
	const merchant = await merchantFor(ctx, row.json)
	return {
		session: publicObject(row.json),
		lineItems: (row.json.__mock?.lineItems ?? []) as Json[],
		merchant,
		active:
			row.json.status === 'open' &&
			Number(row.json.expires_at) * 1000 > ctx.clock.now(),
	}
}

async function merchantFor(ctx: EmulatorContext, session: Json) {
	const destination = session.__mock?.intentData?.destination as
		string | undefined
	if (!destination) return null
	const account = await findStripeObject(ctx, destination, 'account')
	return account
		? {
				id: String(account.json.id),
				name:
					(account.json.metadata?.organizationName as string | undefined) ??
					null,
			}
		: null
}
