import { db, eq, Organization, RateLimitEntry } from '@repo/database'
import type * as paymentsModule from '@repo/payments'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'

/**
 * A tiny stand-in for the payment provider's billing state: the subscription's
 * status, its open invoice and the failed attempts, as Stripe holds them now.
 */
const stripeState = vi.hoisted(() => ({
	subscription: {
		status: 'past_due',
		customerId: 'cus_pd',
		productId: 'prod_pro',
	},
	invoice: null as null | {
		id: string
		amountDue: number
		currency: string
		attemptCount: number
		nextPaymentAttempt: number | null
		hostedInvoiceUrl: string | null
		created: number
	},
	attempts: [] as Array<{
		at: number
		brand: string | null
		last4: string | null
		reason: string | null
	}>,
	declineNext: false,
	paid: [] as Array<{ invoiceId: string; idempotencyKey: string }>,
}))

vi.mock('@repo/payments', async (importOriginal) => {
	const actual = await importOriginal<typeof paymentsModule>()
	return {
		...actual,
		createStripeProvider: () => ({
			getClient: () => ({
				subscriptions: { list: async () => ({ data: [] }) },
			}),
			getProducts: async () => [{ id: 'prod_pro', name: 'Pro' }],
			retrieveSubscription: async (id: string) => ({
				id,
				priceId: 'price',
				items: [],
				trialEnd: null,
				...stripeState.subscription,
			}),
			getBillingIssue: async () => ({
				invoice: stripeState.invoice,
				attempts: stripeState.attempts,
			}),
			payInvoice: async (
				invoiceId: string,
				options: { idempotencyKey: string },
			) => {
				stripeState.paid.push({
					invoiceId,
					idempotencyKey: options.idempotencyKey,
				})
				if (stripeState.declineNext) {
					return { status: 'failed' as const, reason: 'card_declined' }
				}
				// What Stripe does: the invoice is paid and the subscription is active.
				stripeState.invoice = null
				stripeState.subscription.status = 'active'
				return { status: 'paid' as const }
			},
		}),
	}
})

const { handleSubscriptionChange, loadBillingIssue, retryBillingPayment } =
	await import('./payments.server.ts')
const { billingPastDueFor } = await import('./billing/past-due.server.ts')

function openInvoice(attemptCount = 1) {
	return {
		id: 'in_open',
		amountDue: 4999,
		currency: 'usd',
		attemptCount,
		nextPaymentAttempt: 1_700_300_000,
		hostedInvoiceUrl: null,
		created: 1_700_000_000,
	}
}

async function setupOrg(status: string | null = 'past_due') {
	const user = await createTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
	await db
		.update(Organization)
		.set({
			stripeCustomerId: 'cus_pd',
			stripeSubscriptionId: 'sub_pd',
			stripeProductId: 'prod_pro',
			planName: 'Pro',
			subscriptionStatus: status,
			pastDueSince:
				status === 'past_due' ? new Date('2026-11-01T00:00:00Z') : null,
		})
		.where(eq(Organization.id, organization.id))
	return { user, organization }
}

