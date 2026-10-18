import {
	CHECKOUT_3DS_FAILED,
	CHECKOUT_3DS_PASSWORD,
	CHECKOUT_MIT_DECLINE,
	checkoutAmountDecline,
	checkoutProfileForDigits,
	validateCardInput,
	type CheckoutCardProfile,
} from '../cards'
import { type EmulatorContext } from '../context'
import { checkoutId, stripeId } from '../ids'
import { type MockObjectRow } from '../store'
import { isRecord, type Json } from '../util'
import {
	normalizeAllocations,
	reverseAllocations,
	validateReversal,
	type Allocation,
} from './allocations'
import { CheckoutApiError, invalidRequest, notFound } from './errors'
import {
	CHECKOUT_LINK_HOST,
	emitCheckoutEvent,
	findCheckoutObject,
	insertCheckoutObject,
	isoNow,
	mutateCheckoutObject,
	publicObject,
} from './state'

/** Pending refund actions settle after this long (mock time). */
const REFUND_SETTLES_AFTER_MS = 1000

type CardInfo = {
	profileKey: string
	scheme: string
	last4: string
	expMonth: number
	expYear: number
}

type Outcome =
	| { approved: true }
	| { approved: false; responseCode: string; summary: string }

const APPROVED = { responseCode: '10000', summary: 'Approved' }

function paymentLinks(id: string) {
	return {
		self: { href: `${CHECKOUT_LINK_HOST}/payments/${id}` },
		actions: { href: `${CHECKOUT_LINK_HOST}/payments/${id}/actions` },
		refund: { href: `${CHECKOUT_LINK_HOST}/payments/${id}/refunds` },
	}
}

function sourceBody(card: CardInfo, sourceId?: string | null) {
	return {
		...(sourceId ? { id: sourceId } : {}),
		type: 'card',
		expiry_month: card.expMonth,
		expiry_year: card.expYear,
		scheme: card.scheme,
		last4: card.last4,
		fingerprint: `fp_${card.profileKey.slice(-8)}`,
		bin: card.profileKey.slice(0, 6),
		card_type: 'CREDIT',
		card_category: 'CONSUMER',
		issuer_country: 'GB',
	}
}

/** Fields a payment webhook carries (`data`). */
export function paymentEventData(
	ctx: EmulatorContext,
	payment: Json,
	action: Json,
	extra: { hostedPaymentId?: string | null; allocations?: unknown } = {},
) {
	return {
		id: payment.id,
		action_id: action.id,
		payment_type: payment.payment_type,
		amount: action.amount ?? payment.amount,
		currency: payment.currency,
		approved: action.approved,
		status:
			action.type === 'Authorization' || action.type === 'Capture'
				? payment.status
				: action.type,
		auth_code: action.auth_code ?? null,
		response_code: action.response_code ?? null,
		response_summary: action.response_summary ?? null,
		reference: payment.reference,
		metadata: payment.metadata,
		source: payment.source,
		customer: payment.customer,
		processing: {
			acquirer_transaction_id: payment.__mock?.acquirerTransactionId,
			retrieval_reference_number: payment.__mock?.retrievalReferenceNumber,
			// A named fidelity switch: unverified for HPP payments, so absent by default.
			...(ctx.fidelity.checkoutSessionIdOnWebhooks && extra.hostedPaymentId
				? { payment_session_id: extra.hostedPaymentId }
				: {}),
		},
		amount_allocations: extra.allocations ?? payment.amount_allocations ?? [],
		processed_on: action.processed_on,
	}
}

