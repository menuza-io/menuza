import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { formatDate, parseDate } from '@repo/staffing'
import { useDirection } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Calendar } from '@repo/ui/calendar'
import { Icon } from '@repo/ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/popover'
import { ar, enUS } from 'date-fns/locale'
import { useState } from 'react'
import { type PayPeriodRow } from '#app/utils/staffing/timesheet-types.ts'
import {
	formatDateLabel,
	formatPeriodLabel,
	shiftDate,
} from '#app/utils/staffing/timesheet-view.ts'

function toLocalDate(date: string): Date {
	const { year, month, day } = parseDate(date)
	return new Date(year, month - 1, day, 12)
}

function fromLocalDate(value: Date): string {
	return formatDate(value.getFullYear(), value.getMonth() + 1, value.getDate())
}

/**
 * Moves through days or pay periods. The previous and next dates of a period
 * come from the server (it knows the pay cadence and each scope's workweek);
 * the calendar picks any date and shows the period around it. "Today" is the
 * business date where the workplace is.
 */
export function PeriodNav({
	kind,
	date,
	period,
	today,
	locale,
	onChange,
	onSettings,
}: {
	kind: 'day' | 'period'
	date: string
	/** The period the server resolved for `date`; null while it is loading. */
	period: PayPeriodRow | null
	today: string
	locale: string
	onChange: (date: string) => void
	/** Offered to someone who may change the pay period. */
	onSettings?: () => void
}) {
	const { _ } = useLingui()
	const direction = useDirection()
	const [open, setOpen] = useState(false)

	const label =
		kind === 'day'
			? formatDateLabel(date, locale, {
					weekday: 'long',
					month: 'long',
					day: 'numeric',
					year: 'numeric',
				})
			: period
				? formatPeriodLabel(period.start, period.end, locale)
				: formatDateLabel(date, locale)
	const previous = kind === 'day' ? shiftDate(date, -1) : period?.previousStart
	const next = kind === 'day' ? shiftDate(date, 1) : period?.nextStart
	const isToday =
		kind === 'day'
			? date === today
			: period
				? today >= period.start && today <= period.end
				: date === today
	const inPeriod =
		kind === 'period' && period
			? { from: toLocalDate(period.start), to: toLocalDate(period.end) }
			: undefined
	const rtl = direction === 'rtl'

	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<Button
				variant="outline"
				size="icon"
				aria-label={kind === 'day' ? _(t`Previous day`) : _(t`Previous period`)}
				disabled={!previous}
				onClick={() => previous && onChange(previous)}
			>
				<Icon name={rtl ? 'chevron-right' : 'chevron-left'} />
			</Button>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger
					render={
						<Button
							variant="outline"
							className="h-11 min-w-48 justify-between gap-3"
							aria-label={_(t`Choose a date: ${label}`)}
						>
							<span className="tabular-nums">{label}</span>
							<Icon name="calendar" />
						</Button>
					}
				/>
				<PopoverContent align="start" className="w-auto p-1">
					{kind === 'period' && inPeriod ? (
						<Calendar
							mode="range"
							selected={inPeriod}
							defaultMonth={inPeriod.from}
							// A click picks the period that holds that day: the range only
							// shows where the current period sits.
							onSelect={(ignoredRange, picked) => {
								onChange(fromLocalDate(picked))
								setOpen(false)
							}}
							locale={locale.startsWith('ar') ? ar : enUS}
							dir={direction}
						/>
					) : (
						<Calendar
							mode="single"
							selected={toLocalDate(date)}
							defaultMonth={toLocalDate(date)}
							onSelect={(picked) => {
								if (!picked) return
								onChange(fromLocalDate(picked))
								setOpen(false)
							}}
							locale={locale.startsWith('ar') ? ar : enUS}
							dir={direction}
						/>
					)}
				</PopoverContent>
			</Popover>
			<Button
				variant="outline"
				size="icon"
				aria-label={kind === 'day' ? _(t`Next day`) : _(t`Next period`)}
				disabled={!next}
				onClick={() => next && onChange(next)}
			>
				<Icon name={rtl ? 'chevron-left' : 'chevron-right'} />
			</Button>
			<Button
				variant="ghost"
				disabled={isToday}
				onClick={() => onChange(today)}
			>
				{kind === 'day' ? <Trans>Today</Trans> : <Trans>This period</Trans>}
			</Button>
			{kind === 'period' && onSettings ? (
				<Button
					variant="ghost"
					size="icon"
					aria-label={_(t`Pay period settings`)}
					onClick={onSettings}
				>
					<Icon name="settings" />
				</Button>
			) : null}
		</div>
	)
}
