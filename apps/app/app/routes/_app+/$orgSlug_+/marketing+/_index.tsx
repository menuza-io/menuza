import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { CampaignStatusBadge, type CampaignListItem } from '@repo/marketing'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@repo/ui/item'
import { PageHeader } from '@repo/ui/page-header'
import { Skeleton } from '@repo/ui/skeleton'
import { useEffect, useState } from 'react'
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

type MarketingMetricsState = {
	emailsSent: number
	openRate: string
	clickRate: string
	activeCampaigns: number
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { jwt, tenantApiUrl } = await getOperatorTenantClient(request, orgSlug)

	return {
		jwt,
		tenantApiUrl,
		orgSlug,
	}
}

export default function MarketingOverview() {
	const { _ } = useLingui()
	const { jwt, tenantApiUrl, orgSlug } = useLoaderData<typeof loader>()
	const [metrics, setMetrics] = useState<MarketingMetricsState>({
		emailsSent: 0,
		openRate: '0.0',
		clickRate: '0.0',
		activeCampaigns: 0,
	})
	const [campaigns, setCampaigns] = useState<CampaignListItem[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	const metricItems: Array<{
		key: keyof MarketingMetricsState
		label: string
		format: (metrics: MarketingMetricsState) => string
	}> = [
		{
			key: 'emailsSent',
			label: _(msg`Emails sent`),
			format: (m) => m.emailsSent.toLocaleString(),
		},
		{
			key: 'openRate',
			label: _(msg`Open rate`),
			format: (m) => `${m.openRate}%`,
		},
		{
			key: 'clickRate',
			label: _(msg`Click rate`),
			format: (m) => `${m.clickRate}%`,
		},
		{
			key: 'activeCampaigns',
			label: _(msg`Active`),
			format: (m) => String(m.activeCampaigns),
		},
	]

	const quickLinks = [
		{
			to: 'campaigns',
			icon: 'send' as const,
			title: _(msg`Broadcasts`),
			description: _(msg`One-time email and SMS`),
		},
		{
			to: 'automations',
			icon: 'route' as const,
			title: _(msg`Automations`),
			description: _(msg`Event-driven workflows`),
		},
	]

	useEffect(() => {
		async function fetchMarketingData() {
			try {
				const [metricsRes, campaignsRes] = await Promise.all([
					fetch(`${tenantApiUrl}/operator/marketing/metrics`, {
						headers: { Authorization: `Bearer ${jwt}` },
					}),
					fetch(`${tenantApiUrl}/operator/marketing/campaigns`, {
						headers: { Authorization: `Bearer ${jwt}` },
					}),
				])

				if (metricsRes.ok) {
					const metricsData = (await metricsRes.json()) as {
						metrics?: MarketingMetricsState
					}
					setMetrics(
						metricsData.metrics ?? {
							emailsSent: 0,
							openRate: '0.0',
							clickRate: '0.0',
							activeCampaigns: 0,
						},
					)
				}

				if (campaignsRes.ok) {
					const campaignsData = (await campaignsRes.json()) as {
						campaigns?: CampaignListItem[]
					}
					setCampaigns(campaignsData.campaigns ?? [])
				}
			} catch (err) {
				setError(
					err instanceof Error
						? err.message
						: _(msg`Failed to load marketing metrics`),
				)
			} finally {
				setLoading(false)
			}
		}

		void fetchMarketingData()
	}, [jwt, tenantApiUrl, _])

	const recentCampaigns = campaigns.slice(0, 5)

	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`Marketing`)}
				description={_(
					msg`Broadcasts, automations, and performance at a glance.`,
				)}
			/>

			<ItemGroup className="grid gap-3 sm:grid-cols-2">
				{quickLinks.map((item) => (
					<Item
						key={item.to}
						variant="outline"
						render={<Link to={`/${orgSlug}/marketing/${item.to}`} />}
					>
						<ItemMedia variant="icon">
							<Icon name={item.icon} className="size-4" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle>{item.title}</ItemTitle>
							<ItemDescription>{item.description}</ItemDescription>
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

			{error ? (
				<p className="text-destructive text-sm">{error}</p>
			) : (
				<>
					<section aria-label={_(msg`Performance metrics`)}>
						<ItemGroup className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
							{metricItems.map((item) => (
								<Item key={item.key} variant="outline" size="sm">
									<ItemContent>
										<ItemDescription>{item.label}</ItemDescription>
										{loading ? (
											<Skeleton className="mt-1 h-7 w-16" />
										) : (
											<p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
												{item.format(metrics)}
											</p>
										)}
									</ItemContent>
								</Item>
							))}
						</ItemGroup>
					</section>

					<section aria-labelledby="recent-campaigns-heading">
						<div className="mb-3 flex items-center justify-between gap-4">
							<h2 id="recent-campaigns-heading" className="text-sm font-medium">
								{_(msg`Recent campaigns`)}
							</h2>
							<Link
								to={`/${orgSlug}/marketing/campaigns`}
								className="text-muted-foreground hover:text-foreground text-xs transition-colors"
							>
								{_(msg`View all`)}
							</Link>
						</div>

						{loading ? (
							<ItemGroup>
								{Array.from({ length: 3 }).map((_, i) => (
									<Skeleton key={i} className="h-16 w-full rounded-lg" />
								))}
							</ItemGroup>
						) : recentCampaigns.length === 0 ? (
							<div className="px-4 py-10 text-center">
								<p className="text-muted-foreground text-sm">
									{_(msg`No campaigns yet.`)}
								</p>
								<Link
									to={`/${orgSlug}/marketing/campaigns/new`}
									className="text-foreground mt-2 inline-block text-sm underline-offset-4 hover:underline"
								>
									{_(msg`Create your first broadcast`)}
								</Link>
							</div>
						) : (
							<ItemGroup>
								{recentCampaigns.map((campaign) => (
									<Item
										key={campaign.id}
										variant="outline"
										size="sm"
										render={
											<Link
												to={`/${orgSlug}/marketing/campaigns/${campaign.id}`}
											/>
										}
									>
										<ItemContent>
											<ItemTitle>{campaign.name}</ItemTitle>
											<ItemDescription>
												{(() => {
													const recipientCount = (
														campaign.targetAudienceCount ?? 0
													).toLocaleString()
													return _(msg`${recipientCount} recipients`)
												})()}
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
				</>
			)}
		</div>
	)
}