async function recordPayment(
	ctx: EmulatorContext,
	input: {
		amount: number
		currency: string
		reference: string | null
		metadata: Json
		paymentType: 'Regular' | 'Unscheduled'
		merchantInitiated: boolean
		previousPaymentId: string | null
		card: CardInfo
		sourceId: string | null
		customer: {
			id?: string | null
			email?: string | null
			name?: string | null
		}
		allocations: Allocation[]
		processingChannelId: string | null
		outcome: Outcome
		capture: boolean
		hostedPaymentId: string | null
		storeSource: boolean
	},
) {
	const approved = input.outcome.approved
	const paymentId = checkoutId('pay_')
	const now = isoNow(ctx)
	let sourceId = input.sourceId
	let customerId = input.customer.id ?? null
	let schemeId: string | null = null
	if (approved && input.storeSource) {
		sourceId = checkoutId('src_')
		customerId = customerId ?? checkoutId('cus_')
		schemeId = Array.from({ length: 15 }, () =>
			Math.floor(Math.random() * 10),
		).join('')
		await insertCheckoutObject(ctx, 'source', {
			id: sourceId,
			customer_id: customerId,
			card: input.card,
			scheme_id: schemeId,
			created_on: now,
		})
	}
	const decline = input.outcome.approved ? null : input.outcome
	const status = !approved
		? 'Declined'
		: input.capture
			? 'Captured'
			: 'Authorized'
	const code = decline?.responseCode ?? APPROVED.responseCode
	const summary = decline?.summary ?? APPROVED.summary
	const authorization = {
		id: checkoutId('act_'),
		type: 'Authorization',
		processed_on: now,
		amount: input.amount,
		approved,
		auth_code: approved
			? String(Math.floor(100000 + Math.random() * 900000))
			: null,
		response_code: code,
		response_summary: summary,
		reference: input.reference,
		metadata: input.metadata,
	}
	const payment: Json = {
		id: paymentId,
		requested_on: now,
		source: sourceBody(input.card, sourceId),
		amount: input.amount,
		currency: input.currency,
		payment_type: input.paymentType,
		merchant_initiated: input.merchantInitiated,
		previous_payment_id: input.previousPaymentId,
		reference: input.reference,
		status,
		approved,
		balances: approved
			? {
					total_authorized: input.amount,
					total_captured: input.capture ? input.amount : 0,
					total_refunded: 0,
					total_voided: 0,
					available_to_capture: input.capture ? 0 : input.amount,
					available_to_refund: input.capture ? input.amount : 0,
					available_to_void: input.capture ? 0 : input.amount,
				}
			: undefined,
		risk: { flagged: false },
		customer: {
			...(customerId ? { id: customerId } : {}),
			...(input.customer.email ? { email: input.customer.email } : {}),
			...(input.customer.name ? { name: input.customer.name } : {}),
		},
		billing_descriptor: { name: 'Menuza mock', city: 'Local' },
		processing: { acquirer_transaction_id: authorization.id },
		processing_channel_id: input.processingChannelId,
		metadata: input.metadata,
		amount_allocations: input.allocations,
		eci: approved ? '05' : null,
		scheme_id: schemeId ?? (approved ? '000000000000000' : null),
		response_code: code,
		response_summary: summary,
		_links: paymentLinks(paymentId),
		__mock: {
			hostedPaymentId: input.hostedPaymentId,
			refundReserved: 0,
			reversed: {},
			acquirerTransactionId: authorization.id,
			retrievalReferenceNumber: String(
				Math.floor(Math.random() * 1e12),
			).padStart(12, '0'),
		},
	}
	await insertCheckoutObject(ctx, 'payment', payment)
	await insertCheckoutObject(ctx, 'action', authorization, {
		parentId: paymentId,
	})
	let last: Json = authorization
	if (approved && input.capture) {
		last = {
			id: checkoutId('act_'),
			type: 'Capture',
			processed_on: now,
			amount: input.amount,
			approved: true,
			response_code: '10000',
			response_summary: 'Approved',
			reference: input.reference,
			metadata: input.metadata,
		}
		await insertCheckoutObject(ctx, 'action', last, { parentId: paymentId })
	}
	return { payment, authorization, capture: last, approved }
}

async function announce(
	ctx: EmulatorContext,
	result: Awaited<ReturnType<typeof recordPayment>>,
	hostedPaymentId: string | null,
) {
	const extra = { hostedPaymentId }
	if (!result.approved) {
		await emitCheckoutEvent(
			ctx,
			'payment_declined',
			paymentEventData(ctx, result.payment, result.authorization, extra),
		)
		return
	}
	await emitCheckoutEvent(
		ctx,
		'payment_approved',
		paymentEventData(ctx, result.payment, result.authorization, extra),
	)
	if (result.payment.status === 'Captured') {
		await emitCheckoutEvent(
			ctx,
			'payment_captured',
			paymentEventData(ctx, result.payment, result.capture, extra),
		)
	}
}

