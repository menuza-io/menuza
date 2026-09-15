import { Trans } from '@lingui/react/macro'

import { cn } from '@repo/ui'
import { Icon, type IconName } from '@repo/ui/icon'
import { format, isToday, isYesterday } from 'date-fns'

import { UserAvatar } from '../user-avatar'

export type ActivityLog = {
	id: string
	action: string
	metadata: string | null
	createdAt: Date
	user: {
		id: string
		name: string | null
		username: string
		image?: string | null
	}
	targetUser?: {
		id: string
		name: string | null
		username: string
	} | null
	integration?: {
		id: string
		providerName: string
		providerType: string
	} | null
}

interface ActivityLogProps {
	activityLogs: ActivityLog[]
}

type ActionConfig = {
	icon: IconName
	iconColor: string
}

function parseMetadata(metadata: string | null): Record<string, unknown> {
	if (!metadata) return {}
	try {
		return JSON.parse(metadata) as Record<string, unknown>
	} catch {
		return {}
	}
}

function getActionConfig(action: string): ActionConfig {
	switch (action) {
		case 'viewed':
			return { icon: 'activity', iconColor: 'text-blue-500' }
		case 'created':
			return { icon: 'plus', iconColor: 'text-green-600' }
		case 'updated':
			return { icon: 'pencil', iconColor: 'text-amber-600' }
		case 'deleted':
			return { icon: 'trash-2', iconColor: 'text-destructive' }
		case 'sharing_changed':
			return { icon: 'share-2', iconColor: 'text-purple-500' }
		case 'access_granted':
			return { icon: 'user-plus', iconColor: 'text-teal-600' }
		case 'access_revoked':
			return { icon: 'ban', iconColor: 'text-destructive' }
		case 'integration_connected':
			return { icon: 'link-2', iconColor: 'text-indigo-500' }
		case 'integration_disconnected':
			return { icon: 'minus', iconColor: 'text-muted-foreground' }
		case 'comment_added':
			return { icon: 'message-circle', iconColor: 'text-cyan-600' }
		case 'comment_deleted':
			return { icon: 'message-square', iconColor: 'text-muted-foreground' }
		default:
			return { icon: 'clock', iconColor: 'text-muted-foreground' }
	}
}

function formatActivityAction(log: ActivityLog): string {
	const metadata = parseMetadata(log.metadata)

	switch (log.action) {
		case 'viewed':
			return 'viewed this note'
		case 'created':
			return 'created this note'
		case 'updated':
			if (metadata.contentChanged && metadata.titleChanged)
				return 'updated the title and content'
			if (metadata.titleChanged) return 'updated the title'
			if (metadata.contentChanged) return 'updated the content'
			return 'made changes'
		case 'deleted':
			return 'deleted this note'
		case 'sharing_changed':
			return metadata.isPublic
				? 'made this note public'
				: 'made this note private'
		case 'access_granted': {
			const targetName = log.targetUser?.name || log.targetUser?.username
			return `invited ${targetName} to collaborate`
		}
		case 'access_revoked': {
			const removedName = log.targetUser?.name || log.targetUser?.username
			return `removed ${removedName}'s access`
		}
		case 'integration_connected': {
			const channelName =
				(metadata.channelName as string | undefined) ||
				(metadata.externalId as string | undefined) ||
				'channel'
			return `connected to ${log.integration?.providerName || 'integration'} (${channelName})`
		}
		case 'integration_disconnected':
			return `disconnected from ${log.integration?.providerName || 'integration'}`
		case 'comment_added':
			return metadata.parentId ? 'replied to a comment' : 'left a comment'
		case 'comment_deleted':
			return 'deleted a comment'
		default:
			return 'performed an action'
	}
}

function formatDateHeader(date: Date): string {
	if (isToday(date)) return 'Today'
	if (isYesterday(date)) return 'Yesterday'
	return format(date, 'MMMM d, yyyy')
}

function groupLogsByDate(logs: ActivityLog[]): Map<string, ActivityLog[]> {
	const groups = new Map<string, ActivityLog[]>()

	logs.forEach((log) => {
		const date = new Date(log.createdAt)
		const dateKey = format(date, 'yyyy-MM-dd')

		if (!groups.has(dateKey)) groups.set(dateKey, [])
		groups.get(dateKey)!.push(log)
	})

	return groups
}

function ActivityRow({ log, isLast }: { log: ActivityLog; isLast: boolean }) {
	const config = getActionConfig(log.action)
	const userName = log.user.name || log.user.username
	const action = formatActivityAction(log)

	return (
		<div className="relative flex gap-3 py-2.5">
			{!isLast ? (
				<div
					aria-hidden="true"
					className="bg-border absolute top-9 bottom-0 left-3.5 w-px"
				/>
			) : null}

			<div className="relative shrink-0">
				<UserAvatar
					user={{
						name: log.user.name,
						username: log.user.username,
						image: log.user.image,
					}}
					className="ring-background size-7 ring-2"
					fallbackClassName="bg-muted text-muted-foreground text-[10px] font-medium"
					alt={userName}
				/>
				<div
					className={cn(
						'bg-background ring-background absolute -right-0.5 -bottom-0.5 flex size-3.5 items-center justify-center rounded-full ring-2',
					)}
				>
					<Icon
						name={config.icon}
						// eslint-disable-next-line shadcn/require-static-classes -- color comes from the static action map above
						className={cn('size-2.5', config.iconColor)}
					/>
				</div>
			</div>

			<div className="min-w-0 flex-1 pt-0.5">
				<p className="text-sm leading-snug">
					<span className="text-foreground font-medium">{userName}</span>{' '}
					<span className="text-muted-foreground">{action}</span>
				</p>
			</div>

			<time
				dateTime={new Date(log.createdAt).toISOString()}
				className="text-muted-foreground shrink-0 pt-0.5 text-xs tabular-nums"
			>
				{format(new Date(log.createdAt), 'h:mm a')}
			</time>
		</div>
	)
}

function EmptyState() {
	return (
		<div className="flex flex-col items-center py-12 text-center">
			<div className="bg-muted/50 mb-4 flex size-14 items-center justify-center rounded-full">
				<Icon name="activity" className="text-muted-foreground size-7" />
			</div>
			<p className="text-foreground mb-1 text-sm font-medium">
				<Trans>No activity yet</Trans>
			</p>
			<p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
				<Trans>
					Changes to this note will show up here as your team works on it.
				</Trans>
			</p>
		</div>
	)
}

export function ActivityLog({ activityLogs }: ActivityLogProps) {
	if (activityLogs.length === 0) {
		return <EmptyState />
	}

	const groupedLogs = groupLogsByDate(activityLogs)

	return (
		<div className="space-y-5">
			{Array.from(groupedLogs.entries()).map(([dateKey, logs]) => (
				<section
					key={dateKey}
					aria-label={formatDateHeader(new Date(logs[0]!.createdAt))}
				>
					<h3 className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
						{formatDateHeader(new Date(logs[0]!.createdAt))}
					</h3>
					<div>
						{logs.map((log, index) => (
							<ActivityRow
								key={log.id}
								log={log}
								isLast={index === logs.length - 1}
							/>
						))}
					</div>
				</section>
			))}
		</div>
	)
}
