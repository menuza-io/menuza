import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	requireAnyUserWithPermission,
	SYSTEM_PERMISSIONS,
	userHasPermission,
} from '@repo/auth'
import { CampaignStatusBadge, type CampaignListItem } from '@repo/marketing'
import {
	getPlatformMarketingMetrics,
	listPlatformCampaigns,
} from '@repo/marketing/server/platform-campaigns'
import { Icon, type IconName } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@repo/ui/item'
import { Link, type LoaderFunctionArgs, useLoaderData } from 'react-router'

const QUICK_LINKS: Array<{
	to: string
	icon: IconName
	title: ReturnType<typeof msg>
	description: ReturnType<typeof msg>
}> = [
	{
		to: '/marketing/campaigns',
		icon: 'send',
		title: msg`Broadcasts`,
		description: msg`Email tenant operators`,
	},
	{
		to: '/marketing/automations',
		icon: 'route',
		title: msg`Automations`,
		description: msg`Platform lifecycle workflows`,
	},
]

const METRIC_ITEMS = [
	{
		key: 'emailsSent',
		label: msg`Emails sent`,
		format: (metrics: { emailsSent: number }) =>
			metrics.emailsSent.toLocaleString(),
	},
	{
		key: 'openRate',
		label: msg`Open rate`,
		format: (metrics: { openRate: string }) => `${metrics.openRate}%`,
	},
	{
		key: 'clickRate',
		label: msg`Click rate`,
		format: (metrics: { clickRate: string }) => `${metrics.clickRate}%`,
	},
	{
		key: 'activeCampaigns',
		label: msg`Active campaigns`,
		format: (metrics: { activeCampaigns: number }) =>
			String(metrics.activeCampaigns),
	},
] as const

export async function loader({ request }: LoaderFunctionArgs) {
	const userId = await requireAnyUserWithPermission(request, [
		SYSTEM_PERMISSIONS.READ_PLATFORM_CAMPAIGN_ANY,
		SYSTEM_PERMISSIONS.READ_PLATFORM_AUTOMATION_ANY,
	])

	// The overview shows campaign data, so only load it for users who can read
	// campaigns; automation-only access still gets the quick links.
	const [canReadCampaigns, canReadAutomations, canManageCampaigns] =
		await Promise.all([
			userHasPermission(userId, SYSTEM_PERMISSIONS.READ_PLATFORM_CAMPAIGN_ANY),
			userHasPermission(
				userId,
				SYSTEM_PERMISSIONS.READ_PLATFORM_AUTOMATION_ANY,
			),
			userHasPermission(
				userId,
				SYSTEM_PERMISSIONS.UPDATE_PLATFORM_CAMPAIGN_ANY,
			),
		])

	if (!canReadCampaigns) {
		return {
			metrics: null,
			campaigns: [] as CampaignListItem[],
			canReadCampaigns,
			canReadAutomations,
			canManageCampaigns,
		}
	}

	const [metrics, campaigns] = await Promise.all([
		getPlatformMarketingMetrics(),
		listPlatformCampaigns(),
	])

	return {
		metrics,
		campaigns: campaigns.slice(0, 5) as CampaignListItem[],
		canReadCampaigns,
		canReadAutomations,
		canManageCampaigns,
	}
}

export default function MarketingOverviewRoute() {
	const { _ } = useLingui()
	const {
		metrics,
		campaigns,
		canReadCampaigns,
		canReadAutomations,
		canManageCampaigns,
	} = useLoaderData<typeof loader>()

	const quickLinks = QUICK_LINKS.filter((item) =>
		item.to === '/marketing/campaigns' ? canReadCampaigns : canReadAutomations,
	)

	return (
		<div className="space-y-8">
			<header className="space-y-1">
				<h1 className="text-2xl tracking-tight">
					<Trans>Platform marketing</Trans>
				</h1>
				<p className="text-muted-foreground text-sm">
					<Trans>Broadcasts and automations for tenant operators.</Trans>
				</p>
			</header>

			<ItemGroup className="grid gap-3 sm:grid-cols-2">
				{quickLinks.map((item) => (
					<Item key={item.to} variant="outline" render={<Link to={item.to} />}>
						<ItemMedia variant="icon">
							<Icon name={item.icon} className="size-4" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle>{_(item.title)}</ItemTitle>
							<ItemDescription>{_(item.description)}</ItemDescription>
						</ItemContent>
						<ItemActions>
							<Icon
								name="chevron-right"
								className="text-muted-foreground size-4 shrink-0"
							/>
						</ItemActions>
					</Item>
				))}
			</ItemGroup>

			{canReadCampaigns && metrics ? (
				<section aria-label={_(msg`Performance metrics`)}>
					<ItemGroup className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						{METRIC_ITEMS.map((item) => (
							<Item key={item.key} variant="outline" size="sm">
								<ItemContent>
									<ItemDescription>{_(item.label)}</ItemDescription>
									<p className="mt-1 text-2xl tracking-tight tabular-nums">
										{item.format(metrics)}
									</p>
								</ItemContent>
							</Item>
						))}
					</ItemGroup>
				</section>
			) : null}

			{canReadCampaigns ? (
				<section aria-labelledby="recent-campaigns-heading">
					<div className="mb-3 flex items-center justify-between gap-4">
						<h2 id="recent-campaigns-heading" className="text-sm font-medium">
							<Trans>Recent campaigns</Trans>
						</h2>
						<Link
							to="/marketing/campaigns"
							className="text-muted-foreground hover:text-foreground text-xs transition-colors"
						>
							<Trans>View all</Trans>
						</Link>
					</div>

					{campaigns.length === 0 ? (
						<div className="px-4 py-10 text-center">
							<p className="text-muted-foreground text-sm">
								<Trans>No campaigns yet.</Trans>
							</p>
							{canManageCampaigns ? (
								<Link
									to="/marketing/campaigns/new"
									className="text-foreground mt-2 inline-block text-sm underline-offset-4 hover:underline"
								>
									<Trans>Create your first broadcast</Trans>
								</Link>
							) : null}
						</div>
					) : (
						<ItemGroup>
							{campaigns.map((campaign) => (
								<Item
									key={campaign.id}
									variant="outline"
									size="sm"
									render={<Link to={`/marketing/campaigns/${campaign.id}`} />}
								>
									<ItemContent>
										<ItemTitle>{campaign.name}</ItemTitle>
										<ItemDescription>
											{campaign.targetAudienceCount.toLocaleString()}{' '}
											<Trans>recipients</Trans>
										</ItemDescription>
									</ItemContent>
									<ItemActions>
										<CampaignStatusBadge status={campaign.status} />
									</ItemActions>
								</Item>
							))}
						</ItemGroup>
					)}
				</section>
			) : null}
		</div>
	)
}