function paymentResponse(result: Awaited<ReturnType<typeof recordPayment>>) {
	const payment = publicObject(result.payment)
	return {
		id: payment.id,
		action_id: result.authorization.id,
		amount: payment.amount,
		currency: payment.currency,
		approved: payment.approved,
		status: payment.status,
		auth_code: result.authorization.auth_code,
		response_code: payment.response_code,
		response_summary: payment.response_summary,
		risk: payment.risk,
		source: payment.source,
		customer: payment.customer,
		processed_on: result.authorization.processed_on,
		scheme_id: payment.scheme_id,
		reference: payment.reference,
		processing: payment.processing,
		_links: payment._links,
	}
}

// ------------------------------------------------------------ hosted payments

function isUrl(value: unknown) {
	return typeof value === 'string' && /^https?:\/\//.test(value)
}

export async function createHostedPayment(ctx: EmulatorContext, body: unknown) {
	const input = isRecord(body) ? body : {}
	const codes: string[] = []
	if (!Number.isInteger(input.amount) || (input.amount as number) <= 0)
		codes.push('amount_required')
	if (
		typeof input.currency !== 'string' ||
		!/^[A-Za-z]{3}$/.test(input.currency)
	)
		codes.push('currency_required')
	if (typeof input.reference !== 'string' || input.reference === '')
		codes.push('reference_required')
	if (
		typeof input.processing_channel_id !== 'string' ||
		input.processing_channel_id === ''
	) {
		codes.push('processing_channel_id_required')
	}
	if (
		typeof input.billing?.address?.country !== 'string' ||
		input.billing.address.country.length !== 2
	) {
		codes.push('billing_address_country_required')
	}
	for (const field of ['success_url', 'failure_url', 'cancel_url'] as const) {
		if (!isUrl(input[field])) codes.push(`${field}_required`)
	}
	if (
		input.payment_type !== undefined &&
		!['Regular', 'Unscheduled'].includes(String(input.payment_type))
	) {
		codes.push('payment_type_invalid')
	}
	if (codes.length > 0) throw invalidRequest(...codes)
	const allocations = await normalizeAllocations(
		ctx,
		input.amount_allocations,
		input.amount as number,
	)
	const id = checkoutId('hpp_')
	const hpp = {
		id,
		reference: input.reference,
		status: 'Payment Pending',
		amount: input.amount,
		currency: String(input.currency).toUpperCase(),
		description: input.description ?? null,
		billing: input.billing,
		customer: isRecord(input.customer) ? input.customer : null,
		payment_type: input.payment_type ?? 'Regular',
		processing_channel_id: input.processing_channel_id,
		success_url: input.success_url,
		failure_url: input.failure_url,
		cancel_url: input.cancel_url,
		metadata: isRecord(input.metadata) ? input.metadata : {},
		amount_allocations: allocations,
		payment_id: null as string | null,
		created_on: isoNow(ctx),
		__mock: { completing: false },
	}
	await insertCheckoutObject(ctx, 'hpp', hpp)
	return {
		id,
		reference: hpp.reference,
		_links: hostedLinks(ctx, id),
	}
}

function hostedLinks(ctx: EmulatorContext, id: string) {
	return {
		self: { href: `${CHECKOUT_LINK_HOST}/hosted-payments/${id}` },
		redirect: { href: `${ctx.origin}/mock-payments/checkout-com/hpp/${id}` },
	}
}

export async function retrieveHostedPayment(ctx: EmulatorContext, id: string) {
	const row = await findCheckoutObject(ctx, id, 'hpp')
	if (!row) throw notFound()
	const hpp = publicObject(row.json)
	return {
		id: hpp.id,
		status: hpp.status,
		reference: hpp.reference,
		amount: hpp.amount,
		currency: hpp.currency,
		billing: hpp.billing,
		success_url: hpp.success_url,
		failure_url: hpp.failure_url,
		cancel_url: hpp.cancel_url,
		metadata: hpp.metadata,
		payment_id: hpp.payment_id,
		_links: hostedLinks(ctx, hpp.id),
	}
}

