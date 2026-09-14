import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { CampaignDetailView, type CampaignDetail } from '@repo/marketing'
import { Skeleton } from '@repo/ui/skeleton'
import { useEffect, useState } from 'react'
import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId, jwt, tenantApiUrl } = await getOperatorTenantClient(
		request,
		orgSlug,
	)

	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
	)

	return {
		orgSlug,
		campaignId: params.campaignId || '',
		jwt,
		tenantApiUrl,
	}
}

export default function CampaignDetailRoute() {
	const { _ } = useLingui()
	const { orgSlug, campaignId, jwt, tenantApiUrl } =
		useLoaderData<typeof loader>()
	const [campaign, setCampaign] = useState<CampaignDetail | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		async function fetchCampaign() {
			try {
				const res = await fetch(
					`${tenantApiUrl}/operator/marketing/campaigns/${campaignId}`,
					{
						headers: { Authorization: `Bearer ${jwt}` },
					},
				)
				if (!res.ok) {
					throw new Error(_(msg`Failed to load broadcast`))
				}
				const data = (await res.json()) as { campaign?: CampaignDetail }
				setCampaign(data.campaign ?? null)
			} catch (err) {
				setError(
					err instanceof Error ? err.message : _(msg`Failed to load broadcast`),
				)
			} finally {
				setLoading(false)
			}
		}

		void fetchCampaign()
	}, [campaignId, jwt, tenantApiUrl, _])

	if (loading) {
		return (
			<div className="space-y-8">
				<Skeleton className="h-8 w-40" />
				<Skeleton className="h-10 w-72" />
				<Skeleton className="h-32 w-full rounded-lg" />
				<div className="space-y-2">
					{Array.from({ length: 4 }).map((_, index) => (
						<Skeleton key={index} className="h-16 w-full rounded-lg" />
					))}
				</div>
			</div>
		)
	}

	if (error || !campaign) {
		return (
			<p className="text-destructive text-sm">
				{error ?? _(msg`Broadcast not found`)}
			</p>
		)
	}

	return (
		<CampaignDetailView
			campaign={campaign}
			backHref={`/${orgSlug}/marketing/campaigns`}
		/>
	)
}
