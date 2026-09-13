/**
 * Payment utilities for the app
 * Uses @repo/payments for provider abstraction
 */

import { requireUserId } from '@repo/auth'
import {
	and,
	count,
	db,
	eq,
	isNull,
	Organization as OrganizationTable,
	OrganizationRole,
	User,
	UserOrganization,
} from '@repo/database'
import { type Organization } from '@repo/database/types'
import { sendEmail, TrialEndingEmail } from '@repo/email'
import {
	cleanupDuplicateSubscriptions as cleanupDuplicateStripeSubscriptions,
	createStripeProvider,
	getTrialConfig,
	calculateManualTrialDaysRemaining,
} from '@repo/payments'
import { data, redirect } from 'react-router'
import { getDomainUrl } from '../../../../packages/common/src/misc'

if (!process.env.STRIPE_SECRET_KEY) {
	const errorMsg = 'STRIPE_SECRET_KEY environment variable is not set!'
	throw new Error(errorMsg)
}

// Create payment provider instance
const paymentProvider = createStripeProvider(process.env.STRIPE_SECRET_KEY)

// Export for advanced usage
export const stripe = paymentProvider.getClient()

// Re-export trial config functions
export { getTrialConfig, calculateManualTrialDaysRemaining }

/**
 * Get plans and prices from payment provider
 */
export async function getPlansAndPrices() {
	return paymentProvider.getPlansAndPrices()
}

/**
 * Get Stripe products (for backwards compatibility)
 */
export async function getStripeProducts() {
	return paymentProvider.getProducts()
}

/**
 * Get Stripe prices (for backwards compatibility)
 */
export async function getStripePrices() {
	const prices = await paymentProvider.getPrices()
	// Map to include additional properties for backwards compatibility
	return prices.map((price) => ({
		...price,
		productId: price.productId,
		unitAmount: price.unitAmount,
		interval: price.interval,
		trialPeriodDays: price.trialPeriodDays,
	}))
}

/**
 * Database operations
 */

export async function getOrganizationByStripeCustomerId(customerId: string) {
	const [result] = await db
		.select()
		.from(OrganizationTable)
		.where(eq(OrganizationTable.stripeCustomerId, customerId))
		.limit(1)
	return result || null
}

export async function updateOrganizationSubscription(
	organizationId: string,
	subscriptionData: {
		stripeSubscriptionId: string | null
		stripeProductId: string | null
		planName: string | null
		subscriptionStatus: string
	},
) {
	await db
		.update(OrganizationTable)
		.set({
			...subscriptionData,
			updatedAt: new Date(),
		})
		.where(eq(OrganizationTable.id, organizationId))
}

/**
 * Subscription management
 */

export async function upgradeSubscription(
	organization: Organization,
	newPriceId: string,
) {
	if (!organization.stripeCustomerId || !organization.stripeSubscriptionId) {
		throw new Error('Organization must have existing subscription to upgrade')
	}

	const quantity = await getOrganizationSeatQuantity(organization.id)

	// Get current subscription
	const subscription = await paymentProvider.retrieveSubscription(
		organization.stripeSubscriptionId,
	)

	// Preserve trial period if the subscription is currently trialing
	const preserveTrialEnd = subscription.status === 'trialing'

	// Update the subscription to the new price
	const updatedSubscription = await paymentProvider.updateSubscription({
		subscriptionId: organization.stripeSubscriptionId,
		priceId: newPriceId,
		quantity,
		preserveTrialEnd,
		prorationBehavior: 'create_prorations',
	})

	// Update organization with new subscription details
	// Get product details from Stripe
	const products = await paymentProvider.getProducts()
	const product = products.find((p) => p.id === updatedSubscription.productId)

	await updateOrganizationSubscription(organization.id, {
		stripeSubscriptionId: updatedSubscription.id,
		stripeProductId: updatedSubscription.productId,
		planName: product?.name || null,
		subscriptionStatus: updatedSubscription.status,
	})

	return updatedSubscription
}

