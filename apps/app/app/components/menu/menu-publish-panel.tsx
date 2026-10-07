import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import {
	PublishMenuDialog,
	type PublishChannelOption,
	type PublishTargetResult,
} from '#app/components/menu/publish-menu-dialog.tsx'
import {
	MenuPublishStatusBadge,
	type MenuPublishState,
} from '#app/components/menu/publish-status-badge.tsx'

export interface MenuPublishPanelProps {
	organizationSlug: string
	menu: {
		id: string
		name: string
	}
	publishState: MenuPublishState
	revision: number | null
	publishedAt: string | null
	channels: PublishChannelOption[]
	events: Array<{
		id: string
		revision: number
		status: string
		targets: PublishTargetResult[]
		createdAt: string
	}>
}

function relativeTime(value: string) {
	const minutes = Math.max(
		0,
		Math.floor((Date.now() - new Date(value).getTime()) / 60000),
	)
	if (minutes < 1) return 'just now'
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	return `${Math.floor(hours / 24)}d ago`
}

/**
 * Master-menu publish panel for a single menu: current publish state, the sync
 * status of every connected channel, and the publish action.
 */
export function MenuPublishPanel({
	organizationSlug,
	menu,
	publishState,
	revision,
	publishedAt,
	channels,
	events,
}: MenuPublishPanelProps) {
	const { _ } = useLingui()
	const [dialogOpen, setDialogOpen] = useState(false)

	return (
		<Card>
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div className="space-y-1">
					<CardTitle className="flex items-center gap-2">
						<Trans>Publishing</Trans>
						<MenuPublishStatusBadge state={publishState} />
					</CardTitle>
					<p className="text-muted-foreground text-sm">
						{publishState === 'not-published' ? (
							<Trans>
								This menu has never been published. Customers see live edits
								until the first publish.
							</Trans>
						) : publishState === 'pending' ? (
							<Trans>
								There are unpublished changes. Customers still see the last
								published version.
							</Trans>
						) : (
							<Trans>Customers see the published version of this menu.</Trans>
						)}
						{revision !== null && publishedAt ? (
							<span>
								{' '}
								{(() => {
									const publishedWhen = relativeTime(publishedAt)
									return _(t`Revision ${revision} published ${publishedWhen}`)
								})()}
								.
							</span>
						) : null}
					</p>
				</div>
				<Button size="sm" onClick={() => setDialogOpen(true)}>
					<Icon name="paper-plane" className="size-4" />
					{publishState === 'not-published' ? (
						<Trans>Publish menu</Trans>
					) : (
						<Trans>Publish changes</Trans>
					)}
				</Button>
			</CardHeader>

			{channels.length > 0 ? (
				<CardContent className="space-y-1">
					<div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase">
						<Trans>Channels</Trans>
					</div>
					{channels.map((channel) => (
						<div
							key={channel.integrationId}
							className="flex items-center justify-between gap-2 text-sm"
						>
							<span className="flex items-center gap-1.5">
								<Icon
									name={
										channel.lastStatus === 'success'
											? 'circle-check'
											: channel.lastStatus === 'error'
												? 'octagon-alert'
												: 'circle'
									}
									className={
										channel.lastStatus === 'success'
											? 'size-3.5 text-emerald-500'
											: channel.lastStatus === 'error'
												? 'text-destructive size-3.5'
												: 'text-muted-foreground size-3.5'
									}
								/>
								{channel.displayName}
							</span>
							<span className="text-muted-foreground flex items-center gap-2 text-xs">
								{channel.lastStatus === null ? (
									<Trans>Never synced</Trans>
								) : channel.lastSyncAt ? (
									relativeTime(channel.lastSyncAt)
								) : null}
								{channel.lastStatus === 'error' && channel.lastError ? (
									<Badge variant="destructive" className="text-[10px]">
										{channel.lastError.slice(0, 60)}
									</Badge>
								) : null}
							</span>
						</div>
					))}
				</CardContent>
			) : null}

			{events.length > 0 ? (
				<CardContent className="space-y-1">
					<div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase">
						<Trans>Recent publishes</Trans>
					</div>
					{events.slice(0, 5).map((event) => {
						const eventRevision = event.revision
						return (
							<div
								key={event.id}
								className="flex items-center justify-between gap-2 text-sm"
							>
								<span className="flex items-center gap-1.5">
									<Icon
										name={
											event.status === 'succeeded'
												? 'circle-check'
												: 'alert-triangle'
										}
										className={
											event.status === 'succeeded'
												? 'size-3.5 text-emerald-500'
												: 'size-3.5 text-amber-500'
										}
									/>
									{_(t`Revision ${eventRevision}`)}
								</span>
								<span className="text-muted-foreground text-xs">
									{relativeTime(event.createdAt)}
								</span>
							</div>
						)
					})}
				</CardContent>
			) : null}

			<PublishMenuDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				organizationSlug={organizationSlug}
				menu={menu}
				publishState={publishState}
				channels={channels}
			/>
		</Card>
	)
}
