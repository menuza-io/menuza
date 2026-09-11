import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { Link } from 'react-router'
import { useCampaignLabels } from '../i18n/campaign-labels.ts'
import { CampaignStatusBadge } from './campaign-list.tsx'
import { type CampaignDetail } from '../types/campaign.ts'

export function CampaignDetailView({
	campaign,
	backHref,
	backLabel,
}: {
	campaign: CampaignDetail
	backHref: string
	backLabel?: string
}) {
	const { _ } = useLingui()
	const { channelLabel } = useCampaignLabels()
	const resolvedBackLabel = backLabel ?? _(msg`Back to broadcasts`)

	function formatAudience(audience?: string | null) {
		if (!audience) return _(msg`All recipients`)
		return audience
			.replaceAll('_', ' ')
			.replace(/\b\w/g, (char) => char.toUpperCase())
	}

	function recipientContact(recipient: CampaignDetail['recipients'][number]) {
		if (recipient.email) return recipient.email
		if (recipient.phone) return recipient.phone
		return _(msg`No contact on file`)
	}

	function recipientEngagement(
		recipient: CampaignDetail['recipients'][number],
	) {
		if (recipient.clickedAt) {
			return _(msg`Clicked ${new Date(recipient.clickedAt).toLocaleString()}`)
		}
		if (recipient.openedAt) {
			return _(msg`Opened ${new Date(recipient.openedAt).toLocaleString()}`)
		}
		return null
	}

	return (
		<div className="space-y-8">
			<div className="space-y-4">
				<Button
					variant="ghost"
					size="sm"
					className="text-muted-foreground -ml-2 gap-1.5"
					render={<Link to={backHref} />}
				>
					<Icon name="arrow-left" className="size-4" />
					{resolvedBackLabel}
				</Button>

				<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div className="space-y-2">
						<div className="flex flex-wrap items-center gap-2">
							<h1 className="text-2xl font-semibold tracking-tight">
								{campaign.name}
							</h1>
							<CampaignStatusBadge status={campaign.status} />
						</div>
						<p className="text-muted-foreground text-sm">
							{channelLabel(campaign.channel)}
							{' · '}
							{formatAudience(campaign.audience)}
							{' · '}
							{_(msg`Sent ${new Date(campaign.createdAt).toLocaleString()}`)}
						</p>
					</div>
				</div>
			</div>

			<section className="space-y-3" aria-labelledby="campaign-message-heading">
				<h2 id="campaign-message-heading" className="text-sm font-medium">
					{_(msg`Message`)}
				</h2>
				<div className="rounded-lg border p-4">
					{campaign.channel === 'email' && campaign.subject ? (
						<p className="text-sm font-medium">{campaign.subject}</p>
					) : null}
					{campaign.contentHtml ? (
						<iframe
							title={_(msg`Broadcast preview`)}
							srcDoc={campaign.contentHtml}
							sandbox="allow-same-origin"
							className="mt-3 h-[640px] w-full rounded-md border"
						/>
					) : (
						<p className="text-muted-foreground mt-2 text-sm whitespace-pre-wrap">
							{campaign.content}
						</p>
					)}
				</div>
			</section>

			<section
				className="space-y-3"
				aria-labelledby="campaign-recipients-heading"
			>
				<div className="flex items-center justify-between gap-4">
					<h2 id="campaign-recipients-heading" className="text-sm font-medium">
						{_(msg`Recipients`)}
					</h2>
					<p className="text-muted-foreground text-xs">
						{_(
							msg`${campaign.recipients.length} of ${campaign.targetAudienceCount} targeted`,
						)}
					</p>
				</div>

				{campaign.recipients.length === 0 ? (
					<div className="rounded-lg border border-dashed px-4 py-10 text-center">
						<p className="text-muted-foreground text-sm">
							{_(msg`No delivery records yet.`)}
						</p>
					</div>
				) : (
					<ItemGroup>
						{campaign.recipients.map((recipient) => {
							const engagement = recipientEngagement(recipient)
							return (
								<Item key={recipient.id} variant="outline" size="sm">
									<ItemContent>
										<ItemTitle>
											{recipient.name || _(msg`Unnamed recipient`)}
										</ItemTitle>
										<ItemDescription>
											{recipientContact(recipient)}
											{recipient.sentAt
												? ` · ${_(msg`Sent ${new Date(recipient.sentAt).toLocaleString()}`)}`
												: ''}
											{engagement ? ` · ${engagement}` : ''}
										</ItemDescription>
									</ItemContent>
									<Badge variant="outline" className="text-[10px] capitalize">
										{recipient.status}
									</Badge>
								</Item>
							)
						})}
					</ItemGroup>
				)}
			</section>
		</div>
	)
}
