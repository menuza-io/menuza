import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Icon } from '@repo/ui/icon'
import { Link } from 'react-router'

export function ChatSidebarLink({
	orgSlug,
	unreadCount,
	isActive,
}: {
	orgSlug: string
	unreadCount: number | null
	isActive: boolean
}) {
	const { _ } = useLingui()
	const total = unreadCount ?? 0
	const badge = total > 99 ? '99+' : String(total)
	const label = _(msg`Team chat`)
	const ariaLabel = total > 0 ? _(msg`${label}, ${total} unread`) : label

	return (
		<Link
			to={`/${orgSlug}/chat`}
			aria-label={ariaLabel}
			title={ariaLabel}
			aria-current={isActive ? 'page' : undefined}
			data-testid="sidebar-team-chat"
			className={cn(
				'relative flex h-9 w-auto shrink-0 items-center gap-2 rounded-md px-2 text-sm',
				'text-sidebar-foreground ring-sidebar-ring outline-none',
				'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
				'focus-visible:ring-2',
				isActive &&
					'bg-sidebar-accent text-sidebar-accent-foreground font-medium',
				'group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:w-full group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-2!',
			)}
		>
			<Icon name="message-square" className="size-4 shrink-0" aria-hidden />
			{total > 0 ? (
				<Badge
					variant="destructive"
					data-testid="chat-unread-count"
					className="pointer-events-none absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-0.5 text-[10px] leading-none tabular-nums"
				>
					{badge}
				</Badge>
			) : null}
		</Link>
	)
}
