import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { CampaignDetailView, type CampaignDetail } from '@repo/marketing'
import { Skeleton } from '@repo/ui/skeleton'
import { useEffect, useState } from 'react'
import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { type BreadcrumbHandle } from '#app/utils/breadcrumb.ts'
import { describeCampaignCoupon } from '#app/utils/discounts/marketing-offers.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

export const handle: BreadcrumbHandle<Awaited<ReturnType<typeof loader>>> = {
	breadcrumb: (data) => data.name ?? undefined,
}

/**
 * The recipient list holds guest names, emails and phones, which live in the
 * organization's region. The App server only reads the campaign summary (name
 * and coupon offer ids, no recipients) to describe the coupon from
 * control-plane discount names; the browser reads the campaign and its
 * recipients from tenant-api directly with the Marketing token
 * (docs/tenant-data-residency.md).
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const campaignId = params.campaignId || ''
	const { orgId, jwt, tenantApiUrl, fetchTenant } =
		await getOperatorTenantClient(request, orgSlug, { area: 'marketing' })

	const userId = await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
	)

	let name: string | null = null
	let coupon: CampaignDetail['coupon'] = null
	const res = await fetchTenant(
		`/operator/marketing/campaigns/${encodeURIComponent(campaignId)}/summary`,
	).catch(() => null)
	if (res?.ok) {
		const data = (await res.json()) as {
			campaign?: { name?: string; discountOffer?: unknown }
		}
		name = data.campaign?.name ?? null
		coupon = await describeCampaignCoupon(orgId, data.campaign?.discountOffer, {
			userId,
		})
	}

	return { jwt, tenantApiUrl, campaignId, name, coupon }
}

type CampaignState =
	| { status: 'loading' }
	| { status: 'not_found' }
	| { status: 'failed' }
	| { status: 'ready'; campaign: CampaignDetail }

export default function CampaignDetailRoute() {
	const { _ } = useLingui()
	const { jwt, tenantApiUrl, campaignId, coupon } =
		useLoaderData<typeof loader>()
	const [state, setState] = useState<CampaignState>({ status: 'loading' })

	useEffect(() => {
		const controller = new AbortController()
		setState({ status: 'loading' })
		async function load() {
			try {
				const res = await fetch(
					`${tenantApiUrl}/operator/marketing/campaigns/${encodeURIComponent(campaignId)}`,
					{
						headers: { Authorization: `Bearer ${jwt}` },
						signal: controller.signal,
					},
				)
				if (!res.ok) {
					setState({ status: res.status === 404 ? 'not_found' : 'failed' })
					return
				}
				const data = (await res.json()) as {
					campaign?: CampaignDetail & { discountOffer?: unknown }
				}
				if (!data.campaign) {
					setState({ status: 'not_found' })
					return
				}
				const { discountOffer: _offer, ...campaign } = data.campaign
				setState({ status: 'ready', campaign: { ...campaign, coupon } })
			} catch {
				if (!controller.signal.aborted) setState({ status: 'failed' })
			}
		}
		void load()
		return () => controller.abort()
	}, [jwt, tenantApiUrl, campaignId, coupon])

	if (state.status === 'loading') {
		return (
			<div className="space-y-4" aria-busy="true">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-32 w-full rounded-lg" />
				<Skeleton className="h-48 w-full rounded-lg" />
			</div>
		)
	}

	if (state.status !== 'ready') {
		return (
			<p className="text-destructive text-sm">
				{state.status === 'not_found'
					? _(msg`Broadcast not found`)
					: _(msg`Failed to load broadcast`)}
			</p>
		)
	}

	return <CampaignDetailView campaign={state.campaign} />
}
