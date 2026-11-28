import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	data,
	useActionData,
	useLoaderData,
} from 'react-router'
import { CancelRequestForm } from '#app/components/billing/cancel-request-form.tsx'
import {
	createCancelRequest,
	loadCancelRequestContext,
	withdrawCancelRequest,
} from '#app/utils/billing/cancel-request.server.ts'
import { billingPath } from '#app/utils/billing/past-due.ts'
import { getLaunchStatus } from '#app/utils/env.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { hasLiveSubscription } from '#app/utils/payments.server.ts'

const COLUMNS = {
	id: true,
	name: true,
	slug: true,
	stripeSubscriptionId: true,
	subscriptionStatus: true,
	stripeProductId: true,
} as const

async function guard(request: Request, orgSlug: string | undefined) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, orgSlug, COLUMNS)
	// Same gate as the billing page: beta organizations without a subscription
	// have nothing to cancel.
	const launchStatus = getLaunchStatus()
	if (
		!hasLiveSubscription(organization) &&
		(launchStatus === 'PUBLIC_BETA' || launchStatus === 'CLOSED_BETA')
	) {
		throw new Response('Not Found', { status: 404 })
	}
	const userId = await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	return { organization, userId }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const { organization } = await guard(request, params.orgSlug)
	if (!hasLiveSubscription(organization)) {
		throw new Response('Not Found', { status: 404 })
	}
	const context = await loadCancelRequestContext(organization)
	const base = `/${organization.slug}`
	return {
		orgSlug: organization.slug,
		context,
		// What the owner may want to keep: the screens that already export it.
		downloads: [
			{ key: 'menu', href: `${base}/menu/export` },
			{ key: 'customers', href: `${base}/customers` },
			{ key: 'reports', href: `${base}/reports` },
			{ key: 'website', href: `${base}/website/export` },
		],
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const { organization, userId } = await guard(request, params.orgSlug)
	const form = await request.formData()
	const intent = form.get('intent')
	const back = billingPath(organization.slug)

	if (intent === 'withdraw') {
		const requestId = String(form.get('requestId') ?? '')
		const done = await withdrawCancelRequest({
			organizationId: organization.id,
			requestId,
			userId,
			request,
		})
		return redirectWithToast(back, {
			type: done ? 'success' : 'error',
			title: done ? 'Request withdrawn' : 'Nothing to withdraw',
			description: done
				? 'Nothing was changed. Your subscription carries on as before.'
				: 'That request is not open any more.',
		})
	}

	if (intent !== 'request') {
		return data({ error: 'invalid' }, { status: 400 })
	}
	const result = await createCancelRequest({
		organization,
		userId,
		request,
		body: {
			kind: form.get('kind'),
			locationIds: form.getAll('locationIds').map(String),
			targetPlan: form.get('targetPlan') || null,
			reason: form.get('reason'),
			subReason: form.get('subReason') || null,
			note: form.get('note') || null,
			confirm: form.get('confirm') === 'true',
		},
	})
	if (!result.ok) {
		return data(
			{ error: result.error },
			{ status: result.error === 'invalid' ? 400 : 409 },
		)
	}
	return redirectWithToast(back, {
		type: 'success',
		title: 'Request sent',
		description:
			'Nothing was cancelled. It takes effect at the end of your billing period, and you can withdraw it until then.',
	})
}

export default function BillingCancelPage() {
	const { _ } = useLingui()
	const { orgSlug, context, downloads } = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const labels: Record<string, string> = {
		menu: _(msg`Download your menu`),
		customers: _(msg`Export your customer list`),
		reports: _(msg`Export your reports`),
		website: _(msg`Export your website`),
	}
	return (
		<AnnotatedLayout>
			<AnnotatedSection>
				<Card>
					<CardHeader>
						<CardTitle>
							<Trans>Cancel or downgrade</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>
								Tell us what you want to change and why. This is a request: it
								takes effect at the end of your billing period.
							</Trans>
						</CardDescription>
					</CardHeader>
					<CardContent>
						<CancelRequestForm
							context={context}
							downloads={downloads.map((item) => ({
								label: labels[item.key] ?? item.key,
								href: item.href,
							}))}
							billingHref={billingPath(orgSlug)}
							error={actionData?.error ?? null}
						/>
					</CardContent>
				</Card>
			</AnnotatedSection>
		</AnnotatedLayout>
	)
}
