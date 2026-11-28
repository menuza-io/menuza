/**
 * Polar Payment Provider Implementation
 *
 * Note: Polar's SDK is more limited than Stripe. Some methods may not be fully supported
 * and will need to be called directly using the Polar client for advanced features.
 */

import { Polar } from '@polar-sh/sdk'
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks'
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
	type BillingIssue,
	type Invoice,
	type PayInvoiceResult,
	type WebhookEvent,
} from '../types'

export class PolarProvider implements PaymentProvider {
	private polar: Polar
	private organizationId?: string

	constructor(config: {
		apiKey: string
		organizationId?: string
		server?: 'sandbox' | 'production'
	}) {
		if (!config.apiKey) {
			throw new Error('Polar access token is required')
		}

		this.polar = new Polar({
			accessToken: config.apiKey,
			server: config.server,
		})

		this.organizationId = config.organizationId
	}

	/**
	 * Get the underlying Polar instance (for advanced usage)
	 */
	getClient(): Polar {
		return this.polar
	}

	/**
	 * Set the organization ID for subsequent API calls
	 */
	setOrganizationId(organizationId: string): void {
		this.organizationId = organizationId
	}

	private ensureOrganizationId(): string {
		if (!this.organizationId) {
			throw new Error(
				'Organization ID is required for this operation. Set it via setOrganizationId() or pass it in the constructor.',
			)
		}
		return this.organizationId
	}

	async getProducts(): Promise<Product[]> {
		try {
			const orgId = this.ensureOrganizationId()

			const productsIterator = await this.polar.products.list({
				organizationId: orgId,
				isArchived: false,
				limit: 100,
			})

			const products: Product[] = []
			for await (const page of productsIterator) {
				const result = page.result
				if (result.items) {
					for (const product of result.items) {
						const firstPrice = product.prices?.[0]
						const defaultPriceId =
							firstPrice && 'id' in firstPrice ? firstPrice.id : undefined
						products.push({
							id: product.id,
							name: product.name,
							description: product.description || null,
							defaultPriceId,
						})
					}
				}
			}

			return products
		} catch (error: any) {
			console.error('PolarProvider: Failed to fetch products:', error)
			throw new Error(
				`Failed to fetch Polar products: ${error?.message || error}`,
			)
		}
	}

