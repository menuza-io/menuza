import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { type DaysLeftOut } from '@repo/inventory'
import { cn } from '@repo/ui'

/**
 * Days of stock left (#492): "2.5 days", or "Not enough history" when the item
 * was used on fewer than seven days. An item not counted in 14 days shows the
 * number greyed with when it was last counted: the figure rests on a stock
 * level nobody has checked lately.
 */
export function DaysLeftText({
	daysLeft,
	lastCountedAt,
	showLastCounted = true,
	className,
}: {
	daysLeft: DaysLeftOut | undefined
	lastCountedAt: number | null
	showLastCounted?: boolean
	className?: string
}) {
	const { i18n } = useLingui()
	if (!daysLeft) return null
	if (daysLeft.state === 'not_enough_history') {
		return (
			<span
				className={cn('text-muted-foreground', className)}
				data-testid="days-left-not-enough"
			>
				<Trans>Not enough history</Trans>
			</span>
		)
	}
	const rounded =
		daysLeft.days >= 10
			? Math.round(daysLeft.days)
			: Math.round(daysLeft.days * 10) / 10
	const lastCounted = lastCountedAt === null ? null : new Date(lastCountedAt)
	return (
		<span
			className={cn(daysLeft.stale && 'text-muted-foreground', className)}
			data-stale={daysLeft.stale ? 'true' : undefined}
			data-testid="days-left"
		>
			<bdi dir="ltr" className="tabular-nums">
				<Plural value={rounded} one="# day" other="# days" />
			</bdi>
			{daysLeft.stale && !showLastCounted ? (
				<span className="sr-only">
					<Trans>Not counted lately</Trans>
				</span>
			) : null}
			{daysLeft.stale && showLastCounted ? (
				<span className="block text-xs" data-testid="days-left-last-counted">
					{lastCounted ? (
						<Trans>
							Last counted{' '}
							<bdi dir="ltr">
								{new Intl.DateTimeFormat(i18n.locale, {
									dateStyle: 'medium',
								}).format(lastCounted)}
							</bdi>
						</Trans>
					) : (
						<Trans>Never counted</Trans>
					)}
				</span>
			) : null}
		</span>
	)
}
