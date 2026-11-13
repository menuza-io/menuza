import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { CampaignDetailView, type CampaignDetail } from '@repo/marketing'
import { Skeleton } from '@repo/ui/skeleton'
import { useEffect, useState } from 'react'
import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { useLoaderToken } from '#app/hooks/use-loader-token.ts'
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
	| { status: 'ready'; campaign: Omit<CampaignDetail, 'coupon'> }

export default function CampaignDetailRoute() {
	const { _ } = useLingui()
	const { jwt, tenantApiUrl, campaignId, coupon } =
		useLoaderData<typeof loader>()
	const { token, refreshIfExpired, reloadKey } = useLoaderToken(jwt)
	const [state, setState] = useState<CampaignState>({ status: 'loading' })

	// Keyed on the campaign, not on the token or coupon: a loader revalidation
	// signs a new token and must not blank the page or download the recipients
	// again. A 401 on an expired token asks the loader for a new one, and
	// `reloadKey` fetches again once it arrives, keeping what is on screen.
	useEffect(() => {
		const controller = new AbortController()
		async function load() {
			const used = token()
			try {
				const res = await fetch(
					`${tenantApiUrl}/operator/marketing/campaigns/${encodeURIComponent(campaignId)}`,
					{
						headers: { Authorization: `Bearer ${used}` },
						signal: controller.signal,
					},
				)
				if (res.status === 401 && refreshIfExpired(used)) return
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
				const {
					discountOffer: _offer,
					coupon: _coupon,
					...campaign
				} = data.campaign
				setState({ status: 'ready', campaign })
			} catch {
				if (!controller.signal.aborted) setState({ status: 'failed' })
			}
		}
		void load()
		return () => controller.abort()
	}, [tenantApiUrl, campaignId, reloadKey, token, refreshIfExpired])

	// Another campaign: show the skeleton, not the previous one's recipients.
	const [shownCampaignId, setShownCampaignId] = useState(campaignId)
	if (shownCampaignId !== campaignId) {
		setShownCampaignId(campaignId)
		setState({ status: 'loading' })
	}

	if (state.status === 'loading') {
		return (
			<div className="space-y-4" role="status" aria-busy="true">
				<span className="sr-only">{_(msg`Loading broadcast…`)}</span>
				<Skeleton className="h-8 w-64" aria-hidden />
				<Skeleton className="h-32 w-full rounded-lg" aria-hidden />
				<Skeleton className="h-48 w-full rounded-lg" aria-hidden />
			</div>
		)
	}

	if (state.status !== 'ready') {
		return (
			<p role="alert" className="text-destructive text-sm">
				{state.status === 'not_found'
					? _(msg`Broadcast not found`)
					: _(msg`Failed to load broadcast`)}
			</p>
		)
	}

	return <CampaignDetailView campaign={{ ...state.campaign, coupon }} />
}