export type HostedSubmission = {
	number: string
	expiry: string
	cvc: string
	name?: string
	email?: string
	/** The 3DS password entered on the challenge page (headless: pass it up front). */
	password?: string
}

export type HostedResult =
	| {
			status: 'approved' | 'declined'
			redirectUrl: string
			sessionId: string
			paymentId: string
	  }
	| { status: 'requires_3ds'; attemptId: string }
	| { status: 'invalid'; field: 'number' | 'expiry' | 'cvc'; message: string }
	| { status: 'inactive' }

function withSession(url: string, sid: string) {
	const target = new URL(url)
	target.searchParams.set('cko-session-id', sid)
	return target.toString()
}

export async function submitHostedPayment(
	ctx: EmulatorContext,
	hppId: string,
	submission: HostedSubmission,
): Promise<HostedResult> {
	const hpp = await findCheckoutObject(ctx, hppId, 'hpp')
	if (!hpp || hpp.json.status !== 'Payment Pending')
		return { status: 'inactive' }
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
	const profile = checkoutProfileForDigits(valid.digits)
	const card: CardInfo = {
		profileKey: valid.digits,
		scheme: profile?.scheme ?? 'visa',
		last4: valid.digits.slice(-4),
		expMonth: valid.expMonth,
		expYear: valid.expYear,
	}
	const billing = {
		email: submission.email?.trim() || null,
		name: submission.name?.trim() || null,
	}
	if (profile?.threeDS && submission.password === undefined) {
		const attemptId = checkoutId('mockattempt_')
		await insertCheckoutObject(
			ctx,
			'attempt',
			{ id: attemptId, hpp: hppId, status: 'open', card, billing },
			{ parentId: hppId },
		)
		return { status: 'requires_3ds', attemptId }
	}
	return finishHostedAttempt(
		ctx,
		hppId,
		card,
		billing,
		profile,
		submission.password,
	)
}

export async function describeHostedPayment(
	ctx: EmulatorContext,
	hppId: string,
) {
	const row = await findCheckoutObject(ctx, hppId, 'hpp')
	if (!row) return null
	return {
		hpp: publicObject(row.json),
		active: row.json.status === 'Payment Pending',
	}
}

export async function describeHostedAttempt(
	ctx: EmulatorContext,
	attemptId: string,
) {
	const attempt = await findCheckoutObject(ctx, attemptId, 'attempt')
	if (!attempt) return null
	const hpp = await findCheckoutObject(ctx, String(attempt.json.hpp), 'hpp')
	if (!hpp) return null
	return {
		attempt: attempt.json,
		hpp: publicObject(hpp.json),
		open:
			attempt.json.status === 'open' && hpp.json.status === 'Payment Pending',
	}
}

export async function resolveHostedThreeDS(
	ctx: EmulatorContext,
	attemptId: string,
	password: string,
): Promise<HostedResult & { hppId?: string }> {
	const attempt = await findCheckoutObject(ctx, attemptId, 'attempt')
	if (!attempt) return { status: 'inactive' }
	const hppId = String(attempt.json.hpp)
	let claimed = false
	await mutateCheckoutObject(ctx, attemptId, (json) => {
		if (json.status !== 'open') return
		claimed = true
		json.status = 'used'
	})
	if (!claimed) return { status: 'inactive', hppId }
	const card = attempt.json.card as CardInfo
	const result = await finishHostedAttempt(
		ctx,
		hppId,
		card,
		attempt.json.billing as { email: string | null; name: string | null },
		checkoutProfileForDigits(card.profileKey),
		password,
	)
	return { ...result, hppId }
}

