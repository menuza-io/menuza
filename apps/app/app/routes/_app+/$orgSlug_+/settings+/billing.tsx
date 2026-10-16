import { requireUserId } from '@repo/auth'
import { db, eq, Organization } from '@repo/database'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useLoaderData,
} from 'react-router'

import { BillingCard } from '#app/components/settings/cards/organization/billing-card.tsx'
import { InvoicesCard } from '#app/components/settings/cards/organization/invoices-card.tsx'

import { getLaunchStatus } from '#app/utils/env.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	checkoutAction,
	customerPortalAction,
	getPlansAndPrices,
	getOrganizationInvoices,
} from '#app/utils/payments.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)

	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
		size: true,
		stripeCustomerId: true,
		stripeSubscriptionId: true,
		stripeProductId: true,
		planName: true,
		subscriptionStatus: true,
	})

	// Block access to billing page for PUBLIC_BETA and CLOSED_BETA
	// EXCEPT for organizations with existing active subscriptions (grandfathered)
	const launchStatus = getLaunchStatus()
	const hasActiveSubscription = Boolean(
		organization.stripeSubscriptionId &&
		organization.subscriptionStatus === 'active',
	)

	if (
		!hasActiveSubscription &&
		(launchStatus === 'PUBLIC_BETA' || launchStatus === 'CLOSED_BETA')
	) {
		throw new Response('Not Found', { status: 404 })
	}

	// Fetch plans (will be null if in beta and no active subscription)
	const shouldFetchPlans = launchStatus === 'LAUNCHED' || hasActiveSubscription
	let plansAndPrices: Awaited<ReturnType<typeof getPlansAndPrices>> | null =
		null
	let plansUnavailable = false
	if (shouldFetchPlans) {
		try {
			plansAndPrices = await getPlansAndPrices()
		} catch (error) {
			console.error('Failed to load billing plans:', error)
			plansUnavailable = true
		}
	}

	let invoices: Awaited<ReturnType<typeof getOrganizationInvoices>> = []
	let invoicesUnavailable = false
	try {
		invoices = await getOrganizationInvoices(organization)
	} catch (error) {
		console.error('Failed to load invoices:', error)
		invoicesUnavailable = true
	}

	// Get current subscription price ID for accurate plan detection
	let currentPriceId: string | null = null
	if (organization.stripeSubscriptionId) {
		try {
			const { stripe } = await import('#app/utils/payments.server.ts')
			const subscription = await stripe.subscriptions.retrieve(
				organization.stripeSubscriptionId,
			)
			currentPriceId = subscription.items.data[0]?.price.id || null
		} catch (error) {
			console.error('Error fetching current subscription:', error)
		}
	}

	return {
		organization,
		plansAndPrices,
		plansUnavailable,
		invoices,
		invoicesUnavailable,
		currentPriceId,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
		stripeSubscriptionId: true,
		subscriptionStatus: true,
	})

	// Block access to billing actions for PUBLIC_BETA and CLOSED_BETA
	// EXCEPT for organizations with existing active subscriptions (grandfathered)
	const launchStatus = getLaunchStatus()
	const hasActiveSubscription = Boolean(
		organization.stripeSubscriptionId &&
		organization.subscriptionStatus === 'active',
	)

	if (
		!hasActiveSubscription &&
		(launchStatus === 'PUBLIC_BETA' || launchStatus === 'CLOSED_BETA')
	) {
		throw new Response('Not Found', { status: 404 })
	}

	const formData = await request.formData()
	const intent = formData.get('intent')
	const priceId = formData.get('priceId') as string | null

	// Fetch full organization data with billing fields for payment actions
	const [organizationWithBilling] = await db
		.select()
		.from(Organization)
		.where(eq(Organization.id, organization.id))
		.limit(1)

	if (!organizationWithBilling) {
		return Response.json({ error: 'Organization not found' }, { status: 404 })
	}

	if (intent === 'upgrade') {
		return checkoutAction(
			request,
			organizationWithBilling,
			priceId ?? undefined,
		)
	}

	if (intent === 'customer-portal') {
		return customerPortalAction(request, organizationWithBilling)
	}

	return Response.json({ error: `Invalid intent: ${intent}` }, { status: 400 })
}

export default function BillingSettings() {
	const {
		organization,
		plansAndPrices,
		plansUnavailable,
		invoices,
		invoicesUnavailable,
		currentPriceId,
	} = useLoaderData<typeof loader>()

	return (
		<AnnotatedLayout>
			<AnnotatedSection>
				<BillingCard
					organization={organization}
					plansAndPrices={plansAndPrices}
					plansUnavailable={plansUnavailable}
					currentPriceId={currentPriceId}
				/>
			</AnnotatedSection>

			<AnnotatedSection>
				<InvoicesCard
					invoices={invoices}
					invoicesUnavailable={invoicesUnavailable}
				/>
			</AnnotatedSection>
		</AnnotatedLayout>
	)
}
