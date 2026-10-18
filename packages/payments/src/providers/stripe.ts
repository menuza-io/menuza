/**
 * Stripe Payment Provider Implementation
 */

import Stripe from 'stripe'
import {
	type PaymentProvider,
	type Product,
	type Price,
	type PlansAndPrices,
	type CheckoutSession,
	type CheckoutSessionOptions,
	type Subscription,
	type SubscriptionUpdateOptions,
	type CustomerPortalSession,
	type CustomerPortalOptions,
	type Invoice,
	type WebhookEvent,
} from '../types'

export class StripeProvider implements PaymentProvider {
	private stripe: Stripe

	constructor(config: {
		apiKey: string
		apiVersion?: string
		/** Override the transport (the local payment mock). */
		httpClient?: Stripe.HttpClient
	}) {
		if (!config.apiKey) {
			throw new Error('Stripe API key is required')
		}

		if (!config.apiKey.startsWith('sk_')) {
			throw new Error(
				'Stripe API key does not appear to be valid (should start with sk_)',
			)
		}

		this.stripe = new Stripe(config.apiKey, {
			apiVersion:
				(config.apiVersion as Stripe.LatestApiVersion) || '2025-08-27.basil',
			httpClient: config.httpClient ?? Stripe.createFetchHttpClient(),
		})
	}

	/**
	 * Get the underlying Stripe instance (for advanced usage)
	 */
	getClient(): Stripe {
		return this.stripe
	}

	async getProducts(): Promise<Product[]> {
		try {
			const products = await this.stripe.products.list({
				active: true,
				limit: 10,
			})

			return products.data.map((product) => ({
				id: product.id,
				name: product.name,
				description: product.description,
				defaultPriceId: product.default_price as string | undefined,
			}))
		} catch (error: any) {
			console.error('StripeProvider: Failed to fetch products:', error)
			throw new Error(
				`Failed to fetch Stripe products: ${error?.message || error}`,
			)
		}
	}

	async getPrices(): Promise<Price[]> {
		try {
			const prices = await this.stripe.prices.list({
				active: true,
				limit: 200,
				type: 'recurring',
				expand: ['data.tiers'],
			})

			return prices.data.map((price) => ({
				id: price.id,
				productId:
					typeof price.product === 'string' ? price.product : price.product.id,
				unitAmount: price.unit_amount,
				interval: price.recurring?.interval,
				trialPeriodDays: price.recurring?.trial_period_days,
				currency: price.currency,
				tiers: price.tiers?.map((tier) => ({
					up_to: tier.up_to,
					unit_amount: tier.unit_amount,
					flat_amount: tier.flat_amount,
				})),
			}))
		} catch (error: any) {
			console.error('StripeProvider: Failed to fetch prices:', error)
			throw new Error(
				`Failed to fetch Stripe prices: ${error?.message || error}`,
			)
		}
	}

	async getPlansAndPrices(): Promise<PlansAndPrices> {
		const products = await this.getProducts()
		const prices = await this.getPrices()

		const basePlan = products.find((product) => product.name === 'Base')
		const plusPlan = products.find((product) => product.name === 'Plus')

		// Filter for monthly and yearly prices
		const monthlyPrices = prices.filter(
			(price) => price.interval === 'month' && price.currency === 'usd',
		)
		const yearlyPrices = prices.filter(
			(price) => price.interval === 'year' && price.currency === 'usd',
		)

		// Find prices for each plan and interval
		const basePriceMonthly = monthlyPrices.find(
			(price) => price.productId === basePlan?.id,
		)
		const basePriceYearly = yearlyPrices.find(
			(price) => price.productId === basePlan?.id,
		)
		const plusPriceMonthly = monthlyPrices.find(
			(price) => price.productId === plusPlan?.id,
		)
		const plusPriceYearly = yearlyPrices.find(
			(price) => price.productId === plusPlan?.id,
		)

		return {
			plans: { base: basePlan, plus: plusPlan },
			prices: {
				base: {
					monthly: basePriceMonthly,
					yearly: basePriceYearly,
				},
				plus: {
					monthly: plusPriceMonthly,
					yearly: plusPriceYearly,
				},
			},
		}
	}

