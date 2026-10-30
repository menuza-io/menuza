/**
 * Unit tests for Stripe payment provider
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StripeProvider } from '../../src/providers/stripe'
import { sanitizeStripeErrorMessage } from '../../src/sanitize-stripe-error.js'

// Mock Stripe SDK
vi.mock('stripe', () => {
	const mockStripe = {
		products: {
			list: vi.fn(),
			retrieve: vi.fn(),
		},
		prices: {
			list: vi.fn(),
		},
		checkout: {
			sessions: {
				create: vi.fn(),
				retrieve: vi.fn(),
			},
		},
		subscriptions: {
			retrieve: vi.fn(),
			list: vi.fn(),
			update: vi.fn(),
			cancel: vi.fn(),
		},
		billingPortal: {
			configurations: {
				list: vi.fn(),
				create: vi.fn(),
			},
			sessions: {
				create: vi.fn(),
			},
		},
		invoices: {
			list: vi.fn(),
		},
		webhooks: {
			constructEvent: vi.fn(),
		},
		testHelpers: {
			testClocks: {
				create: vi.fn(),
			},
		},
		customers: {
			create: vi.fn(),
		},
	}

	class MockStripeConstructor {
		constructor() {
			return mockStripe
		}

		static createFetchHttpClient() {
			return {}
		}
	}

	return {
		default: MockStripeConstructor,
	}
})

describe('StripeProvider', () => {
	let stripeProvider: StripeProvider
	let mockStripeInstance: any

	beforeEach(() => {
		vi.clearAllMocks()
		stripeProvider = new StripeProvider({ apiKey: 'sk_test_mock_key' })
		mockStripeInstance = stripeProvider.getClient()
	})

	describe('constructor', () => {
		it('should create instance with valid API key', () => {
			const provider = new StripeProvider({ apiKey: 'sk_test_key' })
			expect(provider).toBeInstanceOf(StripeProvider)
		})

		it('should throw error when API key is missing', () => {
			expect(() => new StripeProvider({ apiKey: '' })).toThrow(
				'Stripe API key is required',
			)
		})

		it('should throw error when API key format is invalid', () => {
			expect(() => new StripeProvider({ apiKey: 'invalid_key' })).toThrow(
				'Stripe API key does not appear to be valid',
			)
		})

		it('should accept live mode API key', () => {
			const provider = new StripeProvider({ apiKey: 'sk_live_key' })
			expect(provider).toBeInstanceOf(StripeProvider)
		})
	})

	describe('getProducts', () => {
		it('should fetch and transform products', async () => {
			const mockProducts = {
				data: [
					{
						id: 'prod_123',
						name: 'Base Plan',
						description: 'Basic subscription',
						default_price: 'price_123',
					},
					{
						id: 'prod_456',
						name: 'Plus Plan',
						description: 'Premium subscription',
						default_price: 'price_456',
					},
				],
			}

			mockStripeInstance.products.list.mockResolvedValue(mockProducts)

			const result = await stripeProvider.getProducts()

			expect(result).toEqual([
				{
					id: 'prod_123',
					name: 'Base Plan',
					description: 'Basic subscription',
					defaultPriceId: 'price_123',
				},
				{
					id: 'prod_456',
					name: 'Plus Plan',
					description: 'Premium subscription',
					defaultPriceId: 'price_456',
				},
			])

			expect(mockStripeInstance.products.list).toHaveBeenCalledWith({
				active: true,
				limit: 10,
			})
		})

		it('should handle product fetch errors', async () => {
			mockStripeInstance.products.list.mockRejectedValue(new Error('API Error'))

			await expect(stripeProvider.getProducts()).rejects.toThrow(
				'Failed to fetch Stripe products: API Error',
			)
		})

		it('should handle products without default price', async () => {
			mockStripeInstance.products.list.mockResolvedValue({
				data: [
					{
						id: 'prod_123',
						name: 'No Price Plan',
						description: null,
						default_price: null,
					},
				],
			})

			const result = await stripeProvider.getProducts()

			expect(result[0]?.defaultPriceId).toBeNull()
		})
	})

	describe('getPrices', () => {
		it('should fetch and transform prices', async () => {
			const mockPrices = {
				data: [
					{
						id: 'price_123',
						product: 'prod_123',
						unit_amount: 1000,
						currency: 'usd',
						recurring: {
							interval: 'month',
							trial_period_days: 14,
						},
						tiers: null,
					},
					{
						id: 'price_456',
						product: 'prod_456',
						unit_amount: 10000,
						currency: 'usd',
						recurring: {
							interval: 'year',
							trial_period_days: null,
						},
						tiers: null,
					},
				],
			}

			mockStripeInstance.prices.list.mockResolvedValue(mockPrices)

			const result = await stripeProvider.getPrices()

			expect(result).toEqual([
				{
					id: 'price_123',
					productId: 'prod_123',
					unitAmount: 1000,
					interval: 'month',
					trialPeriodDays: 14,
					currency: 'usd',
					tiers: undefined,
				},
				{
					id: 'price_456',
					productId: 'prod_456',
					unitAmount: 10000,
					interval: 'year',
					trialPeriodDays: null,
					currency: 'usd',
					tiers: undefined,
				},
			])
		})

		it('should handle price fetch errors', async () => {
			mockStripeInstance.prices.list.mockRejectedValue(new Error('API Error'))

			await expect(stripeProvider.getPrices()).rejects.toThrow(
				'Failed to fetch Stripe prices: API Error',
			)
		})
	})

	describe('getPlansAndPrices', () => {
		it('propagates provider failures instead of returning an empty catalog', async () => {
			mockStripeInstance.products.list.mockRejectedValue(new Error('API Error'))

			await expect(stripeProvider.getPlansAndPrices()).rejects.toThrow(
				'Failed to fetch Stripe products: API Error',
			)
		})
	})

	describe('createCheckoutSession', () => {
		it('should create checkout session successfully', async () => {
			const mockSession = {
				id: 'cs_123',
				url: 'https://checkout.stripe.com/pay/cs_123',
				customer: 'cus_123',
				subscription: 'sub_123',
			}

			mockStripeInstance.checkout.sessions.create.mockResolvedValue(mockSession)

			const result = await stripeProvider.createCheckoutSession({
				priceId: 'price_123',
				quantity: 1,
				successUrl: 'https://example.com/success',
				cancelUrl: 'https://example.com/cancel',
				customerId: 'cus_123',
			})

			expect(result).toEqual({
				id: 'cs_123',
				url: 'https://checkout.stripe.com/pay/cs_123',
				customerId: 'cus_123',
				subscriptionId: 'sub_123',
			})

			expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(
				expect.objectContaining({
					payment_method_types: ['card'],
					line_items: [{ price: 'price_123', quantity: 1 }],
					mode: 'subscription',
					success_url: 'https://example.com/success',
					cancel_url: 'https://example.com/cancel',
					customer: 'cus_123',
				}),
				undefined,
			)
		})

		it('should include trial period when specified', async () => {
			mockStripeInstance.checkout.sessions.create.mockResolvedValue({
				id: 'cs_123',
				url: 'https://checkout.stripe.com/pay/cs_123',
			})

			await stripeProvider.createCheckoutSession({
				priceId: 'price_123',
				quantity: 1,
				successUrl: 'https://example.com/success',
				cancelUrl: 'https://example.com/cancel',
				trialPeriodDays: 14,
			})

			expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(
				expect.objectContaining({
					subscription_data: {
						trial_period_days: 14,
					},
				}),
				undefined,
			)
		})

		it('should pass metadata and idempotency key when specified', async () => {
			mockStripeInstance.checkout.sessions.create.mockResolvedValue({
				id: 'cs_123',
				url: 'https://checkout.stripe.com/pay/cs_123',
			})

			await stripeProvider.createCheckoutSession({
				priceId: 'price_123',
				quantity: 1,
				successUrl: 'https://example.com/success',
				cancelUrl: 'https://example.com/cancel',
				metadata: { organizationId: 'org_123', isCreationFlow: 'false' },
				idempotencyKey: 'checkout-org_123-price_123',
			})

			expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(
				expect.objectContaining({
					metadata: {
						organizationId: 'org_123',
						isCreationFlow: 'false',
					},
				}),
				{ idempotencyKey: 'checkout-org_123-price_123' },
			)
		})

		it('should handle session without URL', async () => {
			mockStripeInstance.checkout.sessions.create.mockResolvedValue({
				id: 'cs_123',
				url: null,
			})

			const result = await stripeProvider.createCheckoutSession({
				priceId: 'price_123',
				quantity: 1,
				successUrl: 'https://example.com/success',
				cancelUrl: 'https://example.com/cancel',
			})

			expect(result.url).toBe('')
		})
	})

	describe('retrieveSubscription', () => {
		it('should retrieve and transform subscription', async () => {
			const mockSubscription = {
				id: 'sub_123',
				status: 'active',
				customer: 'cus_123',
				items: {
					data: [
						{
							id: 'si_123',
							plan: { product: 'prod_123' },
							price: { id: 'price_123' },
							quantity: 1,
						},
					],
				},
				trial_end: 1672531200,
				current_period_end: 1675209600,
				cancel_at_period_end: false,
			}

			mockStripeInstance.subscriptions.retrieve.mockResolvedValue(
				mockSubscription,
			)

			const result = await stripeProvider.retrieveSubscription('sub_123')

			expect(result).toEqual({
				id: 'sub_123',
				status: 'active',
				customerId: 'cus_123',
				productId: 'prod_123',
				priceId: 'price_123',
				trialEnd: new Date(1672531200 * 1000),
				currentPeriodEnd: new Date(1675209600 * 1000),
				cancelAtPeriodEnd: false,
				quantity: 1,
				items: [
					{
						id: 'si_123',
						priceId: 'price_123',
						quantity: 1,
					},
				],
			})
		})
	})

	describe('updateSubscription', () => {
		it('should update subscription successfully', async () => {
			const mockExistingSubscription = {
				id: 'sub_123',
				status: 'active',
				items: {
					data: [{ id: 'si_123' }],
				},
				trial_end: null,
			}

			const mockUpdatedSubscription = {
				id: 'sub_123',
				status: 'active',
				customer: 'cus_123',
				items: {
					data: [
						{
							id: 'si_123',
							plan: { product: 'prod_456' },
							price: { id: 'price_456' },
							quantity: 2,
						},
					],
				},
				current_period_end: 1675209600,
				cancel_at_period_end: false,
			}

			mockStripeInstance.subscriptions.retrieve.mockResolvedValue(
				mockExistingSubscription,
			)
			mockStripeInstance.subscriptions.update.mockResolvedValue(
				mockUpdatedSubscription,
			)

			const result = await stripeProvider.updateSubscription({
				subscriptionId: 'sub_123',
				priceId: 'price_456',
				quantity: 2,
			})

			expect(result.priceId).toBe('price_456')
			expect(result.quantity).toBe(2)
		})

		it('should preserve trial end when requested and subscription is trialing', async () => {
			const trialEnd = Math.floor(Date.now() / 1000) + 86400

			mockStripeInstance.subscriptions.retrieve.mockResolvedValue({
				id: 'sub_123',
				status: 'trialing',
				items: { data: [{ id: 'si_123' }] },
				trial_end: trialEnd,
			})

			mockStripeInstance.subscriptions.update.mockResolvedValue({
				id: 'sub_123',
				status: 'trialing',
				customer: 'cus_123',
				items: {
					data: [
						{
							id: 'si_123',
							plan: { product: 'prod_123' },
							price: { id: 'price_456' },
							quantity: 1,
						},
					],
				},
				trial_end: trialEnd,
			})

			await stripeProvider.updateSubscription({
				subscriptionId: 'sub_123',
				priceId: 'price_456',
				preserveTrialEnd: true,
			})

			expect(mockStripeInstance.subscriptions.update).toHaveBeenCalledWith(
				'sub_123',
				expect.objectContaining({
					trial_end: trialEnd,
				}),
			)
		})
	})

	describe('cancelSubscription', () => {
		it('should cancel subscription', async () => {
			const mockCanceledSubscription = {
				id: 'sub_123',
				status: 'canceled',
				customer: 'cus_123',
				items: {
					data: [
						{
							id: 'si_123',
							plan: { product: 'prod_123' },
							price: { id: 'price_123' },
							quantity: 1,
						},
					],
				},
			}

			mockStripeInstance.subscriptions.cancel.mockResolvedValue(
				mockCanceledSubscription,
			)

			const result = await stripeProvider.cancelSubscription('sub_123')

			expect(result.status).toBe('canceled')
			expect(mockStripeInstance.subscriptions.cancel).toHaveBeenCalledWith(
				'sub_123',
			)
		})
	})

	describe('constructWebhookEvent', () => {
		it('should construct webhook event', async () => {
			const mockEvent = {
				id: 'evt_123',
				type: 'customer.subscription.updated',
				data: {
					object: { id: 'sub_123', status: 'active' },
				},
			}

			mockStripeInstance.webhooks.constructEvent.mockReturnValue(mockEvent)

			const result = await stripeProvider.constructWebhookEvent(
				'payload',
				'signature',
				'secret',
			)

			expect(result).toEqual({
				id: 'evt_123',
				type: 'customer.subscription.updated',
				data: { id: 'sub_123', status: 'active' },
			})
		})
	})

	describe('listInvoices', () => {
		it('should list invoices for customer', async () => {
			const mockInvoices = {
				data: [
					{
						id: 'in_123',
						number: 'INV-001',
						status: 'paid',
						amount_paid: 1000,
						amount_due: 0,
						currency: 'usd',
						created: 1672531200,
						due_date: null,
						hosted_invoice_url: 'https://invoice.stripe.com/i/123',
						invoice_pdf: 'https://invoice.stripe.com/i/123/pdf',
						period_start: 1672531200,
						period_end: 1675209600,
					},
				],
			}

			mockStripeInstance.invoices.list.mockResolvedValue(mockInvoices)

			const result = await stripeProvider.listInvoices('cus_123')

			expect(result).toHaveLength(1)
			expect(result[0]).toEqual({
				id: 'in_123',
				number: 'INV-001',
				status: 'paid',
				amountPaid: 1000,
				amountDue: 0,
				currency: 'usd',
				created: 1672531200,
				dueDate: null,
				hostedInvoiceUrl: 'https://invoice.stripe.com/i/123',
				invoicePdf: 'https://invoice.stripe.com/i/123/pdf',
				periodStart: 1672531200,
				periodEnd: 1675209600,
			})
		})

		it('should return empty array on error', async () => {
			mockStripeInstance.invoices.list.mockRejectedValue(new Error('API Error'))

			const result = await stripeProvider.listInvoices('cus_123')

			expect(result).toEqual([])
		})
	})

	describe('sanitizeStripeErrorMessage', () => {
		it('redacts Stripe secret keys from error text', () => {
			const secret = 'sk_test_key'
			expect(
				sanitizeStripeErrorMessage(`Invalid API Key provided: ${secret}`),
			).toBe('Invalid API Key provided: [STRIPE_KEY_REDACTED]')
		})

		it('redacts keys with organization, underscore, and hyphen suffixes', () => {
			const secret = ['sk', 'org', 'part_one-two'].join('_')
			expect(sanitizeStripeErrorMessage(`Invalid key: ${secret}`)).toBe(
				'Invalid key: [STRIPE_KEY_REDACTED]',
			)
		})
	})
})
