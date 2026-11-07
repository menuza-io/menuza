import { i18n } from '@lingui/core'
import { t, Trans } from '@lingui/macro'
import { requireUserWithPermission, SYSTEM_PERMISSIONS } from '@repo/auth'
import { CampaignDetailView } from '@repo/marketing'
import { getPlatformCampaign } from '@repo/marketing/server/platform-campaigns'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { type LoaderFunctionArgs, useLoaderData } from 'react-router'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserWithPermission(
		request,
		SYSTEM_PERMISSIONS.READ_PLATFORM_CAMPAIGN_ANY,
	)

	const campaignId = params.campaignId || ''
	const campaign = await getPlatformCampaign(campaignId)

	if (!campaign) {
		throw new Response(i18n._(t`Broadcast not found`), { status: 404 })
	}

	return { campaign }
}

export default function AdminCampaignDetailRoute() {
	const { campaign } = useLoaderData<typeof loader>()
	const unconfirmed = campaign.unconfirmedRecipientCount ?? 0

	return (
		<div className="space-y-6">
			{unconfirmed > 0 ? (
				<Alert data-testid="campaign-unconfirmed-recipients">
					<AlertTitle>
						<Trans>Some sends were not confirmed</Trans>
					</AlertTitle>
					<AlertDescription>
						<Trans>
							Recipients not confirmed: {unconfirmed}. Their send was cut off or
							timed out, so the email may or may not have arrived. They stay
							Processing below and are not sent again.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}
			<CampaignDetailView campaign={campaign} backHref="/marketing/campaigns" />
		</div>
	)
}
