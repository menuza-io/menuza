import { db, eq, Organization, UserOrganization } from '@repo/database'
import { type LoaderFunctionArgs, redirect } from 'react-router'
import type Stripe from 'stripe'
import { cleanupDuplicateSubscriptions } from '../utils/duplicate-subscriptions'

export interface StripeCheckoutDependencies {
	stripe: Stripe
	/** The signed-in user. The session's client_reference_id must match. */
	userId: string
}

/**
 * Shared Stripe checkout success handler.
 * This handler processes successful Stripe checkout sessions and updates the organization.
 * Used by both the admin and app applications.
 *
 * Organization ID is read from Stripe session metadata (set at checkout creation)
 * rather than URL query params, which prevents organizationId tampering.
 *
 * @param request - The incoming request with session_id param
 * @param deps - Dependencies (stripe client)
 * @returns Redirect response to appropriate page
 */
export async function handleStripeCheckout(
	{ request }: LoaderFunctionArgs,
	deps: StripeCheckoutDependencies,
) {
	const url = new URL(request.url)
	const sessionId = url.searchParams.get('session_id')
	if (!sessionId) {
		return redirect('/pricing')
	}

	try {
		const session = await deps.stripe.checkout.sessions.retrieve(sessionId, {
			expand: ['customer', 'subscription'],
		})

		const organizationId = session.metadata?.organizationId
		if (!organizationId) {
			throw new Error('No organization ID found in session metadata.')
		}

		if (!session.customer || typeof session.customer === 'string') {
			throw new Error('Invalid customer data from Stripe.')
		}

		const customerId = session.customer.id
		const subscriptionId =
			typeof session.subscription === 'string'
				? session.subscription
				: session.subscription?.id

		if (!subscriptionId) {
			throw new Error('No subscription found for this session.')
		}

		const subscription = await deps.stripe.subscriptions.retrieve(
			subscriptionId,
			{
				expand: ['items.data.price.product'],
			},
		)

		const plan = subscription.items.data[0]?.price

		if (!plan) {
			throw new Error('No plan found for this subscription.')
		}

		const productId = (plan.product as Stripe.Product).id

		if (!productId) {
			throw new Error('No product ID found for this subscription.')
		}

		const userId = session.client_reference_id
		if (!userId || userId !== deps.userId) {
			throw new Error('Checkout session does not belong to the signed-in user.')
		}
		if (session.status === 'expired' || session.payment_status === 'unpaid') {
			throw new Error('Checkout session is not complete.')
		}

		const organizations = await db
			.select({ organizationId: UserOrganization.organizationId })
			.from(UserOrganization)
			.where(eq(UserOrganization.userId, userId))

		if (organizations.length === 0) {
			throw new Error('User not found in database.')
		}

		const isMember = organizations.some(
			(org) => org.organizationId === organizationId,
		)
		if (!isMember) {
			throw new Error('User is not authorized to update this organization.')
		}

		const [current] = await db
			.select({
				stripeSubscriptionId: Organization.stripeSubscriptionId,
				slug: Organization.slug,
			})
			.from(Organization)
			.where(eq(Organization.id, organizationId))
		if (
			current?.stripeSubscriptionId &&
			current.stripeSubscriptionId !== subscriptionId &&
			current.slug
		) {
			// A success URL can be replayed. Do not replace a different
			// subscription the organization already has. Do not run duplicate
			// cleanup here: it can cancel the org's recorded subscription while
			// leaving the row unchanged.
			return redirect(`/${current.slug}/dashboard`)
		}

		const [tenant] = await db
			.update(Organization)
			.set({
				stripeCustomerId: customerId,
				stripeSubscriptionId: subscriptionId,
				stripeProductId: productId,
				planName: (plan.product as Stripe.Product).name,
				subscriptionStatus: subscription.status,
				updatedAt: new Date(),
			})
			.where(eq(Organization.id, organizationId))
			.returning({ slug: Organization.slug })
		if (!tenant) throw new Error('Tenant not found in database.')

		// Cancel and refund any duplicate subscriptions from concurrent checkouts
		try {
			const cleanup = await cleanupDuplicateSubscriptions(
				deps.stripe,
				customerId,
			)
			if (
				cleanup.keptSubscriptionId &&
				cleanup.keptSubscriptionId !== subscriptionId
			) {
				// A newer subscription won the dedup — sync org to the kept one
				const keptSubscription = await deps.stripe.subscriptions.retrieve(
					cleanup.keptSubscriptionId,
					{ expand: ['items.data.price.product'] },
				)
				const keptPlan = keptSubscription.items.data[0]?.price
				const keptProductId = keptPlan
					? (keptPlan.product as Stripe.Product).id
					: productId
				await db
					.update(Organization)
					.set({
						stripeSubscriptionId: cleanup.keptSubscriptionId,
						stripeProductId: keptProductId,
						planName: keptPlan
							? (keptPlan.product as Stripe.Product).name
							: (plan.product as Stripe.Product).name,
						subscriptionStatus: keptSubscription.status,
						updatedAt: new Date(),
					})
					.where(eq(Organization.id, organizationId))
			}
		} catch (error) {
			console.error('Error cleaning up duplicate subscriptions:', error)
		}

		const isCreationFlow = session.metadata?.isCreationFlow === 'true'

		if (isCreationFlow) {
			return redirect(`/organizations/create?step=3&orgId=${organizationId}`)
		}

		return redirect(`/${tenant.slug}/dashboard`)
	} catch (error) {
		console.error('Error handling successful checkout:', error)
		return redirect('/error')
	}
}
