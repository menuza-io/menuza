/**
 * Payment provider abstraction types
 * This allows easy switching between different payment providers
 */

export interface TrialConfig {
	trialDays: number
	creditCardRequired: 'stripe' | 'manual'
}

export interface Product {
	id: string
	name: string
	description: string | null
	defaultPriceId?: string
}

export interface Price {
	id: string
	productId: string
	unitAmount: number | null
	interval: 'month' | 'year' | 'week' | 'day' | null | undefined
	trialPeriodDays: number | null | undefined
	currency: string
	tiers?: PriceTier[]
}

export interface PriceTier {
	up_to: number | null
	unit_amount: number | null
	flat_amount: number | null
}

export interface PlansAndPrices {
	plans: {
		base: Product | undefined
		plus: Product | undefined
	}
	prices: {
		base: {
			monthly: Price | undefined
			yearly: Price | undefined
		}
		plus: {
			monthly: Price | undefined
			yearly: Price | undefined
		}
	}
}

export interface Subscription {
	id: string
	status: 'active' | 'trialing' | 'canceled' | 'unpaid' | 'past_due' | 'paused'
	customerId: string
	productId: string
	priceId: string
	trialEnd?: Date | null
	currentPeriodEnd?: Date | null
	cancelAtPeriodEnd?: boolean
	quantity?: number
	items: SubscriptionItem[]
	/** When the subscription was created, in Unix seconds (Stripe's `created`). */
	created?: number
}

export interface SubscriptionItem {
	id: string
	priceId: string
	quantity?: number
}

export interface CheckoutSession {
	id: string
	url: string
	customerId?: string
	subscriptionId?: string
}

export interface CustomerPortalSession {
	id: string
	url: string
}

export interface Invoice {
	id: string
	number: string | null
	status: string | null
	amountPaid: number
	amountDue: number
	currency: string
	created: number
	dueDate: number | null
	hostedInvoiceUrl: string | null
	invoicePdf: string | null
	periodStart: number
	periodEnd: number
}

export interface CheckoutSessionOptions {
	priceId: string
	quantity: number
	successUrl: string
	cancelUrl: string
	customerId?: string
	clientReferenceId?: string
	allowPromotionCodes?: boolean
	trialPeriodDays?: number
	paymentMethodCollection?: 'always' | 'if_required'
	testClockId?: string
	/** Stored on the Stripe Checkout Session; used to bind checkout to an org. */
	metadata?: Record<string, string>
	/** Prevents duplicate sessions when checkout is triggered repeatedly. */
	idempotencyKey?: string
}

export interface CustomerPortalOptions {
	customerId: string
	returnUrl: string
	productId?: string
}

export interface SubscriptionUpdateOptions {
	subscriptionId: string
	priceId: string
	quantity?: number
	preserveTrialEnd?: boolean
	prorationBehavior?: 'create_prorations' | 'none' | 'always_invoice'
}

export interface WebhookEvent {
	id: string
	type: string
	data: any
}

/**
 * Payment Provider Interface
 * Implement this interface for each payment provider (Stripe, Polar, Lemon Squeezy, etc.)
 */
export interface PaymentProvider {
	// Product & Pricing
	getProducts(): Promise<Product[]>
	getPrices(): Promise<Price[]>
	getPlansAndPrices(): Promise<PlansAndPrices>

	// Checkout
	createCheckoutSession(
		options: CheckoutSessionOptions,
	): Promise<CheckoutSession>
	retrieveCheckoutSession(sessionId: string): Promise<CheckoutSession>

	// Subscriptions
	retrieveSubscription(subscriptionId: string): Promise<Subscription>
	listSubscriptions(customerId: string): Promise<Subscription[]>
	updateSubscription(options: SubscriptionUpdateOptions): Promise<Subscription>
	cancelSubscription(subscriptionId: string): Promise<Subscription>

	// Customer Portal
	createCustomerPortalSession(
		options: CustomerPortalOptions,
	): Promise<CustomerPortalSession>

	// Invoices
	listInvoices(customerId: string, limit?: number): Promise<Invoice[]>

	// Webhooks
	constructWebhookEvent(
		payload: string | Buffer,
		signature: string,
		secret: string,
	): Promise<WebhookEvent>

	// Test helpers (optional, for development)
	createTestClock?(): Promise<{ id: string; frozenTime: number }>
	createTestCustomer?(testClockId?: string): Promise<{ id: string }>
}

/**
 * Payment provider configuration
 */
export interface PaymentProviderConfig {
	provider: 'stripe' | 'polar' | 'lemon-squeezy'
	apiKey: string
	webhookSecret?: string
	apiVersion?: string
	organizationId?: string // Required for Polar
	server?: 'sandbox' | 'production' // Polar sandbox vs production API
}
