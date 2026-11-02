/**
 * Unit tests for Stripe checkout success handler
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { handleStripeCheckout } from '../../src/route-handlers/stripe-checkout'

const mockDbUpdate = vi.fn()
const mockDbSelect = vi.fn()

vi.mock('@repo/database', () => ({
	db: {
		select: (...args: unknown[]) => mockDbSelect(...args),
		update: (...args: unknown[]) => mockDbUpdate(...args),
	},
	eq: vi.fn(),
	Organization: { id: 'id', slug: 'slug' },
	UserOrganization: { userId: 'userId', organizationId: 'organizationId' },
}))

vi.mock('../../src/utils/duplicate-subscriptions', () => ({
	cleanupDuplicateSubscriptions: vi.fn().mockResolvedValue({
		keptSubscriptionId: 'sub_kept',
		cancelledSubscriptionIds: [],
		refundedSubscriptionIds: [],
	}),
}))

describe('handleStripeCheckout', () => {
	let mockStripe: any

	beforeEach(() => {
		mockStripe = {
			checkout: {
				sessions: {
					retrieve: vi.fn(),
				},
			},
			subscriptions: {
				retrieve: vi.fn(),
			},
		}

		mockDbSelect.mockReturnValue({
			from: vi.fn().mockReturnValue({
				where: vi.fn().mockResolvedValue([{ organizationId: 'org_123' }]),
			}),
		})

		mockDbUpdate.mockReturnValue({
			set: vi.fn().mockReturnValue({
				where: vi.fn().mockReturnValue({
					returning: vi.fn().mockResolvedValue([{ slug: 'acme' }]),
				}),
			}),
		})
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it('should redirect to pricing when session_id is missing', async () => {
		const request = new Request('https://example.com/api/stripe/checkout')
		const response = await handleStripeCheckout({ request } as any, {
			stripe: mockStripe,
			userId: 'user_123',
		})

		expect(response.status).toBe(302)
		expect(response.headers.get('Location')).toBe('/pricing')
	})

	it('should use organizationId from session metadata, not URL params', async () => {
		mockStripe.checkout.sessions.retrieve.mockResolvedValue({
			metadata: { organizationId: 'org_123' },
			client_reference_id: 'user_123',
			customer: { id: 'cus_123' },
			subscription: 'sub_123',
		})

		mockStripe.subscriptions.retrieve.mockResolvedValue({
			id: 'sub_123',
			status: 'active',
			items: {
				data: [
					{
						price: {
							id: 'price_123',
							product: { id: 'prod_123', name: 'Base' },
						},
					},
				],
			},
		})

		// URL has a tampered organizationId that should be ignored
		const request = new Request(
			'https://example.com/api/stripe/checkout?session_id=cs_123&organizationId=org_tampered',
		)

		const response = await handleStripeCheckout({ request } as any, {
			stripe: mockStripe,
			userId: 'user_123',
		})

		expect(response.status).toBe(302)
		expect(response.headers.get('Location')).toBe('/acme/dashboard')

		const updateCall = mockDbUpdate.mock.results[0]?.value
		const whereCall = await updateCall.set.mock.calls[0]
		expect(whereCall).toBeDefined()
	})

	it('should reject sessions without organizationId in metadata', async () => {
		mockStripe.checkout.sessions.retrieve.mockResolvedValue({
			metadata: {},
			client_reference_id: 'user_123',
			customer: { id: 'cus_123' },
			subscription: 'sub_123',
		})

		const request = new Request(
			'https://example.com/api/stripe/checkout?session_id=cs_123&organizationId=org_tampered',
		)

		const response = await handleStripeCheckout({ request } as any, {
			stripe: mockStripe,
			userId: 'user_123',
		})

		expect(response.status).toBe(302)
		expect(response.headers.get('Location')).toBe('/error')
	})

	it('should redirect to org creation flow when isCreationFlow metadata is set', async () => {
		mockStripe.checkout.sessions.retrieve.mockResolvedValue({
			metadata: {
				organizationId: 'org_123',
				isCreationFlow: 'true',
			},
			client_reference_id: 'user_123',
			customer: { id: 'cus_123' },
			subscription: 'sub_123',
		})

		mockStripe.subscriptions.retrieve.mockResolvedValue({
			id: 'sub_123',
			status: 'trialing',
			items: {
				data: [
					{
						price: {
							id: 'price_123',
							product: { id: 'prod_123', name: 'Base' },
						},
					},
				],
			},
		})

		const request = new Request(
			'https://example.com/api/stripe/checkout?session_id=cs_123',
		)

		const response = await handleStripeCheckout({ request } as any, {
			stripe: mockStripe,
			userId: 'user_123',
		})

		expect(response.status).toBe(302)
		expect(response.headers.get('Location')).toBe(
			'/organizations/create?step=3&orgId=org_123',
		)
	})
})