	async createCheckoutSession(
		options: CheckoutSessionOptions,
	): Promise<CheckoutSession> {
		const sessionData: Stripe.Checkout.SessionCreateParams = {
			payment_method_types: ['card'],
			line_items: [
				{
					price: options.priceId,
					quantity: options.quantity,
				},
			],
			mode: 'subscription',
			success_url: options.successUrl,
			cancel_url: options.cancelUrl,
			customer: options.customerId,
			client_reference_id: options.clientReferenceId,
			allow_promotion_codes: options.allowPromotionCodes,
			payment_method_collection: options.paymentMethodCollection,
			metadata: options.metadata,
		}

		if (options.trialPeriodDays !== undefined) {
			sessionData.subscription_data = {
				trial_period_days: options.trialPeriodDays,
			}
		}

		const requestOptions = options.idempotencyKey
			? { idempotencyKey: options.idempotencyKey }
			: undefined

		const session = await this.stripe.checkout.sessions.create(
			sessionData,
			requestOptions,
		)

		return {
			id: session.id,
			url: session.url || '',
			customerId: session.customer as string | undefined,
			subscriptionId: session.subscription as string | undefined,
		}
	}

	async retrieveCheckoutSession(sessionId: string): Promise<CheckoutSession> {
		const session = await this.stripe.checkout.sessions.retrieve(sessionId)

		return {
			id: session.id,
			url: session.url || '',
			customerId: session.customer as string | undefined,
			subscriptionId: session.subscription as string | undefined,
		}
	}

	async retrieveSubscription(subscriptionId: string): Promise<Subscription> {
		const sub = await this.stripe.subscriptions.retrieve(subscriptionId)

		return {
			id: sub.id,
			status: sub.status as any,
			customerId: sub.customer as string,
			productId: (sub.items.data[0]?.plan.product as string) || '',
			priceId: sub.items.data[0]?.price.id || '',
			trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
			currentPeriodEnd: (sub as any).current_period_end
				? new Date((sub as any).current_period_end * 1000)
				: undefined,
			cancelAtPeriodEnd: (sub as any).cancel_at_period_end,
			quantity: sub.items.data[0]?.quantity,
			items: sub.items.data.map((item) => ({
				id: item.id,
				priceId: item.price.id,
				quantity: item.quantity,
			})),
		}
	}

	async listSubscriptions(customerId: string): Promise<Subscription[]> {
		const subscriptions = await this.stripe.subscriptions.list({
			customer: customerId,
			status: 'all',
		})

		return subscriptions.data.map((sub) => ({
			id: sub.id,
			status: sub.status as any,
			customerId: sub.customer as string,
			productId: (sub.items.data[0]?.plan.product as string) || '',
			priceId: sub.items.data[0]?.price.id || '',
			trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
			currentPeriodEnd: (sub as any).current_period_end
				? new Date((sub as any).current_period_end * 1000)
				: undefined,
			cancelAtPeriodEnd: (sub as any).cancel_at_period_end,
			quantity: sub.items.data[0]?.quantity,
			items: sub.items.data.map((item) => ({
				id: item.id,
				priceId: item.price.id,
				quantity: item.quantity,
			})),
		}))
	}

	async updateSubscription(
		options: SubscriptionUpdateOptions,
	): Promise<Subscription> {
		const subscription = await this.stripe.subscriptions.retrieve(
			options.subscriptionId,
		)

		const updateParams: Stripe.SubscriptionUpdateParams = {
			items: [
				{
					id: subscription.items.data[0]?.id,
					price: options.priceId,
					quantity: options.quantity,
				},
			],
			proration_behavior: options.prorationBehavior || 'create_prorations',
		}

		// Preserve trial period if requested and subscription is currently trialing
		if (
			options.preserveTrialEnd &&
			subscription.status === 'trialing' &&
			subscription.trial_end
		) {
			updateParams.trial_end = subscription.trial_end
		}

		const updatedSub = await this.stripe.subscriptions.update(
			options.subscriptionId,
			updateParams,
		)

		return {
			id: updatedSub.id,
			status: updatedSub.status as any,
			customerId: updatedSub.customer as string,
			productId: (updatedSub.items.data[0]?.plan.product as string) || '',
			priceId: updatedSub.items.data[0]?.price.id || '',
			trialEnd: updatedSub.trial_end
				? new Date(updatedSub.trial_end * 1000)
				: null,
			currentPeriodEnd: (updatedSub as any).current_period_end
				? new Date((updatedSub as any).current_period_end * 1000)
				: undefined,
			cancelAtPeriodEnd: (updatedSub as any).cancel_at_period_end,
			quantity: updatedSub.items.data[0]?.quantity,
			items: updatedSub.items.data.map((item) => ({
				id: item.id,
				priceId: item.price.id,
				quantity: item.quantity,
			})),
		}
	}