async function finishHostedAttempt(
	ctx: EmulatorContext,
	hppId: string,
	card: CardInfo,
	billing: { email: string | null; name: string | null },
	profile: CheckoutCardProfile | null,
	password: string | undefined,
): Promise<HostedResult> {
	let claimed = false
	const { row: claimedRow } = await mutateCheckoutObject(ctx, hppId, (json) => {
		if (json.status !== 'Payment Pending' || json.__mock?.completing) return
		claimed = true
		json.__mock = { ...json.__mock, completing: true }
	})
	if (!claimed) return { status: 'inactive' }
	const hpp = claimedRow.json
	let outcome: Outcome = { approved: true }
	if (!profile) {
		outcome = {
			approved: false,
			responseCode: '20014',
			summary:
				'Declined - Invalid Card Number (mock: use a Checkout.com test card)',
		}
	} else if (profile.threeDS && password !== CHECKOUT_3DS_PASSWORD) {
		outcome = {
			approved: false,
			responseCode: CHECKOUT_3DS_FAILED.responseCode,
			summary: CHECKOUT_3DS_FAILED.summary,
		}
	} else {
		const decline = checkoutAmountDecline(Number(hpp.amount))
		if (decline) {
			outcome = {
				approved: false,
				responseCode: decline.responseCode,
				summary: decline.summary,
			}
		}
	}
	const result = await recordPayment(ctx, {
		amount: Number(hpp.amount),
		currency: String(hpp.currency),
		reference: hpp.reference,
		metadata: hpp.metadata,
		paymentType: hpp.payment_type,
		merchantInitiated: false,
		previousPaymentId: null,
		card,
		sourceId: null,
		customer: {
			email: billing.email ?? hpp.customer?.email ?? null,
			name: billing.name,
		},
		allocations: hpp.amount_allocations,
		processingChannelId: hpp.processing_channel_id,
		outcome,
		capture: true,
		hostedPaymentId: hppId,
		storeSource: hpp.payment_type === 'Unscheduled',
	})
	const sessionId = checkoutId('sid_')
	await insertCheckoutObject(
		ctx,
		'session',
		{ id: sessionId, payment_id: result.payment.id, hpp: hppId },
		{ parentId: String(result.payment.id) },
	)
	await mutateCheckoutObject(ctx, hppId, (json) => {
		json.__mock = { ...json.__mock, completing: false }
		if (result.approved) {
			json.status = 'Payment Received'
			json.payment_id = result.payment.id
		}
	})
	await announce(ctx, result, hppId)
	return {
		status: result.approved ? 'approved' : 'declined',
		redirectUrl: withSession(
			String(result.approved ? hpp.success_url : hpp.failure_url),
			sessionId,
		),
		sessionId,
		paymentId: String(result.payment.id),
	}
}

// ------------------------------------------------------------------ payments

async function resolvePayment(
	ctx: EmulatorContext,
	id: string,
): Promise<MockObjectRow> {
	let paymentId = id
	if (id.startsWith('sid_')) {
		const session = await findCheckoutObject(ctx, id, 'session')
		if (!session) throw notFound()
		paymentId = String(session.json.payment_id)
	}
	const row = await findCheckoutObject(ctx, paymentId, 'payment')
	if (!row) throw notFound()
	return row
}

export async function retrievePayment(ctx: EmulatorContext, id: string) {
	const row = await resolvePayment(ctx, id)
	return publicObject(row.json)
}

export async function listPaymentActions(ctx: EmulatorContext, id: string) {
	const row = await resolvePayment(ctx, id)
	const actions = await ctx.store.listObjects('checkout', {
		type: 'action',
		parentId: row.id,
	})
	return actions
		.sort((a, b) => a.createdAt - b.createdAt)
		.map((action) => publicObject(action.json))
}

/** `POST /payments/search` with a `reference:'...'` query (the shape that matters). */
export async function searchPayments(ctx: EmulatorContext, body: unknown) {
	const input = isRecord(body) ? body : {}
	const query = typeof input.query === 'string' ? input.query : ''
	const reference = /reference\s*:\s*['"]([^'"]+)['"]/.exec(query)?.[1]
	const limit = Math.min(
		Number(input.limit) > 0 ? Number(input.limit) : 10,
		100,
	)
	const rows = await ctx.store.listObjects('checkout', {
		type: 'payment',
		limit: 500,
	})
	const matches = rows
		.filter((row) => !reference || row.json.reference === reference)
		.slice(0, limit)
		.map((row) => publicObject(row.json))
	return {
		data: matches,
		count: matches.length,
		total_count: matches.length,
		limit,
		_links: {},
	}
}

