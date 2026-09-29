import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
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
import { Link } from 'react-router'
import { useCampaignLabels } from '../i18n/campaign-labels.ts'
import {
	type CampaignListItem,
	type CampaignStatus,
} from '../types/campaign.ts'

function statusBadgeClass(status: CampaignStatus) {
	return cn(
		'shrink-0 text-[10px]',
		status === 'Completed' &&
			'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
		status === 'Processing' &&
			'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
		status === 'Failed' &&
			'bg-destructive/10 text-destructive border-destructive/30',
		['Draft', 'Scheduled'].includes(status) &&
			'bg-muted text-muted-foreground border-border',
	)
}

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
	const { statusLabel } = useCampaignLabels()

	return (
		<Badge variant="outline" className={statusBadgeClass(status)}>
			{statusLabel(status)}
		</Badge>
	)
}

export function CampaignListGrid({
	campaigns,
	getCampaignHref,
}: {
	campaigns: CampaignListItem[]
	getCampaignHref?: (campaign: CampaignListItem) => string
}) {
	const { _ } = useLingui()
	const { channelLabel } = useCampaignLabels()

	return (
		<ItemGroup>
			{campaigns.map((campaign) => (
				<Item
					key={campaign.id}
					variant="outline"
					size="sm"
					render={
						getCampaignHref ? (
							<Link to={getCampaignHref(campaign)} />
						) : undefined
					}
				>
					<ItemMedia variant="icon">
						<Icon
							name={campaign.channel === 'email' ? 'mail' : 'smartphone'}
							className="size-4"
						/>
					</ItemMedia>
					<ItemContent>
						<ItemTitle>{campaign.name}</ItemTitle>
						<ItemDescription>
							{channelLabel(campaign.channel)}
							{' · '}
							{campaign.targetAudienceCount.toLocaleString()}{' '}
							{_(msg`recipients`)}
							{' · '}
							{new Date(campaign.createdAt).toLocaleDateString()}
						</ItemDescription>
					</ItemContent>
					<ItemActions>
						<CampaignStatusBadge status={campaign.status} />
					</ItemActions>
				</Item>
			))}
		</ItemGroup>
	)
}