	async getPrices(): Promise<Price[]> {
		try {
			const orgId = this.ensureOrganizationId()

			const productsIterator = await this.polar.products.list({
				organizationId: orgId,
				isArchived: false,
				limit: 100,
			})

			const prices: Price[] = []

			for await (const page of productsIterator) {
				const result = page.result
				if (result.items) {
					for (const product of result.items) {
						if (product.prices && product.prices.length > 0) {
							for (const price of product.prices) {
								if (!('id' in price)) continue

								let interval: 'month' | 'year' | 'week' | 'day' | null = null
								if (
									'type' in price &&
									price.type === 'recurring' &&
									'recurringInterval' in price &&
									price.recurringInterval
								) {
									const recInt = price.recurringInterval
									if (recInt === 'month') {
										interval = 'month'
									} else if (recInt === 'year') {
										interval = 'year'
									}
								}

								const unitAmount =
									'priceAmount' in price ? (price.priceAmount as number) : null
								const currency =
									'priceCurrency' in price
										? ((price.priceCurrency as string)?.toLowerCase() ?? 'usd')
										: 'usd'

								prices.push({
									id: price.id,
									productId: product.id,
									unitAmount,
									interval,
									trialPeriodDays: null,
									currency,
								})
							}
						}
					}
				}
			}

			return prices
		} catch (error: any) {
			console.error('PolarProvider: Failed to fetch prices:', error)
			throw new Error(
				`Failed to fetch Polar prices: ${error?.message || error}`,
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
		try {
			const checkoutData: any = {
				productPriceId: options.priceId,
				successUrl: options.successUrl,
			}

			const checkout = await this.polar.checkouts.create(checkoutData)

			return {
				id: checkout.id,
				url: checkout.url || '',
				customerId: undefined, // Polar checkouts don't include customer ID in response
				subscriptionId: undefined,
			}
		} catch (error: any) {
			console.error('PolarProvider: Failed to create checkout session:', error)
			throw new Error(
				`Failed to create Polar checkout: ${error?.message || error}`,
			)
		}
	}

	async retrieveCheckoutSession(sessionId: string): Promise<CheckoutSession> {
		try {
			const checkout = await this.polar.checkouts.get({ id: sessionId })

			return {
				id: checkout.id,
				url: checkout.url || '',
				customerId: undefined, // Polar checkouts don't include customer ID in response
				subscriptionId: undefined, // Polar checkouts don't include subscription ID in response
			}
		} catch (error: any) {
			console.error(
				'PolarProvider: Failed to retrieve checkout session:',
				error,
			)
			throw new Error(
				`Failed to retrieve Polar checkout: ${error?.message || error}`,
			)
		}
	}

	async retrieveSubscription(_subscriptionId: string): Promise<Subscription> {
		// Polar SDK doesn't have a direct get subscription by ID method
		// We need to list subscriptions and find the one we want
		throw new Error(
			'Polar SDK does not support retrieving individual subscriptions by ID directly. Use listSubscriptions() instead or access the Polar client directly.',
		)
	}

	async listSubscriptions(customerId: string): Promise<Subscription[]> {
		try {
			const orgId = this.ensureOrganizationId()

			const subscriptionsIterator = await this.polar.subscriptions.list({
				organizationId: orgId,
				limit: 100,
			})

			const subscriptions: Subscription[] = []

			for await (const page of subscriptionsIterator) {
				const result = page.result
				if (result.items) {
					for (const sub of result.items) {
						if (customerId && sub.customerId !== customerId) {
							continue
						}

						let status: Subscription['status'] = 'active'
						if (sub.status === 'active') status = 'active'
						else if (sub.status === 'canceled') status = 'canceled'
						else if (sub.status === 'incomplete') status = 'unpaid'
						else if (sub.status === 'incomplete_expired') status = 'unpaid'
						else if (sub.status === 'past_due') status = 'past_due'
						else if (sub.status === 'unpaid') status = 'unpaid'

						const firstPrice = sub.prices?.[0]
						const priceId =
							firstPrice && 'id' in firstPrice ? firstPrice.id : ''

						subscriptions.push({
							id: sub.id,
							status,
							customerId: sub.customerId || '',
							productId: sub.productId,
							priceId,
							trialEnd: sub.trialEnd ? new Date(sub.trialEnd) : null,
							currentPeriodEnd: sub.currentPeriodEnd
								? new Date(sub.currentPeriodEnd)
								: undefined,
							cancelAtPeriodEnd: sub.cancelAtPeriodEnd || false,
							quantity: 1,
							items: [
								{
									id: sub.id,
									priceId,
									quantity: 1,
								},
							],
						})
					}
				}
			}

			return subscriptions
		} catch (error: any) {
			console.error('PolarProvider: Failed to list subscriptions:', error)
			throw new Error(
				`Failed to list Polar subscriptions: ${error?.message || error}`,
			)
		}
	}

	async updateSubscription(
		_options: SubscriptionUpdateOptions,
	): Promise<Subscription> {
		// Polar SDK doesn't expose subscription update methods
		throw new Error(
			'Polar SDK does not support updating subscriptions through the standard API. Use the Polar client directly for advanced subscription management.',
		)
	}

	async cancelSubscription(_subscriptionId: string): Promise<Subscription> {
		// Polar SDK doesn't expose subscription cancel methods
		throw new Error(
			'Polar SDK does not support canceling subscriptions through the standard API. Use the Polar client directly for subscription management.',
		)
	}

	async createCustomerPortalSession(
		_options: CustomerPortalOptions,
	): Promise<CustomerPortalSession> {
		// Polar doesn't have a direct customer portal API like Stripe
		// Return a placeholder or throw an error
		throw new Error(
			'Polar does not have a customer portal session API like Stripe. Direct customers to your custom billing management page.',
		)
	}

	/** Polar has no invoice retry: nothing to show or pay (#237). */
	async getBillingIssue(): Promise<BillingIssue> {
		return { invoice: null, attempts: [] }
	}

	async payInvoice(): Promise<PayInvoiceResult> {
		throw new Error('Retrying a payment is not supported by this provider')
	}

	async listInvoices(customerId: string, limit = 20): Promise<Invoice[]> {
		try {
			const orgId = this.ensureOrganizationId()

			const ordersIterator = await this.polar.orders.list({
				organizationId: orgId,
				limit,
			})

			const invoices: Invoice[] = []

			for await (const page of ordersIterator) {
				const result = page.result
				if (result.items) {
					for (const order of result.items) {
						if (customerId && order.customerId !== customerId) {
							continue
						}

						const createdTimestamp = order.createdAt
							? new Date(order.createdAt).getTime() / 1000
							: 0

						invoices.push({
							id: order.id,
							number: order.invoiceNumber || order.id,
							status: order.paid ? 'paid' : null,
							amountPaid: order.paid ? order.totalAmount : 0,
							amountDue: order.dueAmount || 0,
							currency: order.currency?.toLowerCase() || 'usd',
							created: createdTimestamp,
							dueDate: null,
							hostedInvoiceUrl: null,
							invoicePdf: null,
							periodStart: createdTimestamp,
							periodEnd: createdTimestamp,
						})
					}
				}
			}

			return invoices
		} catch (error: any) {
			console.error('PolarProvider: Error fetching invoices:', error)
			return []
		}
	}

	async constructWebhookEvent(
		payload: string | Buffer,
		signature: string,
		secret: string,
	): Promise<WebhookEvent> {
		try {
			const payloadString =
				typeof payload === 'string' ? payload : payload.toString('utf8')

			const headers: Record<string, string> = {
				'webhook-signature': signature,
			}

			const event = validateEvent(payloadString, headers, secret)

			return {
				id: (event as { id?: string }).id || '',
				type: (event as { type?: string }).type || '',
				data: (event as { data?: unknown }).data || event,
			}
		} catch (error: unknown) {
			if (error instanceof WebhookVerificationError) {
				throw new Error(
					`Polar webhook signature verification failed: ${error.message}`,
				)
			}
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(`Failed to parse Polar webhook: ${message}`)
		}
	}
}