function amountEndingDecline(amount: number): Outcome {
	const decline = checkoutAmountDecline(amount)
	return decline
		? {
				approved: false,
				responseCode: decline.responseCode,
				summary: decline.summary,
			}
		: { approved: true }
}

/** `POST /payments`: merchant-initiated charge on a stored instrument (MIT). */
export async function createPayment(ctx: EmulatorContext, body: unknown) {
	const input = isRecord(body) ? body : {}
	const codes: string[] = []
	if (!Number.isInteger(input.amount) || (input.amount as number) <= 0)
		codes.push('amount_required')
	if (
		typeof input.currency !== 'string' ||
		!/^[A-Za-z]{3}$/.test(input.currency)
	)
		codes.push('currency_required')
	if (
		typeof input.processing_channel_id !== 'string' ||
		input.processing_channel_id === ''
	) {
		codes.push('processing_channel_id_required')
	}
	if (input.source?.type !== 'id' || typeof input.source?.id !== 'string') {
		codes.push('source_id_required')
	}
	if (codes.length > 0) throw invalidRequest(...codes)
	const merchantInitiated = input.merchant_initiated === true
	const paymentType =
		input.payment_type === 'Unscheduled' ? 'Unscheduled' : 'Regular'
	if (merchantInitiated) {
		if (paymentType !== 'Unscheduled')
			throw invalidRequest('payment_type_invalid')
		if (typeof input.previous_payment_id !== 'string')
			throw invalidRequest('previous_payment_id_required')
	}
	const source = await findCheckoutObject(ctx, input.source.id, 'source')
	if (!source) throw invalidRequest('source_id_invalid')
	if (merchantInitiated) {
		const previous = await findCheckoutObject(
			ctx,
			String(input.previous_payment_id),
			'payment',
		)
		const isCustomerInitiated =
			previous &&
			previous.json.approved === true &&
			previous.json.merchant_initiated !== true &&
			previous.json.payment_type === 'Unscheduled' &&
			previous.json.source?.id === source.id
		if (!isCustomerInitiated)
			throw invalidRequest('previous_payment_id_invalid')
	}
	const allocations = await normalizeAllocations(
		ctx,
		input.amount_allocations,
		input.amount as number,
	)
	const card = source.json.card as CardInfo
	const profile = checkoutProfileForDigits(card.profileKey)
	const outcome: Outcome =
		merchantInitiated && profile?.mitDeclines
			? {
					approved: false,
					responseCode: CHECKOUT_MIT_DECLINE.responseCode,
					summary: CHECKOUT_MIT_DECLINE.summary,
				}
			: amountEndingDecline(input.amount as number)
	const result = await recordPayment(ctx, {
		amount: input.amount as number,
		currency: String(input.currency).toUpperCase(),
		reference: typeof input.reference === 'string' ? input.reference : null,
		metadata: isRecord(input.metadata) ? input.metadata : {},
		paymentType,
		merchantInitiated,
		previousPaymentId:
			typeof input.previous_payment_id === 'string'
				? input.previous_payment_id
				: null,
		card,
		sourceId: source.id,
		customer: { id: source.json.customer_id },
		allocations,
		processingChannelId: String(input.processing_channel_id),
		outcome,
		capture: input.capture !== false,
		hostedPaymentId: null,
		storeSource: false,
	})
	await announce(ctx, result, null)
	return paymentResponse(result)
}

// ------------------------------------------------------------------- refunds

