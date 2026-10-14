import { Plural, Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Skeleton } from '@repo/ui/skeleton'
import { useEffect, useMemo, useState } from 'react'
import {
	type ScheduleWeek,
	weekViewSchema,
} from '#app/utils/staffing/schedule-types.ts'
import {
	formatDuration,
	monthWeekStarts,
	sevenDays,
} from '#app/utils/staffing/schedule-view.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { formatMoneyMinor } from '#app/utils/staffing/staff-format.ts'
import { formatDateLabel } from '#app/utils/staffing/timesheet-view.ts'

type MonthState =
	| { status: 'loading' }
	| { status: 'error' }
	| { status: 'ready'; weeks: ScheduleWeek[] }

/** Each week of the month is its own request: week-scoped fetches, no month-sized payload. */
function useMonthWeeks(
	client: StaffClient,
	ready: boolean,
	scopeId: string,
	date: string,
	weekStartsOn: number,
	reloadKey: number,
): MonthState {
	const [state, setState] = useState<MonthState>({ status: 'loading' })
	const starts = useMemo(
		() => monthWeekStarts(date, weekStartsOn),
		[date, weekStartsOn],
	)
	const key = starts.join(',')
	useEffect(() => {
		if (!ready || !scopeId) return
		let live = true
		setState((current) =>
			current.status === 'ready' ? current : { status: 'loading' },
		)
		Promise.all(
			starts.map(async (start) => {
				const query = new URLSearchParams({ scopeId, date: start })
				return weekViewSchema.parse(
					await client.request(`/week?${query.toString()}`),
				)
			}),
		).then(
			(weeks) => live && setState({ status: 'ready', weeks }),
			() => live && setState({ status: 'error' }),
		)
		return () => {
			live = false
		}
		// `starts` is derived from `key`.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client, ready, scopeId, key, reloadKey])
	return state
}

/**
 * The month at a glance: for each day, how many people work, the scheduled
 * hours and any open shifts. A day opens in the day view.
 */
export function MonthView({
	client,
	ready,
	scopeId,
	date,
	weekStartsOn,
	today,
	locale,
	showCost,
	reloadKey,
	onPickDate,
}: {
	client: StaffClient
	ready: boolean
	scopeId: string
	date: string
	weekStartsOn: number
	today: string
	locale: string
	showCost: boolean
	reloadKey: number
	onPickDate: (date: string, view: 'week' | 'day') => void
}) {
	const { _ } = useLingui()
	const state = useMonthWeeks(
		client,
		ready,
		scopeId,
		date,
		weekStartsOn,
		reloadKey,
	)
	const month = date.slice(0, 7)
	const weeks = state.status === 'ready' ? state.weeks : null
	const headings =
		weeks?.[0]?.dates ??
		sevenDays(monthWeekStarts(date, weekStartsOn)[0] ?? date)

	if (state.status === 'error') {
		return (
			<Alert variant="destructive">
				<AlertDescription>
					<Trans>We could not load the month. Try again.</Trans>
				</AlertDescription>
			</Alert>
		)
	}

	return (
		<div data-print-root="" className="flex flex-col gap-2">
			<div
				className="grid grid-cols-7 gap-px"
				aria-hidden={weeks ? undefined : true}
			>
				{headings.map((d) => (
					<div
						key={d}
						className="text-muted-foreground px-2 py-1 text-xs font-medium"
					>
						{formatDateLabel(d, locale, { weekday: 'short' })}
					</div>
				))}
			</div>
			{weeks ? (
				<div className="border-border bg-border grid grid-cols-7 gap-px overflow-hidden rounded-lg border">
					{weeks.flatMap((week) =>
						week.dates.map((d) => {
							const footer = week.footers.find((f) => f.date === d)
							const inMonth = d.startsWith(month)
							const people = footer?.headcount ?? 0
							const open = footer?.openShifts ?? 0
							const cost = footer?.costMinorByCurrency
							const dayName = formatDateLabel(d, locale, {
								weekday: 'long',
								month: 'long',
								day: 'numeric',
							})
							return (
								<div
									key={d}
									className={cn('bg-background', !inMonth && 'bg-muted/40')}
								>
									<Button
										type="button"
										variant="ghost"
										onClick={() => onPickDate(d, 'day')}
										aria-label={_(
											t`${dayName}: ${people} people scheduled, ${open} open shifts. Open this day.`,
										)}
										className={cn(
											'h-auto min-h-20 w-full flex-col items-start justify-start gap-0.5 rounded-none p-2 text-start font-normal md:min-h-24',
											!inMonth && 'text-muted-foreground',
										)}
									>
										<span
											className={cn(
												'text-sm font-semibold tabular-nums',
												d === today && 'text-primary',
											)}
										>
											{formatDateLabel(d, locale, { day: 'numeric' })}
										</span>
										{people + open > 0 ? (
											<span className="text-xs tabular-nums">
												<Plural
													value={people}
													one="# person"
													other="# people"
												/>
											</span>
										) : null}
										{footer && footer.minutes > 0 ? (
											<span className="text-muted-foreground text-xs tabular-nums">
												{formatDuration(footer.minutes)}
											</span>
										) : null}
										{open > 0 ? (
											<span className="text-xs font-medium tabular-nums">
												<Plural value={open} one="# open" other="# open" />
											</span>
										) : null}
										{showCost && cost
											? Object.entries(cost).map(([currency, minor]) => (
													<span
														key={currency}
														className="text-muted-foreground hidden text-xs tabular-nums md:block"
													>
														{formatMoneyMinor(minor, currency, locale)}
													</span>
												))
											: null}
									</Button>
								</div>
							)
						}),
					)}
				</div>
			) : (
				<Skeleton className="h-96 w-full" />
			)}
		</div>
	)
}
