import {
	STRIPE_PAYMENT_METHOD_TOKENS,
	type StripeCardProfile,
	STRIPE_CARD_PROFILES,
} from '../cards'
import { type EmulatorContext } from '../context'
import { stripeId } from '../ids'
import { type Json } from '../util'
import {
	cardError,
	invalidRequest,
	missingParam,
	noSuchResource,
} from './errors'
import { metadataParam, rejectUnknownParams, ANY, stringParam } from './params'
import {
	findStripeObject,
	insertStripeObject,
	listEnvelope,
	mutateStripeObject,
	publicObject,
	requireStripeObject,
	seconds,
} from './state'

const CUSTOMER_PARAMS = {
	name: true,
	email: true,
	phone: true,
	description: true,
	metadata: ANY,
} as const

export async function createCustomer(ctx: EmulatorContext, params: Json) {
	rejectUnknownParams(params, CUSTOMER_PARAMS)
	const customer = {
		id: stripeId('cus_', 14),
		object: 'customer',
		created: seconds(ctx.clock.now()),
		livemode: false,
		name: stringParam(params.name, 'name') ?? null,
		email: stringParam(params.email, 'email') ?? null,
		phone: stringParam(params.phone, 'phone') ?? null,
		description: stringParam(params.description, 'description') ?? null,
		metadata: metadataParam(params.metadata),
		invoice_settings: { default_payment_method: null },
		default_source: null,
	}
	await insertStripeObject(ctx, 'customer', customer)
	return customer
}

export async function retrieveCustomer(ctx: EmulatorContext, id: string) {
	const row = await requireStripeObject(ctx, id, 'customer', 'customer')
	return publicObject(row.json)
}

export async function listCustomerPaymentMethods(
	ctx: EmulatorContext,
	customerId: string,
) {
	await requireStripeObject(ctx, customerId, 'customer', 'customer')
	const rows = await ctx.store.listObjects('stripe', { type: 'payment_method' })
	return listEnvelope(
		rows
			.filter((row) => row.json.customer === customerId)
			.map((row) => publicObject(row.json)),
		`/v1/customers/${customerId}/payment_methods`,
	)
}

type CardDetails = {
	profile: StripeCardProfile
	last4: string
	expMonth: number
	expYear: number
}

/** Store brand, last4, expiry and the profile key: never the card number. */
export async function createPaymentMethodFromCard(
	ctx: EmulatorContext,
	card: CardDetails,
	billing: {
		email?: string | null
		name?: string | null
		postalCode?: string | null
	} = {},
) {
	const method = {
		id: stripeId('pm_', 24),
		object: 'payment_method',
		type: 'card',
		created: seconds(ctx.clock.now()),
		livemode: false,
		customer: null as string | null,
		billing_details: {
			email: billing.email ?? null,
			name: billing.name ?? null,
			phone: null,
			address: {
				city: null,
				country: null,
				line1: null,
				line2: null,
				postal_code: billing.postalCode ?? null,
				state: null,
			},
		},
		card: {
			brand: card.profile.brand,
			last4: card.last4,
			exp_month: card.expMonth,
			exp_year: card.expYear,
			funding: 'credit',
			country: 'US',
			fingerprint: `fp_${card.profile.key.slice(-6)}`,
			checks: { cvc_check: 'pass', address_postal_code_check: 'pass' },
			three_d_secure_usage: { supported: true },
		},
		metadata: {},
		__mock: { profile: card.profile.key },
	}
	await insertStripeObject(ctx, 'payment_method', method)
	return method
}

export function profileOfPaymentMethod(json: Json): StripeCardProfile {
	const key = String(json.__mock?.profile ?? '4242424242424242')
	return STRIPE_CARD_PROFILES[key] ?? STRIPE_CARD_PROFILES['4242424242424242']!
}

/**
 * Resolve a PaymentMethod id. Server-side test tokens (`pm_card_visa`, ...)
 * materialize a fresh PaymentMethod, like Stripe's test mode does.
 */
export async function resolvePaymentMethod(
	ctx: EmulatorContext,
	idOrToken: string,
	param = 'payment_method',
) {
	const token = STRIPE_PAYMENT_METHOD_TOKENS[idOrToken]
	if (token) {
		const profile = STRIPE_CARD_PROFILES[token]!
		const created = await createPaymentMethodFromCard(ctx, {
			profile,
			last4: /^\d+$/.test(token) ? token.slice(-4) : '9995',
			expMonth: 12,
			expYear: new Date(ctx.clock.now()).getUTCFullYear() + 3,
		})
		const row = await findStripeObject(ctx, created.id, 'payment_method')
		return row!
	}
	const row = await findStripeObject(ctx, idOrToken, 'payment_method')
	if (!row) throw noSuchResource('PaymentMethod', idOrToken, param)
	return row
}

export async function retrievePaymentMethod(ctx: EmulatorContext, id: string) {
	const row = await resolvePaymentMethod(ctx, id, 'payment_method')
	return publicObject(row.json)
}

/** Attach without request validation (hosted checkout, which owns both ids). */
export async function attachPaymentMethodRaw(
	ctx: EmulatorContext,
	paymentMethodId: string,
	customerId: string,
) {
	await mutateStripeObject(ctx, paymentMethodId, (json) => {
		json.customer = customerId
	})
}

export async function attachPaymentMethod(
	ctx: EmulatorContext,
	idOrToken: string,
	params: Json,
) {
	rejectUnknownParams(params, { customer: true })
	const customerId = stringParam(params.customer, 'customer')
	if (!customerId) throw missingParam('customer')
	await requireStripeObject(ctx, customerId, 'customer', 'customer', 'customer')
	const row = await resolvePaymentMethod(ctx, idOrToken)
	const profile = profileOfPaymentMethod(row.json)
	const current = row.json.customer as string | null
	if (current && current !== customerId) {
		throw invalidRequest(
			'The payment method you provided has already been attached to a customer.',
			{ code: 'payment_method_unexpected_state', param: 'payment_method' },
		)
	}
	if (current === customerId) {
		throw invalidRequest(
			'The payment method you provided has already been attached to this customer.',
			{ code: 'resource_already_exists', param: 'payment_method' },
		)
	}
	if (profile.setupDecline) {
		throw cardError(profile.setupDecline.message, {
			code: profile.setupDecline.code,
			declineCode: profile.setupDecline.declineCode,
			param: 'payment_method',
		})
	}
	const { row: updated } = await mutateStripeObject(ctx, row.id, (json) => {
		json.customer = customerId
	})
	return publicObject(updated.json)
}