export async function createRefund(
	ctx: EmulatorContext,
	paymentRef: string,
	body: unknown,
) {
	const input = isRecord(body) ? body : {}
	const payment = await resolvePayment(ctx, paymentRef)
	if (payment.json.status === 'Declined' || !payment.json.approved) {
		throw new CheckoutApiError(403, 'refund_not_allowed', [
			'payment_not_refundable',
		])
	}
	const refundable = Number(payment.json.balances?.total_captured ?? 0)
	if (refundable <= 0)
		throw new CheckoutApiError(403, 'refund_not_allowed', [
			'payment_not_captured',
		])
	if (
		input.amount !== undefined &&
		(!Number.isInteger(input.amount) || (input.amount as number) <= 0)
	) {
		throw invalidRequest('amount_invalid')
	}
	let amount = 0
	let reversal: Array<{
		id: string
		amount: number
		commission: { amount: number }
	}> = []
	await mutateCheckoutObject(ctx, payment.id, (json) => {
		const left = refundable - Number(json.__mock.refundReserved)
		const requested = (input.amount as number | undefined) ?? left
		if (requested > left || left <= 0) {
			throw invalidRequest('refund_amount_exceeds_balance')
		}
		const final = requested === left
		amount = requested
		const reversedSoFar = json.__mock.reversed as Record<
			string,
			{ amount: number; commission: number }
		>
		reversal =
			input.amount_allocations === undefined
				? reverseAllocations(
						json.amount_allocations ?? [],
						reversedSoFar,
						requested,
						refundable,
						final,
					)
				: validateReversal(
						input.amount_allocations,
						json.amount_allocations ?? [],
						reversedSoFar,
						requested,
					)
		for (const entry of reversal) {
			const done = reversedSoFar[entry.id] ?? { amount: 0, commission: 0 }
			reversedSoFar[entry.id] = {
				amount: done.amount + entry.amount,
				commission: done.commission + entry.commission.amount,
			}
		}
		json.__mock.refundReserved = Number(json.__mock.refundReserved) + requested
	})
	const now = ctx.clock.now()
	const action = {
		id: checkoutId('act_'),
		type: 'Refund',
		processed_on: isoNow(ctx),
		amount,
		approved: null as boolean | null,
		response_code: null as string | null,
		response_summary: 'Pending',
		reference: typeof input.reference === 'string' ? input.reference : null,
		metadata: isRecord(input.metadata) ? input.metadata : {},
		amount_allocations: reversal,
		__mock: { forceDecline: false, settled: false },
	}
	await insertCheckoutObject(ctx, 'action', action, {
		parentId: payment.id,
		transitionAt: now + REFUND_SETTLES_AFTER_MS,
	})
	return {
		action_id: action.id,
		reference: action.reference,
		_links: {
			payment: { href: `${CHECKOUT_LINK_HOST}/payments/${payment.id}` },
		},
	}
}

/**
 * Settle a pending refund action. Approved by default; `forceDecline` (set by
 * the dev API before settlement) turns it into `payment_refund_declined`.
 */
export async function settleRefundAction(
	ctx: EmulatorContext,
	actionId: string,
	outcome?: 'approved' | 'declined',
) {
	const action = await findCheckoutObject(ctx, actionId, 'action')
	if (!action || action.json.type !== 'Refund') throw notFound()
	let settledNow = false
	const { row } = await mutateCheckoutObject(
		ctx,
		actionId,
		(json) => {
			if (json.__mock?.settled) return
			settledNow = true
			const approved =
				outcome === undefined
					? !json.__mock?.forceDecline
					: outcome === 'approved'
			json.__mock = { ...json.__mock, settled: true }
			json.approved = approved
			json.response_code = approved ? '10000' : '20051'
			json.response_summary = approved
				? 'Approved'
				: 'Declined - Insufficient Funds'
		},
		() => null,
	)
	if (!settledNow) return publicObject(row.json)
	const paymentRow = await findCheckoutObject(
		ctx,
		String(row.parentId),
		'payment',
	)
	if (!paymentRow) return publicObject(row.json)
	const approved = row.json.approved === true
	const { row: payment } = await mutateCheckoutObject(
		ctx,
		paymentRow.id,
		(json) => {
			const amount = Number(row.json.amount)
			if (approved) {
				json.balances.total_refunded += amount
				json.balances.available_to_refund -= amount
				json.status =
					json.balances.available_to_refund <= 0
						? 'Refunded'
						: 'Partially Refunded'
			} else {
				// Give the reservation back, including the allocation reversal.
				json.__mock.refundReserved = Math.max(
					0,
					json.__mock.refundReserved - amount,
				)
				for (const entry of (row.json.amount_allocations ?? []) as Array<{
					id: string
					amount: number
					commission: { amount: number }
				}>) {
					const done = json.__mock.reversed[entry.id]
					if (done) {
						done.amount = Math.max(0, done.amount - entry.amount)
						done.commission = Math.max(
							0,
							done.commission - entry.commission.amount,
						)
					}
				}
			}
		},
	)
	await emitCheckoutEvent(
		ctx,
		approved ? 'payment_refunded' : 'payment_refund_declined',
		paymentEventData(ctx, payment.json, row.json, {
			allocations: row.json.amount_allocations,
		}),
	)
	return publicObject(row.json)
}

