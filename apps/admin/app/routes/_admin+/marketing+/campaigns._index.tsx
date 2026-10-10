import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	requireUserWithPermission,
	SYSTEM_PERMISSIONS,
	userHasPermission,
} from '@repo/auth'
import { CampaignListGrid } from '@repo/marketing'
import { listPlatformCampaigns } from '@repo/marketing/server/platform-campaigns'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { PageHeader } from '@repo/ui/page-header'
import { useState } from 'react'
import { Link, type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'

const STATUS_FILTERS: Array<{
	value: string
	label: ReturnType<typeof msg>
}> = [
	{ value: 'all', label: msg`All` },
	{ value: 'completed', label: msg`Completed` },
	{ value: 'processing', label: msg`Processing` },
	{ value: 'failed', label: msg`Failed` },
]

export async function loader({ request }: LoaderFunctionArgs) {
	const userId = await requireUserWithPermission(
		request,
		SYSTEM_PERMISSIONS.READ_PLATFORM_CAMPAIGN_ANY,
	)
	const [campaigns, canManage] = await Promise.all([
		listPlatformCampaigns(),
		userHasPermission(userId, SYSTEM_PERMISSIONS.UPDATE_PLATFORM_CAMPAIGN_ANY),
	])
	return { campaigns, canManage, error: null }
}

export default function AdminCampaignsIndexRoute() {
	const { _ } = useLingui()
	const { campaigns, canManage, error } = useLoaderData<typeof loader>()
	const [searchQuery, setSearchQuery] = useState('')
	const [statusFilter, setStatusFilter] = useState('all')

	const filteredCampaigns = campaigns.filter((campaign) => {
		const matchesSearch = campaign.name
			.toLowerCase()
			.includes(searchQuery.toLowerCase())
		const matchesStatus =
			statusFilter === 'all' || campaign.status.toLowerCase() === statusFilter
		return matchesSearch && matchesStatus
	})

	return (
		<div className="space-y-6">
			<PageHeader
				title={<Trans>Platform Broadcasts</Trans>}
				description={<Trans>Send one-time emails to tenant operators.</Trans>}
				actions={
					canManage ? (
						<Button render={<Link to="/marketing/campaigns/new" />}>
							<Icon name="plus" className="size-4" />
							<Trans>New Broadcast</Trans>
						</Button>
					) : null
				}
			/>

			<div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
				<Input
					placeholder={_(msg`Search campaigns...`)}
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					className="h-9 max-w-md"
				/>
				<div className="bg-card flex items-center gap-1 rounded-lg border p-1">
					{STATUS_FILTERS.map((filter) => (
						<button
							key={filter.value}
							type="button"
							onClick={() => setStatusFilter(filter.value)}
							className={cn(
								'rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors',
								statusFilter === filter.value
									? 'bg-primary text-primary-foreground shadow-xs'
									: 'text-muted-foreground hover:text-foreground',
							)}
						>
							{_(filter.label)}
						</button>
					))}
				</div>
			</div>

			{error && (
				<div className="border-destructive/30 bg-destructive/10 text-destructive rounded-xl border p-4 text-sm">
					{error}
				</div>
			)}

			{filteredCampaigns.length === 0 ? (
				<EmptyState
					title={_(msg`No broadcasts found`)}
					description={_(
						msg`Create your first platform email campaign for tenant operators.`,
					)}
					icons={['mail', 'send']}
					action={
						canManage
							? {
									label: _(msg`Create Broadcast`),
									href: '/marketing/campaigns/new',
								}
							: undefined
					}
				/>
			) : (
				<CampaignListGrid
					campaigns={filteredCampaigns}
					getCampaignHref={(campaign) => `/marketing/campaigns/${campaign.id}`}
				/>
			)}
		</div>
	)
}
