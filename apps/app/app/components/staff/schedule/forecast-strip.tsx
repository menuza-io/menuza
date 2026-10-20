import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { type ForecastDayRow } from '#app/utils/staffing/labor-types.ts'
import { formatShare } from '#app/utils/staffing/labor-view.ts'
import { type DayShare } from '#app/utils/staffing/schedule-labor.ts'
import { formatMoneyMinor } from '#app/utils/staffing/staff-format.ts'

/**
 * A day's coverage against the orders you usually get, as 24 thin cells: red
 * where fewer people are scheduled than the staffing standards say the hour
 * needs, grey where there are clearly more, and a faint fill where the two
 * match. It compares past orders with the schedule; it is not a forecast of
 * sales. The cells are read as one sentence, and the day's totals sit under
 * them in words, so nothing depends on color alone.
 */
export function ForecastCells({ day }: { day: ForecastDayRow }) {
	const { _ } = useLingui()
	const short = Math.round(day.shortHours * 10) / 10
	const over = Math.round(day.surplusHours * 10) / 10
	const label =
		short > 0 && over > 0
			? _(
					t`Short by ${short} person-hours and ${over} over, against the orders you usually get`,
				)
			: short > 0
				? _(
						t`Short by ${short} person-hours against the orders you usually get`,
					)
				: over > 0
					? _(t`${over} person-hours more than the orders you usually need`)
					: day.neededHours > 0
						? _(t`Scheduled to match the orders you usually get`)
						: _(t`No orders usually expected`)
	return (
		<div className="flex flex-col gap-1">
			<div
				role="img"
				aria-label={label}
				title={label}
				// Earliest hour on the left, like a clock face, in either direction.
				dir="ltr"
				className="flex h-3 items-stretch gap-px"
			>
				{day.hours.map((slot) => (
					<span
						key={slot.hour}
						className={cn(
							'min-w-0 flex-1 rounded-xs',
							slot.status === 'short' && 'bg-destructive/60',
							slot.status === 'over' && 'bg-foreground/20',
							slot.status === 'ok' && 'bg-primary/35',
							slot.status === 'quiet' && 'bg-muted',
						)}
					/>
				))}
			</div>
			{short > 0 || over > 0 ? (
				<p className="text-xs tabular-nums">
					{short > 0 ? (
						<span className="text-destructive font-medium">
							<Trans>Short {short} h</Trans>
						</span>
					) : null}
					{short > 0 && over > 0 ? ' · ' : null}
					{over > 0 ? (
						<span className="text-muted-foreground">
							<Trans>Over {over} h</Trans>
						</span>
					) : null}
				</p>
			) : null}
		</div>
	)
}

/** A day's labor share in the footer: a plain figure, marked only when judged. */
export function ShareCell({
	shares,
	costByCurrency,
	locale,
}: {
	shares: readonly DayShare[]
	costByCurrency: Readonly<Record<string, number>>
	locale: string
}) {
	return (
		<>
			{shares.map((share) => (
				<div
					key={share.currency}
					className={cn(
						'tabular-nums',
						share.targetStatus === 'over' && 'text-destructive font-medium',
					)}
				>
					{share.laborBp !== null ? (
						<>
							{formatShare(share.laborBp, locale)}
							{share.targetStatus ? (
								<span className="sr-only">
									{' '}
									{share.targetStatus === 'over' ? (
										<Trans>over target</Trans>
									) : (
										<Trans>within target</Trans>
									)}
								</span>
							) : null}
						</>
					) : (
						<span
							className="text-muted-foreground"
							title={formatMoneyMinor(
								costByCurrency[share.currency] ?? 0,
								share.currency,
								locale,
							)}
						>
							<Trans>No sales guide</Trans>
						</span>
					)}
				</div>
			))}
		</>
	)
}