export async function forceRefundDecline(
	ctx: EmulatorContext,
	actionId: string,
) {
	const action = await findCheckoutObject(ctx, actionId, 'action')
	if (!action || action.json.type !== 'Refund') throw notFound()
	await mutateCheckoutObject(ctx, actionId, (json) => {
		json.__mock = { ...json.__mock, forceDecline: true }
	})
}

export async function voidPayment(
	ctx: EmulatorContext,
	paymentRef: string,
	body: unknown,
) {
	const input = isRecord(body) ? body : {}
	const payment = await resolvePayment(ctx, paymentRef)
	if (payment.json.status !== 'Authorized') {
		throw new CheckoutApiError(403, 'void_not_allowed', [
			'payment_not_voidable',
		])
	}
	const action = {
		id: checkoutId('act_'),
		type: 'Void',
		processed_on: isoNow(ctx),
		amount: payment.json.amount,
		approved: true,
		response_code: '10000',
		response_summary: 'Approved',
		reference: typeof input.reference === 'string' ? input.reference : null,
		metadata: {},
	}
	await insertCheckoutObject(ctx, 'action', action, { parentId: payment.id })
	const { row } = await mutateCheckoutObject(ctx, payment.id, (json) => {
		json.status = 'Voided'
		json.balances.total_voided = json.amount
		json.balances.available_to_void = 0
	})
	await emitCheckoutEvent(
		ctx,
		'payment_voided',
		paymentEventData(ctx, row.json, action),
	)
	return {
		action_id: action.id,
		reference: action.reference,
		_links: {
			payment: { href: `${CHECKOUT_LINK_HOST}/payments/${payment.id}` },
		},
	}
}

// ------------------------------------------------------------ payment sessions

/**
 * `POST /payment-sessions` (Flow): faithful, which means no redirect link. An
 * integration that expects one fails here exactly as it would for real.
 */
export async function createPaymentSession(
	ctx: EmulatorContext,
	body: unknown,
) {
	const input = isRecord(body) ? body : {}
	const codes: string[] = []
	if (!Number.isInteger(input.amount) || (input.amount as number) <= 0)
		codes.push('amount_required')
	if (
		typeof input.currency !== 'string' ||
		!/^[A-Za-z]{3}$/.test(input.currency)
	)
		codes.push('currency_required')
	if (typeof input.billing?.address?.country !== 'string')
		codes.push('billing_address_country_required')
	if (typeof input.processing_channel_id !== 'string')
		codes.push('processing_channel_id_required')
	if (!isUrl(input.success_url)) codes.push('success_url_required')
	if (!isUrl(input.failure_url)) codes.push('failure_url_required')
	if (codes.length > 0) throw invalidRequest(...codes)
	await normalizeAllocations(
		ctx,
		input.amount_allocations,
		input.amount as number,
	)
	const id = `ps_${stripeId('', 24).toLowerCase()}`
	await insertCheckoutObject(ctx, 'payment_session', {
		id,
		amount: input.amount,
		currency: String(input.currency).toUpperCase(),
		reference: input.reference ?? null,
		created_on: isoNow(ctx),
	})
	return {
		id,
		payment_session_token: `pst_${stripeId('', 32)}`,
		payment_session_secret: `pss_${stripeId('', 32)}`,
		_links: { self: { href: `${CHECKOUT_LINK_HOST}/payment-sessions/${id}` } },
	}
}

// ----------------------------------------------------------------- dashboards

export async function dashboardSnapshot(ctx: EmulatorContext) {
	const [entities, payments] = await Promise.all([
		ctx.store.listObjects('checkout', { type: 'entity', limit: 200 }),
		ctx.store.listObjects('checkout', { type: 'payment', limit: 200 }),
	])
	return {
		entities: entities.map((row) => publicObject(row.json)),
		payments: payments.map((row) => publicObject(row.json)),
	}
}
