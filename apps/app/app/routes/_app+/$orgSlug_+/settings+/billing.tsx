import { requireUserId } from '@repo/auth'
import { db, eq, Organization } from '@repo/database'
import { smsUsageByLocation } from '@repo/marketing/server/sms-allowance'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useLoaderData,
} from 'react-router'

import { BillingCard } from '#app/components/settings/cards/organization/billing-card.tsx'
import {
	KeptByDirectCard,
	type KeptByDirectView,
} from '#app/components/settings/cards/organization/kept-by-direct-card.tsx'
import { InvoicesCard } from '#app/components/settings/cards/organization/invoices-card.tsx'
import { MarketingTextsCard } from '#app/components/settings/cards/organization/marketing-texts-card.tsx'

import { lastCompleteMonthKey } from '@repo/reports'
import { getLaunchStatus } from '#app/utils/env.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'
import {
	checkoutAction,
	customerPortalAction,
	getPlansAndPrices,
	getOrganizationInvoices,
	hasLiveSubscription,
} from '#app/utils/payments.server.ts'
import { defaultReportingTimeZone } from '#app/utils/reports/schedules.server.ts'
import { resolveReportTokenGrants } from '#app/utils/reports/token-grants.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)

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
		dataRegion: true,
		hasProvisionedDb: true,
		deliveryCommissionBp: true,
	})

	// Block access to billing page for PUBLIC_BETA and CLOSED_BETA
	// EXCEPT for organizations with existing active subscriptions (grandfathered)
	const launchStatus = getLaunchStatus()
	// Past due or paused still counts: the organization must be able to pay.
	const hasActiveSubscription = hasLiveSubscription(organization)

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

	// Marketing text sends used this month, per location (#247). Numbers only.
	const { allowance, locations } = await smsUsageByLocation(organization.id)
	const smsUsage = {
		periodKey: allowance.periodKey,
		limit: allowance.limit,
		extra: allowance.extra,
		used: allowance.used,
		remaining: allowance.remaining,
		resetsAt: allowance.resetsAt,
		locations,
	}

	// What ordering direct kept last month (#221), next to the plan price: only
	// for members whose reports token covers sales, read from the region by the
	// browser. An estimate; the rate is the organization's own.
	let keptByDirect: KeptByDirectView | null = null
	if (organization.hasProvisionedDb) {
		const grants = await resolveReportTokenGrants({
			request,
			userId,
			organizationId: organization.id,
		})
		if (grants.subjects.includes('sales')) {
			keptByDirect = {
				orgSlug: organization.slug,
				month: lastCompleteMonthKey(new Date()),
				timeZone: await defaultReportingTimeZone(organization.id),
				tokenUrl: `/${organization.slug}/reports/token`,
				tenantApiUrl: resolveRegionalTenantApiUrls(organization.dataRegion)
					.tenantApiUrl,
				commissionBp: organization.deliveryCommissionBp,
			}
		}
	}

	return {
		organization,
		plansAndPrices,
		plansUnavailable,
		invoices,
		invoicesUnavailable,
		currentPriceId,
		smsUsage,
		keptByDirect,
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
	// Past due or paused still counts: the organization must be able to pay.
	const hasActiveSubscription = hasLiveSubscription(organization)

	if (
		!hasActiveSubscription &&
		(launchStatus === 'PUBLIC_BETA' || launchStatus === 'CLOSED_BETA')
	) {
		throw new Response('Not Found', { status: 404 })
	}

	// Changing the plan or opening the billing portal is an admin operation.
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)

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
		smsUsage,
		keptByDirect,
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

			{keptByDirect ? (
				<AnnotatedSection>
					<KeptByDirectCard view={keptByDirect} />
				</AnnotatedSection>
			) : null}

			<AnnotatedSection>
				<MarketingTextsCard usage={smsUsage} />
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