export async function createCheckoutSession(
	request: Request,
	{
		organization,
		priceId,
		from,
		isCreationFlow = false,
	}: {
		organization: Organization | null
		priceId: string
		from: 'checkout' | 'pricing'
		isCreationFlow?: boolean
	},
) {
	const userId = await requireUserId(request)

	const trialConfig = getTrialConfig()

	if (from === 'pricing' && trialConfig.creditCardRequired === 'manual') {
		return redirect('/signup')
	}

	if (!organization || !userId) {
		return redirect(`/signup?redirect=checkout&priceId=${priceId}`)
	}

	// Check if organization has existing active subscription
	if (organization.stripeCustomerId && from === 'checkout') {
		try {
			const subscriptions = await paymentProvider.listSubscriptions(
				organization.stripeCustomerId,
			)

			const activeOrTrialing = subscriptions.filter(
				(sub) => sub.status === 'active' || sub.status === 'trialing',
			)

			if (activeOrTrialing.length > 0) {
				const subscriptionToUpgrade =
					activeOrTrialing.find(
						(sub) => sub.id === organization.stripeSubscriptionId,
					) ?? activeOrTrialing[0]

				if (subscriptionToUpgrade) {
					const orgForUpgrade =
						organization.stripeSubscriptionId === subscriptionToUpgrade.id
							? organization
							: {
									...organization,
									stripeSubscriptionId: subscriptionToUpgrade.id,
								}

					await upgradeSubscription(orgForUpgrade, priceId)
					return data({ success: true })
				}
			}
		} catch (error) {
			console.error('Error checking existing subscription:', error)
			// Continue with checkout if we can't retrieve subscription
		}
	}

	const quantity = await getOrganizationSeatQuantity(organization.id)

	let testCustomerId: string | undefined

	// Create test customer in non-production environments
	if (
		process.env.NODE_ENV !== 'production' &&
		paymentProvider.createTestClock &&
		paymentProvider.createTestCustomer
	) {
		try {
			const testClock = await paymentProvider.createTestClock()
			const testCustomer = await paymentProvider.createTestCustomer(
				testClock.id,
			)
			testCustomerId = testCustomer.id
		} catch {
			// Ignore test customer creation errors
		}
	}

	const trialPeriodDays =
		trialConfig.creditCardRequired === 'manual'
			? (() => {
					if (!organization.createdAt) return undefined
					const daysRemaining = calculateManualTrialDaysRemaining(
						organization.createdAt,
					)
					return daysRemaining > 0 ? daysRemaining : undefined
				})()
			: trialConfig.trialDays

	const session = await paymentProvider.createCheckoutSession({
		priceId,
		quantity,
		successUrl: `${getDomainUrl(request)}/api/stripe/checkout?session_id={CHECKOUT_SESSION_ID}`,
		cancelUrl:
			from === 'checkout'
				? `${getDomainUrl(request)}/${organization.slug}/settings/billing`
				: `${getDomainUrl(request)}/pricing`,
		customerId: organization.stripeCustomerId || testCustomerId || undefined,
		clientReferenceId: userId.toString(),
		allowPromotionCodes: true,
		trialPeriodDays,
		paymentMethodCollection:
			trialConfig.creditCardRequired === 'stripe' ? 'if_required' : 'always',
		metadata: {
			organizationId: organization.id,
			isCreationFlow: isCreationFlow ? 'true' : 'false',
		},
		idempotencyKey: `checkout-${organization.id}-${priceId}`,
	})

	return redirect(session.url!)
}

export async function deleteSubscription(subscriptionId: string) {
	await paymentProvider.cancelSubscription(subscriptionId)
}

export async function createCustomerPortalSession(
	request: Request,
	organization: Organization,
) {
	if (!organization.stripeCustomerId || !organization.stripeProductId) {
		return redirect('/pricing')
	}

	return paymentProvider.createCustomerPortalSession({
		customerId: organization.stripeCustomerId,
		returnUrl: `${getDomainUrl(request)}/${organization.slug}/settings`,
		productId: organization.stripeProductId,
	})
}

export async function handleSubscriptionChange(subscription: {
	id: string
	status: string
	customer: string
	items: Array<{
		price: { id: string; product: string }
	}>
}) {
	const customerId = subscription.customer
	const subscriptionId = subscription.id
	const status = subscription.status

	const organization = await getOrganizationByStripeCustomerId(customerId)

	if (!organization) {
		return
	}

	if (status === 'active' || status === 'trialing') {
		const productId = subscription.items[0]?.price.product
		const previousSubscriptionId = organization.stripeSubscriptionId

		// Get the product before changing local subscription state. A provider
		// failure must not leave a partially updated organization record.
		const products = await paymentProvider.getProducts()
		const product = products.find((p) => p.id === productId)

		// Persist the new subscription before cancelling an old one. The Stripe
		// cancellation is external to the database transaction, so ordering it
		// first could leave the organization with no recorded active subscription.
		await updateOrganizationSubscription(organization.id, {
			stripeSubscriptionId: subscriptionId,
			stripeProductId: productId || null,
			planName: product?.name || null,
			subscriptionStatus: status,
		})

		// If this is a new active subscription and the organization has a different subscription ID,
		// cancel the old one to prevent multiple active subscriptions
		if (previousSubscriptionId && previousSubscriptionId !== subscriptionId) {
			try {
				await paymentProvider.cancelSubscription(previousSubscriptionId)
			} catch (error) {
				console.error('Error cancelling old subscription:', error)
			}
		}
	} else if (status === 'canceled' || status === 'unpaid') {
		// Only update to null if this is the current subscription
		if (organization.stripeSubscriptionId === subscriptionId) {
			await updateOrganizationSubscription(organization.id, {
				stripeSubscriptionId: null,
				stripeProductId: null,
				planName: null,
				subscriptionStatus: status,
			})
		}
	}
}

