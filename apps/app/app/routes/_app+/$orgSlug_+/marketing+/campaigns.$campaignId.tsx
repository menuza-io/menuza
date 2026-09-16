import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { CampaignDetailView, type CampaignDetail } from '@repo/marketing'
import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const campaignId = params.campaignId || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(request, orgSlug)

	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
	)

	const res = await fetchTenant(
		`/operator/marketing/campaigns/${encodeURIComponent(campaignId)}`,
	)
	if (!res.ok) {
		return {
			orgSlug,
			campaign: null,
			error:
				res.status === 404
					? i18n._(t`Broadcast not found`)
					: i18n._(t`Failed to load broadcast`),
		}
	}

	const data = (await res.json()) as { campaign?: CampaignDetail }
	return {
		orgSlug,
		campaign: data.campaign ?? null,
		error: null,
	}
}

export default function CampaignDetailRoute() {
	const { _ } = useLingui()
	const { orgSlug, campaign, error } = useLoaderData<typeof loader>()

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
