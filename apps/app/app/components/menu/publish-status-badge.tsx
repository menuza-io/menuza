import { Trans } from '@lingui/macro'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'

export type MenuPublishState = 'not-published' | 'pending' | 'published'

export interface MenuPublishStatusBadgeProps {
	state: MenuPublishState
	className?: string
}

/**
 * Master-menu publish state: whether the storefront serves the live menu
 * (never published) or the published snapshot, and whether unpublished
 * changes are waiting for the next publish.
 */
export function MenuPublishStatusBadge({
	state,
	className,
}: MenuPublishStatusBadgeProps) {
	return (
		<Badge variant="outline" className={cn('text-xs font-medium', className)}>
			<span
				className={cn(
					'mr-1.5 size-1.5 rounded-full',
					state === 'published'
						? 'bg-emerald-500'
						: state === 'pending'
							? 'bg-amber-500'
							: 'bg-slate-400 dark:bg-slate-500',
				)}
			/>
			{state === 'published' ? (
				<Trans>Published</Trans>
			) : state === 'pending' ? (
				<Trans>Changes pending</Trans>
			) : (
				<Trans>Not published</Trans>
			)}
		</Badge>
	)
}

/** Derives the badge state from the raw publish columns. */
export function menuPublishState(
	hasPublishedSnapshot: boolean,
	hasUnpublishedChanges: boolean,
): MenuPublishState {
	if (!hasPublishedSnapshot) return 'not-published'
	return hasUnpublishedChanges ? 'pending' : 'published'
}