	async cancelSubscription(subscriptionId: string): Promise<Subscription> {
		const sub = await this.stripe.subscriptions.cancel(subscriptionId)

		return {
			id: sub.id,
			status: sub.status as any,
			customerId: sub.customer as string,
			productId: (sub.items.data[0]?.plan.product as string) || '',
			priceId: sub.items.data[0]?.price.id || '',
			trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
			currentPeriodEnd: (sub as any).current_period_end
				? new Date((sub as any).current_period_end * 1000)
				: undefined,
			cancelAtPeriodEnd: (sub as any).cancel_at_period_end,
			quantity: sub.items.data[0]?.quantity,
			items: sub.items.data.map((item) => ({
				id: item.id,
				priceId: item.price.id,
				quantity: item.quantity,
			})),
		}
	}

	async createCustomerPortalSession(
		options: CustomerPortalOptions,
	): Promise<CustomerPortalSession> {
		let configuration: Stripe.BillingPortal.Configuration | undefined

		const configurations = await this.stripe.billingPortal.configurations.list()

		if (configurations.data.length > 0) {
			configuration = configurations.data[0]
		} else if (options.productId) {
			// Create a new configuration if none exists
			const product = await this.stripe.products.retrieve(options.productId)
			if (!product.active) {
				throw new Error('Product is not active in Stripe')
			}

			const prices = await this.stripe.prices.list({
				product: product.id,
				active: true,
			})
			if (prices.data.length === 0) {
				throw new Error('No active prices found for the product')
			}

			configuration = await this.stripe.billingPortal.configurations.create({
				business_profile: {
					headline: 'Manage your subscription',
				},
				features: {
					payment_method_update: {
						enabled: true,
					},
					subscription_update: {
						enabled: true,
						default_allowed_updates: ['price', 'quantity', 'promotion_code'],
						proration_behavior: 'create_prorations',
						products: [
							{
								product: product.id,
								prices: prices.data.map((price) => price.id),
							},
						],
					},
					subscription_cancel: {
						enabled: true,
						mode: 'at_period_end',
						cancellation_reason: {
							enabled: true,
							options: [
								'too_expensive',
								'missing_features',
								'switched_service',
								'unused',
								'other',
							],
						},
					},
				},
			})
		}

		const session = await this.stripe.billingPortal.sessions.create({
			customer: options.customerId,
			return_url: options.returnUrl,
			configuration: configuration?.id,
		})

		return {
			id: session.id,
			url: session.url,
		}
	}

	async listInvoices(customerId: string, limit = 20): Promise<Invoice[]> {
		try {
			const invoices = await this.stripe.invoices.list({
				customer: customerId,
				limit,
			})

			return invoices.data.map((invoice) => ({
				id: invoice.id || '',
				number: invoice.number,
				status: invoice.status,
				amountPaid: invoice.amount_paid,
				amountDue: invoice.amount_due,
				currency: invoice.currency,
				created: invoice.created,
				dueDate: invoice.due_date,
				hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
				invoicePdf: invoice.invoice_pdf ?? null,
				periodStart: invoice.period_start,
				periodEnd: invoice.period_end,
			}))
		} catch (error) {
			console.error('StripeProvider: Error fetching invoices:', error)
			return []
		}
	}

	async constructWebhookEvent(
		payload: string | Buffer,
		signature: string,
		secret: string,
	): Promise<WebhookEvent> {
		const event = this.stripe.webhooks.constructEvent(
			payload,
			signature,
			secret,
		)

		return {
			id: event.id,
			type: event.type,
			data: event.data.object,
		}
	}

	// Test helpers
	async createTestClock(): Promise<{ id: string; frozenTime: number }> {
		const testClock = await this.stripe.testHelpers.testClocks.create({
			frozen_time: Math.floor(new Date().getTime() / 1000),
		})

		return {
			id: testClock.id,
			frozenTime: testClock.frozen_time,
		}
	}

	async createTestCustomer(testClockId?: string): Promise<{ id: string }> {
		const customer = await this.stripe.customers.create({
			test_clock: testClockId,
		})

		return {
			id: customer.id,
		}
	}
}
