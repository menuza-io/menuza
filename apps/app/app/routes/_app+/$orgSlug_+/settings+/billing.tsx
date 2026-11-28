import { AuditAction, auditService } from '@repo/audit'
import { requireUserId, userHasOrganizationPermission } from '@repo/auth'
import { db, eq, Organization } from '@repo/database'
import { smsUsageByLocation } from '@repo/marketing/server/sms-allowance'
import { lastCompleteMonthKey } from '@repo/reports'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useLoaderData,
} from 'react-router'

import { ChangeRequestCard } from '#app/components/billing/change-request-card.tsx'
import {
	PastDueCard,
	type PastDueView,
} from '#app/components/billing/past-due-card.tsx'
import { BillingCard } from '#app/components/settings/cards/organization/billing-card.tsx'
import { InvoicesCard } from '#app/components/settings/cards/organization/invoices-card.tsx'
import {
	KeptByDirectCard,
	type KeptByDirectView,
} from '#app/components/settings/cards/organization/kept-by-direct-card.tsx'
import { MarketingTextsCard } from '#app/components/settings/cards/organization/marketing-texts-card.tsx'

import { loadOpenChangeRequest } from '#app/utils/billing/cancel-request.server.ts'
import { daysOverdue, isPastDueStatus } from '#app/utils/billing/past-due.ts'
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
	loadBillingIssue,
	retryBillingPayment,
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
		pastDueSince: true,
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

	// Past due (#237): the open invoice and each failed attempt, read live from
	// the provider. Shown to the people who can retry (the page's actions need
	// the same `update:settings:any`).
	const canManageBilling = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	let pastDue: PastDueView | null = null
	if (isPastDueStatus(organization.subscriptionStatus) && canManageBilling) {
		pastDue = {
			since: organization.pastDueSince?.toISOString() ?? null,
			daysOverdue: daysOverdue(organization.pastDueSince),
			issue: await loadBillingIssue(organization),
		}
	}

	// Cancel or downgrade (#379): a request that takes effect at period end, for
	// the people who can change the subscription and while there is one to change.
	const changeRequest =
		canManageBilling && hasActiveSubscription
			? { open: await loadOpenChangeRequest(organization.id) }
			: null

	return {
		organization,
		pastDue,
		changeRequest,
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
	const actorId = await requireUserWithOrganizationPermission(
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

	// Retry the failed subscription payment (#237): pays the open invoice only,
	// once a minute, and never changes the plan.
	if (intent === 'retry-payment') {
		const result = await retryBillingPayment(organizationWithBilling)
		await auditService.log({
			action: AuditAction.ORG_SETTINGS_UPDATED,
			userId: actorId,
			organizationId: organization.id,
			resourceType: 'organization',
			resourceId: organization.id,
			details: 'Billing payment retried',
			// The outcome only: never a card, an invoice id or an amount.
			metadata: { outcome: result.status },
			request,
		})
		return Response.json({
			retry:
				result.status === 'rate_limited'
					? { status: result.status, retryAt: result.retryAt.toISOString() }
					: result,
		})
	}

	return Response.json({ error: `Invalid intent: ${intent}` }, { status: 400 })
}

export default function BillingSettings() {
	const {
		organization,
		pastDue,
		changeRequest,
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
			{pastDue ? (
				<AnnotatedSection>
					<PastDueCard view={pastDue} retry={null} />
				</AnnotatedSection>
			) : null}
			<AnnotatedSection>
				<BillingCard
					organization={organization}
					plansAndPrices={plansAndPrices}
					plansUnavailable={plansUnavailable}
					currentPriceId={currentPriceId}
				/>
			</AnnotatedSection>

			{changeRequest ? (
				<AnnotatedSection>
					<ChangeRequestCard
						orgSlug={organization.slug}
						open={changeRequest.open}
					/>
				</AnnotatedSection>
			) : null}

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
