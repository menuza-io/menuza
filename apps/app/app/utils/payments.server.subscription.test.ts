import { db, eq, Organization } from '@repo/database'
import type * as paymentsModule from '@repo/payments'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	createTestOrganization,
	createTestSession,
	createTestUser,
} from '#tests/test-utils.ts'

/**
 * A tiny stand-in for Stripe's subscription state: what `retrieve` returns is
 * what Stripe holds now, whatever an (old) webhook event says.
 */
const stripeState = vi.hoisted(() => ({
	subscriptions: new Map<
		string,
		{
			status: string
			customerId: string
			productId: string
			/** Seconds; the newest billable subscription is the one kept. */
			created?: number
		}
	>(),
	cancelled: [] as string[],
	failCancel: new Set<string>(),
	updated: [] as Array<{ subscriptionId: string; priceId: string }>,
	checkouts: [] as string[],
}))

vi.mock('@repo/payments', async (importOriginal) => {
	const actual = await importOriginal<typeof paymentsModule>()
	const cancel = async (id: string) => {
		if (stripeState.failCancel.has(id)) throw new Error('Stripe timed out')
		stripeState.cancelled.push(id)
		const sub = stripeState.subscriptions.get(id)
		if (sub) sub.status = 'canceled'
		return { id }
	}
	const retrieve = async (id: string) => {
		const sub = stripeState.subscriptions.get(id)
		if (!sub) throw new Error(`No such subscription: ${id}`)
		return { id, priceId: 'price', items: [], trialEnd: null, ...sub }
	}
	const price = (id: string, productId: string, interval: string) => ({
		id,
		productId,
		interval,
		currency: 'usd',
	})
	return {
		...actual,
		createStripeProvider: () => ({
			// The raw client, as far as duplicate cleanup uses it.
			getClient: () => ({
				subscriptions: {
					list: async ({ customer }: { customer: string }) => ({
						data: [...stripeState.subscriptions]
							.filter(([, sub]) => sub.customerId === customer)
							.map(([id, sub]) => ({
								id,
								status: sub.status,
								created: sub.created ?? 0,
							})),
					}),
					// Old enough that cleanup never refunds in these tests.
					retrieve: async (id: string) => ({ id, created: 0 }),
					cancel,
				},
			}),
			getProducts: async () => [
				{ id: 'prod_pro', name: 'Pro' },
				{ id: 'prod_team', name: 'Team' },
			],
			getPlansAndPrices: async () => ({
				plans: {},
				prices: {
					base: {
						monthly: price('price_base_m', 'prod_pro', 'month'),
						yearly: price('price_base_y', 'prod_pro', 'year'),
					},
					plus: {
						monthly: price('price_plus_m', 'prod_team', 'month'),
						yearly: undefined,
					},
				},
			}),
			retrieveSubscription: retrieve,
			listSubscriptions: async (customerId: string) =>
				[...stripeState.subscriptions]
					.filter(([, sub]) => sub.customerId === customerId)
					.map(([id, sub]) => ({ id, priceId: 'price', items: [], ...sub })),
			updateSubscription: async (options: {
				subscriptionId: string
				priceId: string
			}) => {
				stripeState.updated.push(options)
				return retrieve(options.subscriptionId)
			},
			createCheckoutSession: async (options: { priceId: string }) => {
				stripeState.checkouts.push(options.priceId)
				return { id: 'cs_1', url: 'https://checkout.example/cs_1' }
			},
			cancelSubscription: cancel,
		}),
	}
})

const { checkoutAction, getTrialStatus, handleSubscriptionChange } =
	await import('./payments.server.ts')

function event(id: string, status: string, customer: string, product: string) {
	return { id, status, customer, items: [{ price: { id: 'price', product } }] }
}

