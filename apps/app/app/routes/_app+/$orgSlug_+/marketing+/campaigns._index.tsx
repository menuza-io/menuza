import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { CampaignStatusBadge, type CampaignListItem } from '@repo/marketing'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { PageHeader } from '@repo/ui/page-header'
import { useState } from 'react'
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { CampaignActions } from '#app/components/marketing/campaign-actions.tsx'
import { EmptyState } from '#app/components/empty-state.tsx'
import { useHasPermission } from '#app/hooks/use-organization-permissions.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

const STATUS_FILTERS = [
	'all',
	'draft',
	'scheduled',
	'processing',
	'completed',
	'failed',
	'cancelled',
	'skippedlate',
] as const

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(request, orgSlug)

	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
	)

	const res = await fetchTenant('/operator/marketing/campaigns')
	if (!res.ok) {
		return {
			orgSlug,
			campaigns: [],
			error: i18n._(t`Failed to load campaigns`),
		}
	}

	const data = (await res.json()) as {
		campaigns?: Array<
			CampaignListItem & {
				updatedAt?: string | null
				retargetOfCampaignId?: string | null
			}
		>
	}
	const campaigns = data.campaigns ?? []
	// Which broadcast was already re-sent: the one a newer broadcast points back to.
	const retargeted = new Map(
		campaigns.flatMap((campaign) =>
			campaign.retargetOfCampaignId
				? [[campaign.retargetOfCampaignId, campaign.id] as const]
				: [],
		),
	)
	return {
		orgSlug,
		campaigns: campaigns.map((campaign) => ({
			...campaign,
			retargetedByCampaignId: retargeted.get(campaign.id) ?? null,
		})),
		error: null,
	}
}

export default function CampaignsIndexRoute() {
	const { _ } = useLingui()
	const { orgSlug, campaigns, error } = useLoaderData<typeof loader>()
	const hasPermission = useHasPermission()
	const canManage = hasPermission('update:campaign:any')
	const [searchQuery, setSearchQuery] = useState('')
	const [statusFilter, setStatusFilter] = useState<string>('all')

	const statusFilterLabels: Record<(typeof STATUS_FILTERS)[number], string> = {
		all: _(msg`All`),
		draft: _(msg`Draft`),
		scheduled: _(msg`Scheduled`),
		completed: _(msg`Completed`),
		processing: _(msg`Processing`),
		failed: _(msg`Failed`),
		cancelled: _(msg`Cancelled`),
		skippedlate: _(msg`Not sent`),
	}

	const filteredCampaigns = campaigns.filter((campaign) => {
		const matchesSearch = campaign.name
			.toLowerCase()
			.includes(searchQuery.toLowerCase())
		const matchesStatus =
			statusFilter === 'all' || campaign.status.toLowerCase() === statusFilter
		return matchesSearch && matchesStatus
	})

	const hasFilters = searchQuery.length > 0 || statusFilter !== 'all'

	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`Broadcasts`)}
				description={_(msg`One-time email and SMS campaigns.`)}
				actions={
					canManage ? (
						<Button
							render={<Link to={`/${orgSlug}/marketing/campaigns/new`} />}
							className="shrink-0 gap-2"
						>
							<Icon name="plus" className="size-4" />
							{_(msg`New broadcast`)}
						</Button>
					) : null
				}
			/>

			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="relative max-w-sm flex-1">
					<Icon
						name="search"
						className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2"
					/>
					<Input
						placeholder={_(msg`Search campaigns...`)}
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="ps-8"
					/>
				</div>
				<div className="flex flex-wrap items-center gap-1">
					{STATUS_FILTERS.map((status) => (
						<button
							key={status}
							type="button"
							onClick={() => setStatusFilter(status)}
							className={cn(
								'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
								statusFilter === status
									? 'bg-muted text-foreground'
									: 'text-muted-foreground hover:text-foreground',
							)}
						>
							{statusFilterLabels[status]}
						</button>
					))}
				</div>
			</div>

			{error ? (
				<p className="text-destructive text-sm">{error}</p>
			) : filteredCampaigns.length === 0 ? (
				<EmptyState
					title={_(msg`No broadcasts found`)}
					description={
						hasFilters
							? _(msg`Try adjusting your search or filter.`)
							: _(msg`Create your first one-time email or SMS campaign.`)
					}
					icons={['mail', 'send', 'smartphone']}
					action={
						!hasFilters && canManage
							? {
									label: _(msg`Create broadcast`),
									href: `/${orgSlug}/marketing/campaigns/new`,
								}
							: undefined
					}
				/>
			) : (
				<ItemGroup>
					{filteredCampaigns.map((campaign) => (
						<Item
							key={campaign.id}
							variant="outline"
							size="sm"
							className="relative"
						>
							<ItemContent>
								<ItemTitle>
									{/* A stretched link: the whole row opens it, and the menu sits above. */}
									<Link
										to={`/${orgSlug}/marketing/campaigns/${campaign.id}`}
										className="after:absolute after:inset-0 hover:underline"
									>
										{campaign.name}
									</Link>
								</ItemTitle>
								<ItemDescription>
									<span className="capitalize">{campaign.channel}</span>
									{' · '}
									{(() => {
										const recipientCount =
											campaign.targetAudienceCount.toLocaleString()
										return _(msg`${recipientCount} recipients`)
									})()}
									{' · '}
									{campaign.status === 'Scheduled' && campaign.scheduledAt
										? (() => {
												const at = new Date(
													campaign.scheduledAt,
												).toLocaleString()
												return _(msg`Scheduled for ${at}`)
											})()
										: new Date(campaign.createdAt).toLocaleDateString()}
								</ItemDescription>
							</ItemContent>
							<ItemActions className="relative z-10">
								<CampaignStatusBadge status={campaign.status} />
								<CampaignActions
									orgSlug={orgSlug}
									campaign={campaign}
									variant="menu"
								/>
							</ItemActions>
						</Item>
					))}
				</ItemGroup>
			)}
		</div>
	)
}
