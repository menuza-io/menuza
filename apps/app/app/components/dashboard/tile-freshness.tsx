import { useLingui } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import { cn } from 'cn'
import { useMemo } from 'react'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'

/** When a tile should show the stale warning (15 minutes). */
export const TILE_STALE_MS = 15 * 60 * 1000

export type TileFreshnessProps = {
	updatedAt: number
	timeZone: string
	onRefresh?: () => void
	refreshing?: boolean
	className?: string
}

export function TileFreshness({
	updatedAt,
	timeZone,
	onRefresh,
	refreshing,
	className,
}: TileFreshnessProps) {
	const { i18n } = useLingui()
	const label = useMemo(
		() =>
			new Intl.DateTimeFormat(i18n.locale, {
				dateStyle: 'short',
				timeStyle: 'short',
				timeZone,
			}).format(new Date(updatedAt)),
		[i18n.locale, timeZone, updatedAt],
	)
	const stale = Date.now() - updatedAt > TILE_STALE_MS
	return (
		<div
			className={cn(
				'text-muted-foreground flex items-center gap-2 text-xs',
				stale && 'text-amber-700 dark:text-amber-500',
				className,
			)}
			data-testid="tile-freshness"
			data-updated-at={updatedAt}
		>
			<span>
				<Trans>Updated {label}</Trans>
			</span>
			{onRefresh ? (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-7 px-2"
					onClick={onRefresh}
					disabled={refreshing}
					data-testid="tile-refresh"
				>
					<Icon
						name="refresh-cw"
						className={cn('size-3.5', refreshing && 'animate-spin')}
					/>
					<span className="sr-only">
						<Trans>Refresh</Trans>
					</span>
				</Button>
			) : null}
		</div>
	)
}