async function orgBilling(organizationId: string) {
	const [org] = await db
		.select({
			stripeSubscriptionId: Organization.stripeSubscriptionId,
			subscriptionStatus: Organization.subscriptionStatus,
			planName: Organization.planName,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
	return org
}

describe('subscription webhooks delivered late or out of order', () => {
	beforeEach(() => {
		stripeState.subscriptions.clear()
		stripeState.cancelled.length = 0
		stripeState.failCancel.clear()
		stripeState.updated.length = 0
		stripeState.checkouts.length = 0
	})

	async function setupOrg(customerId: string) {
		const user = await createTestUser()
		const organization = await createTestOrganization(user.id, 'admin')
		await db
			.update(Organization)
			.set({ stripeCustomerId: customerId })
			.where(eq(Organization.id, organization.id))
		return organization
	}

	it('does not revive a cancelled plan when a retried "active" event arrives after "deleted"', async () => {
		const organization = await setupOrg('cus_late')
		stripeState.subscriptions.set('sub_A', {
			status: 'active',
			customerId: 'cus_late',
			productId: 'prod_pro',
		})
		await handleSubscriptionChange(
			event('sub_A', 'active', 'cus_late', 'prod_pro'),
		)
		expect(await orgBilling(organization.id)).toMatchObject({
			stripeSubscriptionId: 'sub_A',
			subscriptionStatus: 'active',
		})

		// The customer cancels; Stripe sends "deleted".
		stripeState.subscriptions.get('sub_A')!.status = 'canceled'
		await handleSubscriptionChange(
			event('sub_A', 'canceled', 'cus_late', 'prod_pro'),
		)

		// Stripe retries an earlier "updated (active)" delivery that had failed.
		await handleSubscriptionChange(
			event('sub_A', 'active', 'cus_late', 'prod_pro'),
		)

		expect(await orgBilling(organization.id)).toMatchObject({
			stripeSubscriptionId: null,
			subscriptionStatus: 'canceled',
			planName: null,
		})
	})

	it('does not cancel the current subscription because of a stale event for the old one', async () => {
		const organization = await setupOrg('cus_switch')
		stripeState.subscriptions.set('sub_old', {
			status: 'canceled',
			customerId: 'cus_switch',
			productId: 'prod_pro',
		})
		stripeState.subscriptions.set('sub_new', {
			status: 'active',
			customerId: 'cus_switch',
			productId: 'prod_team',
		})
		await handleSubscriptionChange(
			event('sub_new', 'active', 'cus_switch', 'prod_team'),
		)

		await handleSubscriptionChange(
			event('sub_old', 'active', 'cus_switch', 'prod_pro'),
		)

		expect(stripeState.cancelled).not.toContain('sub_new')
		expect(await orgBilling(organization.id)).toMatchObject({
			stripeSubscriptionId: 'sub_new',
			subscriptionStatus: 'active',
			planName: 'Team',
		})
	})

	it('still replaces the previous subscription when a new one really is active', async () => {
		const organization = await setupOrg('cus_upgrade')
		stripeState.subscriptions.set('sub_1', {
			status: 'active',
			customerId: 'cus_upgrade',
			productId: 'prod_pro',
		})
		await handleSubscriptionChange(
			event('sub_1', 'active', 'cus_upgrade', 'prod_pro'),
		)
		stripeState.subscriptions.set('sub_2', {
			status: 'active',
			customerId: 'cus_upgrade',
			productId: 'prod_team',
		})

		await handleSubscriptionChange(
			event('sub_2', 'active', 'cus_upgrade', 'prod_team'),
		)

		expect(stripeState.cancelled).toEqual(['sub_1'])
		expect(await orgBilling(organization.id)).toMatchObject({
			stripeSubscriptionId: 'sub_2',
			planName: 'Team',
		})
	})

	it('rejects (so Stripe retries) instead of trusting the event when Stripe cannot be read', async () => {
		const organization = await setupOrg('cus_down')
		stripeState.subscriptions.set('sub_A', {
			status: 'active',
			customerId: 'cus_down',
			productId: 'prod_pro',
		})
		await handleSubscriptionChange(
			event('sub_A', 'active', 'cus_down', 'prod_pro'),
		)

		// Stripe has no answer for sub_B (here: retrieve throws).
		await expect(
			handleSubscriptionChange(
				event('sub_B', 'active', 'cus_down', 'prod_team'),
			),
		).rejects.toThrow()

		expect(stripeState.cancelled).toEqual([])
		expect(await orgBilling(organization.id)).toMatchObject({
			stripeSubscriptionId: 'sub_A',
			planName: 'Pro',
		})
	})
	function billable(customerId: string) {
		return [...stripeState.subscriptions]
			.filter(
				([, sub]) =>
					sub.customerId === customerId &&
					(sub.status === 'active' || sub.status === 'trialing'),
			)
			.map(([id]) => id)
	}

	it('fails the webhook when the old subscription cannot be cancelled, and the retry cancels it', async () => {
		const organization = await setupOrg('cus_twice')
		stripeState.subscriptions.set('sub_1', {
			status: 'active',
			customerId: 'cus_twice',
			productId: 'prod_pro',
			created: 1,
		})
		await handleSubscriptionChange(
			event('sub_1', 'active', 'cus_twice', 'prod_pro'),
		)
		stripeState.subscriptions.set('sub_2', {
			status: 'active',
			customerId: 'cus_twice',
			productId: 'prod_team',
			created: 2,
		})
		stripeState.failCancel.add('sub_1')
		// Stripe gets a 500 and retries, instead of two plans billing forever.
		await expect(
			handleSubscriptionChange(
				event('sub_2', 'active', 'cus_twice', 'prod_team'),
			),
		).rejects.toThrow()

		stripeState.failCancel.clear()
		await handleSubscriptionChange(
			event('sub_2', 'active', 'cus_twice', 'prod_team'),
		)
		expect(billable('cus_twice')).toEqual(['sub_2'])
		expect(await orgBilling(organization.id)).toMatchObject({
			stripeSubscriptionId: 'sub_2',
			planName: 'Team',
		})
	})

	it('keeps the newer subscription when an event for the older one arrives while both are live', async () => {
		const organization = await setupOrg('cus_order')
		stripeState.subscriptions.set('sub_A', {
			status: 'active',
			customerId: 'cus_order',
			productId: 'prod_pro',
			created: 1,
		})
		await handleSubscriptionChange(
			event('sub_A', 'active', 'cus_order', 'prod_pro'),
		)
		stripeState.subscriptions.set('sub_B', {
			status: 'active',
			customerId: 'cus_order',
			productId: 'prod_team',
			created: 2,
		})
		// B's handler records B, then fails to cancel A: both stay live until
		// Stripe retries B's event.
		stripeState.failCancel.add('sub_A')
		await expect(
			handleSubscriptionChange(
				event('sub_B', 'active', 'cus_order', 'prod_team'),
			),
		).rejects.toThrow()
		stripeState.failCancel.clear()

		// Meanwhile an event for A (a retry, or one delivered in parallel).
		await handleSubscriptionChange(
			event('sub_A', 'active', 'cus_order', 'prod_pro'),
		)

		expect(stripeState.cancelled).not.toContain('sub_B')
		expect(billable('cus_order')).toEqual(['sub_B'])
		expect(await orgBilling(organization.id)).toMatchObject({
			stripeSubscriptionId: 'sub_B',
			subscriptionStatus: 'active',
			planName: 'Team',
		})
	})

	it('keeps one subscription when two "created" events are handled at once', async () => {
		const organization = await setupOrg('cus_race')
		stripeState.subscriptions.set('sub_old', {
			status: 'active',
			customerId: 'cus_race',
			productId: 'prod_pro',
			created: 1,
		})
		await handleSubscriptionChange(
			event('sub_old', 'active', 'cus_race', 'prod_pro'),
		)
		stripeState.subscriptions.set('sub_a', {
			status: 'active',
			customerId: 'cus_race',
			productId: 'prod_pro',
			created: 2,
		})
		stripeState.subscriptions.set('sub_b', {
			status: 'active',
			customerId: 'cus_race',
			productId: 'prod_team',
			created: 3,
		})
		await Promise.all([
			handleSubscriptionChange(
				event('sub_a', 'active', 'cus_race', 'prod_pro'),
			),
			handleSubscriptionChange(
				event('sub_b', 'active', 'cus_race', 'prod_team'),
			),
		])
		expect(billable('cus_race')).toEqual(['sub_b'])
		expect(await orgBilling(organization.id)).toMatchObject({
			stripeSubscriptionId: 'sub_b',
			planName: 'Team',
		})
	})

	it('records dunning states and clears the plan only when the subscription ends', async () => {
		const organization = await setupOrg('cus_dunning')
		stripeState.subscriptions.set('sub_d', {
			status: 'active',
			customerId: 'cus_dunning',
			productId: 'prod_pro',
		})
		await handleSubscriptionChange(
			event('sub_d', 'active', 'cus_dunning', 'prod_pro'),
		)
		stripeState.subscriptions.get('sub_d')!.status = 'past_due'
		await handleSubscriptionChange(
			event('sub_d', 'past_due', 'cus_dunning', 'prod_pro'),
		)
		expect(await orgBilling(organization.id)).toMatchObject({
			stripeSubscriptionId: 'sub_d',
			subscriptionStatus: 'past_due',
			planName: 'Pro',
		})

		stripeState.subscriptions.get('sub_d')!.status = 'incomplete_expired'
		await handleSubscriptionChange(
			event('sub_d', 'incomplete_expired', 'cus_dunning', 'prod_pro'),
		)
		expect(await orgBilling(organization.id)).toMatchObject({
			stripeSubscriptionId: null,
			subscriptionStatus: 'incomplete_expired',
			planName: null,
		})
	})

	it('does not report a past-due subscription as an active plan', async () => {
		const user = await createTestUser()
		const organization = await createTestOrganization(user.id, 'admin')
		stripeState.subscriptions.set('sub_t', {
			status: 'past_due',
			customerId: 'cus_trial',
			productId: 'prod_pro',
		})
		// The last webhook said trialing; Stripe now says past due.
		await db
			.update(Organization)
			.set({
				stripeCustomerId: 'cus_trial',
				stripeSubscriptionId: 'sub_t',
				subscriptionStatus: 'trialing',
			})
			.where(eq(Organization.id, organization.id))
		expect(await getTrialStatus(user.id, organization.slug)).toMatchObject({
			isActive: false,
		})
	})

	it('refuses a plan change to a price the app does not offer', async () => {
		const user = await createTestUser()
		const organization = await setupOrg('cus_price')
		stripeState.subscriptions.set('sub_p', {
			status: 'active',
			customerId: 'cus_price',
			productId: 'prod_pro',
		})
		await db
			.update(Organization)
			.set({ stripeSubscriptionId: 'sub_p', subscriptionStatus: 'active' })
			.where(eq(Organization.id, organization.id))
		const [row] = await db
			.select()
			.from(Organization)
			.where(eq(Organization.id, organization.id))
		const { cookie } = await createTestSession(user.id)
		const request = () =>
			new Request('https://app.test/billing', {
				method: 'POST',
				headers: { Cookie: cookie },
			})

		const refused = await checkoutAction(
			request(),
			row!,
			'price_secret_free',
		).then(
			() => null,
			(error: unknown) => error,
		)
		expect(refused).toBeInstanceOf(Response)
		expect((refused as Response).status).toBe(400)
		expect(stripeState.updated).toEqual([])
		expect(stripeState.checkouts).toEqual([])

		await checkoutAction(request(), row!, 'price_plus_m')
		expect(stripeState.updated).toMatchObject([
			{ subscriptionId: 'sub_p', priceId: 'price_plus_m' },
		])
	})
})
