/**
 * Stripe Connect helpers for tenant site commerce (US marketplace).
 */

import type Stripe from 'stripe'
import { calculateShopFees } from './shop-fees'

export { SHOP_PLATFORM_FEE_PERCENT, calculateShopFees } from './shop-fees'

export type ConnectAccountStatus = {
	accountId: string
	chargesEnabled: boolean
	payoutsEnabled: boolean
	detailsSubmitted: boolean
}

export async function createConnectExpressAccount(
	stripe: Stripe,
	options: {
		organizationId: string
		organizationName: string
		organizationEmail?: string | null
	},
): Promise<Stripe.Account> {
	return stripe.accounts.create({
		type: 'express',
		country: 'US',
		email: options.organizationEmail || undefined,
		capabilities: {
			card_payments: { requested: true },
			transfers: { requested: true },
		},
		business_type: 'company',
		metadata: {
			organizationId: options.organizationId,
			organizationName: options.organizationName,
		},
	})
}

export async function createConnectAccountLink(
	stripe: Stripe,
	options: {
		accountId: string
		refreshUrl: string
		returnUrl: string
	},
): Promise<Stripe.AccountLink> {
	return stripe.accountLinks.create({
		account: options.accountId,
		refresh_url: options.refreshUrl,
		return_url: options.returnUrl,
		type: 'account_onboarding',
	})
}

export async function createConnectLoginLink(
	stripe: Stripe,
	accountId: string,
): Promise<Stripe.LoginLink> {
	return stripe.accounts.createLoginLink(accountId)
}

export async function retrieveConnectAccountStatus(
	stripe: Stripe,
	accountId: string,
): Promise<ConnectAccountStatus> {
	const account = await stripe.accounts.retrieve(accountId)
	return {
		accountId: account.id,
		chargesEnabled: Boolean(account.charges_enabled),
		payoutsEnabled: Boolean(account.payouts_enabled),
		detailsSubmitted: Boolean(account.details_submitted),
	}
}

export async function createShopCheckoutSession(
	stripe: Stripe,
	options: {
		connectedAccountId: string
		productName: string
		productDescription?: string | null
		amountCents: number
		currency?: string
		successUrl: string
		cancelUrl: string
		metadata: Record<string, string>
		customerEmail?: string | null
		/**
		 * Optional session expiry. Stripe enforces a minimum of 30 minutes from
		 * creation; callers must not pass anything sooner (pass null/undefined to
		 * keep the provider default).
		 */
		expiresAt?: Date | null
		/** Optional deterministic idempotency key for retried creates. */
		idempotencyKey?: string | null
	},
): Promise<Stripe.Checkout.Session> {
	const { platformFeeCents } = calculateShopFees(options.amountCents)

	return stripe.checkout.sessions.create(
		{
			mode: 'payment',
			line_items: [
				{
					price_data: {
						currency: options.currency || 'usd',
						product_data: {
							name: options.productName,
							description: options.productDescription || undefined,
						},
						unit_amount: options.amountCents,
					},
					quantity: 1,
				},
			],
			payment_intent_data: {
				application_fee_amount: platformFeeCents,
				transfer_data: {
					destination: options.connectedAccountId,
				},
				metadata: options.metadata,
			},
			success_url: options.successUrl,
			cancel_url: options.cancelUrl,
			metadata: options.metadata,
			customer_email: options.customerEmail || undefined,
			...(options.expiresAt
				? { expires_at: Math.floor(options.expiresAt.getTime() / 1000) }
				: {}),
		},
		options.idempotencyKey
			? { idempotencyKey: options.idempotencyKey }
			: undefined,
	)
}

/**
 * Expire an open Stripe Checkout session. Used to close a session that could
 * not be bound to its regional order so it can never be paid orphaned.
 */
export async function expireShopCheckoutSession(
	stripe: Stripe,
	sessionId: string,
): Promise<Stripe.Checkout.Session> {
	return stripe.checkout.sessions.expire(sessionId)
}

export async function createShopPaymentIntent(
	stripe: Stripe,
	options: {
		connectedAccountId: string
		amountCents: number
		currency?: string
		metadata: Record<string, string>
		stripeCustomerId?: string | null
		setupFutureUsage?: 'off_session' | 'on_session'
	},
): Promise<Stripe.PaymentIntent> {
	const { platformFeeCents } = calculateShopFees(options.amountCents)

	return stripe.paymentIntents.create({
		amount: options.amountCents,
		currency: options.currency || 'usd',
		payment_method_types: ['card'],
		application_fee_amount: platformFeeCents,
		transfer_data: {
			destination: options.connectedAccountId,
		},
		metadata: options.metadata,
		customer: options.stripeCustomerId || undefined,
		setup_future_usage: options.setupFutureUsage,
	})
}