async function billing(organizationId: string) {
	const [row] = await db
		.select({
			subscriptionStatus: Organization.subscriptionStatus,
			pastDueSince: Organization.pastDueSince,
			stripeCustomerId: Organization.stripeCustomerId,
			stripeSubscriptionId: Organization.stripeSubscriptionId,
			stripeProductId: Organization.stripeProductId,
			planName: Organization.planName,
			id: Organization.id,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
	return row!
}

describe('past-due subscription (#237)', () => {
	beforeEach(async () => {
		stripeState.subscription = {
			status: 'past_due',
			customerId: 'cus_pd',
			productId: 'prod_pro',
		}
		stripeState.invoice = openInvoice(2)
		stripeState.attempts = [
			{
				at: 1_700_200_000,
				brand: 'visa',
				last4: '1234',
				reason: 'expired_card',
			},
			{
				at: 1_700_100_000,
				brand: 'visa',
				last4: '1234',
				reason: 'card_declined',
			},
		]
		stripeState.declineNext = false
		stripeState.paid.length = 0
		await db.delete(RateLimitEntry)
	})

	describe('state from the stored webhook', () => {
		it('stores when the subscription became past due once, and clears it when it is paid', async () => {
			const { organization } = await setupOrg('active')
			await handleSubscriptionChange({
				id: 'sub_pd',
				status: 'past_due',
				customer: 'cus_pd',
				items: [{ price: { id: 'price', product: 'prod_pro' } }],
			})
			const first = await billing(organization.id)
			expect(first.subscriptionStatus).toBe('past_due')
			expect(first.pastDueSince).toBeInstanceOf(Date)

			// A later dunning event does not move the start.
			await new Promise((resolve) => setTimeout(resolve, 5))
			await handleSubscriptionChange({
				id: 'sub_pd',
				status: 'past_due',
				customer: 'cus_pd',
				items: [{ price: { id: 'price', product: 'prod_pro' } }],
			})
			expect((await billing(organization.id)).pastDueSince?.getTime()).toBe(
				first.pastDueSince?.getTime(),
			)

			// The webhook for the paid subscription clears the state: banner gone.
			stripeState.subscription.status = 'active'
			await handleSubscriptionChange({
				id: 'sub_pd',
				status: 'active',
				customer: 'cus_pd',
				items: [{ price: { id: 'price', product: 'prod_pro' } }],
			})
			const after = await billing(organization.id)
			expect(after.subscriptionStatus).toBe('active')
			expect(after.pastDueSince).toBeNull()
			expect(
				await billingPastDueFor({
					userId: (await createTestUser()).id,
					organization: { id: organization.id, slug: 'x' },
				}),
			).toBeNull()
		})
	})

	describe('the banner', () => {
		it('shows to members who can manage billing and to nobody else', async () => {
			const { user, organization } = await setupOrg('past_due')
			expect(
				await billingPastDueFor({
					userId: user.id,
					organization: { id: organization.id, slug: organization.slug },
				}),
			).toEqual({ orgSlug: organization.slug })

			const viewer = await createTestUser()
			const { addOrganizationMember } = await import('#tests/test-utils.ts')
			await addOrganizationMember(viewer.id, organization.id, 'org_role_viewer')
			expect(
				await billingPastDueFor({
					userId: viewer.id,
					organization: { id: organization.id, slug: organization.slug },
				}),
			).toBeNull()

			// Not a member at all: nothing either.
			expect(
				await billingPastDueFor({
					userId: (await createTestUser()).id,
					organization: { id: organization.id, slug: organization.slug },
				}),
			).toBeNull()
		})

		it('does not show while the subscription is paying', async () => {
			const { user, organization } = await setupOrg('active')
			expect(
				await billingPastDueFor({
					userId: user.id,
					organization: { id: organization.id, slug: organization.slug },
				}),
			).toBeNull()
		})
	})

	describe('the history', () => {
		it('lists each failed attempt and the next try date', async () => {
			const { organization } = await setupOrg('past_due')
			const issue = await loadBillingIssue(await billing(organization.id))
			expect(issue?.attempts).toHaveLength(2)
			expect(issue?.attempts[0]).toMatchObject({
				brand: 'visa',
				last4: '1234',
				reason: 'expired_card',
			})
			expect(issue?.invoice).toMatchObject({
				id: 'in_open',
				amountDue: 4999,
				nextPaymentAttempt: 1_700_300_000,
			})
		})
	})

	describe('Retry payment', () => {
		it('pays the open invoice and clears the past-due state at once', async () => {
			const { organization } = await setupOrg('past_due')
			const result = await retryBillingPayment(await billing(organization.id))
			expect(result).toEqual({ status: 'paid' })
			expect(stripeState.paid).toEqual([
				{ invoiceId: 'in_open', idempotencyKey: 'billing-retry:in_open:2' },
			])
			const after = await billing(organization.id)
			expect(after.subscriptionStatus).toBe('active')
			expect(after.pastDueSince).toBeNull()
		})

		it('is limited to once a minute, so a double click never charges twice', async () => {
			const { organization } = await setupOrg('past_due')
			stripeState.declineNext = true
			const first = await retryBillingPayment(await billing(organization.id))
			expect(first).toEqual({ status: 'declined', reason: 'card_declined' })
			const second = await retryBillingPayment(await billing(organization.id))
			expect(second.status).toBe('rate_limited')
			expect(stripeState.paid).toHaveLength(1)
		})

		it('leaves the state alone when the card is declined', async () => {
			const { organization } = await setupOrg('past_due')
			stripeState.declineNext = true
			await retryBillingPayment(await billing(organization.id))
			const after = await billing(organization.id)
			expect(after.subscriptionStatus).toBe('past_due')
			expect(after.pastDueSince).toBeInstanceOf(Date)
		})

		it('follows the provider when nothing is open any more, without charging', async () => {
			const { organization } = await setupOrg('past_due')
			stripeState.invoice = null
			stripeState.subscription.status = 'active'
			const result = await retryBillingPayment(await billing(organization.id))
			expect(result).toEqual({ status: 'already_paid' })
			expect(stripeState.paid).toHaveLength(0)
			expect((await billing(organization.id)).subscriptionStatus).toBe('active')
		})

		it('does nothing for a subscription that is not past due', async () => {
			const { organization } = await setupOrg('active')
			const result = await retryBillingPayment(await billing(organization.id))
			expect(result).toEqual({ status: 'not_past_due' })
			expect(stripeState.paid).toHaveLength(0)
		})
	})
})