export async function handleTrialEnd(subscription: {
	id: string
	customer: string
	trial_end?: number | null
}) {
	const customerId = subscription.customer

	const organization = await getOrganizationByStripeCustomerId(customerId)

	if (!organization) {
		return
	}

	const admins = await db
		.select({ user: User })
		.from(UserOrganization)
		.innerJoin(
			OrganizationRole,
			eq(UserOrganization.organizationRoleId, OrganizationRole.id),
		)
		.innerJoin(User, eq(UserOrganization.userId, User.id))
		.where(
			and(
				eq(UserOrganization.organizationId, organization.id),
				eq(OrganizationRole.name, 'admin'),
				isNull(OrganizationRole.organizationId),
			),
		)

	// Calculate actual days remaining from trial end date
	const trialEnd = subscription.trial_end
		? new Date(subscription.trial_end * 1000)
		: null
	const now = new Date()
	const daysRemaining = trialEnd
		? Math.ceil((trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
		: 3 // fallback to 3 days if trial_end is not available

	await Promise.all(
		admins.map(async (admin) => {
			const user = admin.user
			if (!user) {
				return
			}
			await sendEmail({
				to: user.email,
				subject: 'Trial Ending Soon',
				react: TrialEndingEmail({
					portalUrl: process.env.STRIPE_PORTAL_URL!,
					userName: user.name || undefined,
					daysRemaining: Math.max(0, daysRemaining), // Ensure non-negative
				}),
			})
		}),
	)
}

export async function getTrialStatus(userId: string, organizationSlug: string) {
	try {
		const [user] = await db
			.select()
			.from(User)
			.where(eq(User.id, userId))
			.limit(1)

		const [organization] = await db
			.select()
			.from(OrganizationTable)
			.where(eq(OrganizationTable.slug, organizationSlug))
			.limit(1)

		const trialConfig = getTrialConfig()

		if (!organization) {
			return { isActive: false, daysRemaining: 0 }
		}

		// Paid subscription takes precedence over manual app-enforced trial
		if (
			organization.stripeCustomerId &&
			organization.stripeSubscriptionId &&
			(organization.subscriptionStatus === 'active' ||
				organization.subscriptionStatus === 'trialing')
		) {
			if (organization.subscriptionStatus === 'active') {
				return { isActive: true, daysRemaining: 0 }
			}

			const subscription = await paymentProvider.retrieveSubscription(
				organization.stripeSubscriptionId,
			)

			if (subscription.status === 'trialing' && subscription.trialEnd) {
				const daysRemaining = Math.ceil(
					(subscription.trialEnd.getTime() - Date.now()) /
						(1000 * 60 * 60 * 24),
				)
				return { isActive: true, daysRemaining: Math.max(0, daysRemaining) }
			}

			return { isActive: true, daysRemaining: 0 }
		}

		if (trialConfig.creditCardRequired === 'manual') {
			if (!organization.createdAt) {
				return { isActive: false, daysRemaining: 0 }
			}

			const daysRemaining = calculateManualTrialDaysRemaining(
				organization.createdAt,
			)
			return {
				isActive: daysRemaining > 0,
				daysRemaining,
			}
		}

		if (!user || !organization.stripeCustomerId) {
			return { isActive: false, daysRemaining: 0 }
		}

		const subscriptions = await paymentProvider.listSubscriptions(
			organization.stripeCustomerId,
		)

		if (subscriptions.length === 0) {
			return { isActive: false, daysRemaining: 0 }
		}

		const subscription = subscriptions[0]

		if (subscription && subscription.status === 'trialing') {
			const trialEnd = subscription.trialEnd
			if (!trialEnd) {
				return { isActive: false, daysRemaining: 0 }
			}
			const now = new Date()
			const daysRemaining = Math.ceil(
				(trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
			)

			return { isActive: true, daysRemaining }
		} else if (subscription && subscription.status === 'active') {
			return { isActive: true, daysRemaining: 0 }
		} else {
			return { isActive: false, daysRemaining: 0 }
		}
	} catch {
		throw new Error('Failed to fetch subscription status')
	}
}

const getOrganizationSeatQuantity = async (organizationId: string) => {
	const [row] = await db
		.select({ value: count() })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
			),
		)
	return row?.value ?? 0
}

const seatUpdateQueues = new Map<string, Promise<unknown>>()

export const updateSeatQuantity = async (organizationId: string) => {
	const [organization] = await db
		.select()
		.from(OrganizationTable)
		.where(eq(OrganizationTable.id, organizationId))
		.limit(1)
	if (!organization?.stripeSubscriptionId) {
		// No subscription to update - return early
		return null
	}

	const stripeSubscriptionId = organization.stripeSubscriptionId
	const previous = seatUpdateQueues.get(organizationId) ?? Promise.resolve()
	const run = previous.then(
		() => syncSeatQuantity(organizationId, stripeSubscriptionId),
		() => syncSeatQuantity(organizationId, stripeSubscriptionId),
	)
	seatUpdateQueues.set(
		organizationId,
		run.then(
			() => undefined,
			() => undefined,
		),
	)
	return run
}

async function syncSeatQuantity(
	organizationId: string,
	stripeSubscriptionId: string,
) {
	let lastResult: Awaited<
		ReturnType<typeof paymentProvider.updateSubscription>
	> | null = null

	// Re-count after each Stripe write so concurrent accepts cannot leave
	// quantity stuck on a stale snapshot (last-write-wins).
	for (let attempt = 0; attempt < 3; attempt++) {
		const numUsersInOrganization =
			await getOrganizationSeatQuantity(organizationId)

		const subscription =
			await paymentProvider.retrieveSubscription(stripeSubscriptionId)

		if (subscription.items.length !== 1) {
			throw new Error('Subscription does not have exactly 1 item')
		}

		const firstItem = subscription.items[0]
		if (!firstItem) {
			throw new Error('Subscription item not found')
		}

		lastResult = await paymentProvider.updateSubscription({
			subscriptionId: stripeSubscriptionId,
			priceId: firstItem.priceId,
			quantity: numUsersInOrganization,
		})

		const recount = await getOrganizationSeatQuantity(organizationId)
		if (recount === numUsersInOrganization) {
			return lastResult
		}
	}

	return lastResult
}

export const checkoutAction = async (
	request: Request,
	organization: Organization,
	priceIdArg?: string,
) => {
	let priceId: string | undefined | null = priceIdArg
	if (!priceId) {
		const formData = await request.formData()
		priceId = formData.get('priceId') as string | null
	}
	if (!priceId) throw new Response('priceId is required', { status: 400 })

	return createCheckoutSession(request, {
		organization,
		priceId,
		from: 'checkout',
	})
}

export const customerPortalAction = async (
	request: Request,
	organization: Organization,
) => {
	const portalSession = await createCustomerPortalSession(request, organization)
	return redirect(portalSession.url)
}

export async function getOrganizationInvoices(organization: {
	stripeCustomerId: string | null
}) {
	if (!organization.stripeCustomerId) {
		return []
	}

	return paymentProvider.listInvoices(organization.stripeCustomerId, 20)
}

export async function cleanupDuplicateSubscriptions(
	organization: Organization,
) {
	if (!organization.stripeCustomerId) {
		return
	}

	try {
		const cleanup = await cleanupDuplicateStripeSubscriptions(
			stripe,
			organization.stripeCustomerId,
		)

		if (!cleanup.keptSubscriptionId) {
			return
		}

		const subscriptions = await paymentProvider.listSubscriptions(
			organization.stripeCustomerId,
		)
		const keepSubscription = subscriptions.find(
			(sub) => sub.id === cleanup.keptSubscriptionId,
		)

		if (!keepSubscription) {
			return
		}

		const products = await paymentProvider.getProducts()
		const product = products.find((p) => p.id === keepSubscription.productId)

		await updateOrganizationSubscription(organization.id, {
			stripeSubscriptionId: keepSubscription.id,
			stripeProductId: keepSubscription.productId,
			planName: product?.name || null,
			subscriptionStatus: keepSubscription.status,
		})
	} catch (error) {
		console.error('Error cleaning up duplicate subscriptions:', error)
	}
}
