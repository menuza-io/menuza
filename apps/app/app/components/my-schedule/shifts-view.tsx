import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Item, ItemGroup } from '@repo/ui/item'
import { Skeleton } from '@repo/ui/skeleton'
import { useMemo, useState } from 'react'
import {
	type MyScheduleApi,
	type MySchedule,
	type MyShift,
} from '#app/utils/my-schedule/my-schedule-api.ts'
import {
	formatDay,
	formatRange,
	formatSpan,
	groupByDay,
	todayIn,
} from '#app/utils/my-schedule/my-schedule-format.ts'
import { describeMyScheduleError } from '#app/utils/my-schedule/my-schedule-messages.ts'
import { ShiftChangeSheet } from './shift-change-sheet.tsx'

/**
 * The person's own published shifts, one row per day: the day, the hours, the
 * role and place. Today is marked and past shifts fade. The page prints as it
 * reads. Each upcoming shift has one action, "Ask for a change", which opens a
 * short request (give away, ask a teammate to cover, swap) that a manager
 * decides.
 */
export function ShiftsView({
	api,
	schedule,
	error,
	refreshing,
	locale,
	canGoEarlier,
	onEarlier,
	onLater,
	onToday,
	onChanged,
}: {
	api: MyScheduleApi
	schedule: MySchedule | null
	error: unknown
	refreshing: boolean
	locale: string
	canGoEarlier: boolean
	onEarlier: () => void
	onLater: () => void
	onToday: () => void
	onChanged: () => void
}) {
	const { _ } = useLingui()
	const [changing, setChanging] = useState<MyShift | null>(null)
	const groups = useMemo(
		() => (schedule ? groupByDay(schedule.shifts) : []),
		[schedule],
	)

	if (!schedule) {
		return error ? (
			<Alert>
				<AlertDescription>{describeMyScheduleError(error, _)}</AlertDescription>
			</Alert>
		) : (
			<div aria-hidden="true" className="flex flex-col gap-3">
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-16 w-full" />
			</div>
		)
	}

	const zones = schedule.scopes
	const manyPlaces = zones.length > 1
	const placeName = (id: string) =>
		zones.find((place) => place.id === id)?.name ?? null
	const firstZone = zones[0]?.timeZone ?? 'UTC'
	const today = todayIn(schedule.serverNow, firstZone)
	const span = formatSpan(schedule.from, schedule.to, locale)

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between gap-2 print:hidden">
				<div className="flex items-center gap-1">
					<Button
						type="button"
						variant="outline"
						size="icon"
						className="size-11"
						aria-label={_(t`Earlier weeks`)}
						disabled={!canGoEarlier || refreshing}
						onClick={onEarlier}
					>
						<Icon name="chevron-left" className="rtl:rotate-180" />
					</Button>
					<Button
						type="button"
						variant="outline"
						size="icon"
						className="size-11"
						aria-label={_(t`Later weeks`)}
						disabled={refreshing}
						onClick={onLater}
					>
						<Icon name="chevron-right" className="rtl:rotate-180" />
					</Button>
				</div>
				<p
					className="text-muted-foreground text-sm tabular-nums"
					aria-live="polite"
				>
					<bdi>{span}</bdi>
				</p>
				<Button
					type="button"
					variant="ghost"
					className="h-11"
					onClick={onToday}
				>
					<Trans>Today</Trans>
				</Button>
			</div>

			{error ? (
				<Alert>
					<AlertDescription>
						{describeMyScheduleError(error, _)}
					</AlertDescription>
				</Alert>
			) : null}

			<div data-print-root="" className="flex flex-col gap-2">
				<p className="hidden text-lg font-semibold print:block">
					{schedule.person.firstName} · <bdi>{span}</bdi>
				</p>
				{groups.length === 0 ? (
					<p className="text-muted-foreground py-8 text-center text-sm text-balance">
						<Trans>
							No shifts are published for these dates. When your manager
							publishes the schedule, you will get an email.
						</Trans>
					</p>
				) : (
					<div className={cn(refreshing && 'opacity-70')}>
						<ItemGroup className="gap-2">
							{groups.map((group) => {
								const isToday = group.date === today
								const past = group.date < today
								return (
									<Item
										variant={isToday ? 'muted' : 'outline'}
										size="sm"
										role="listitem"
										key={group.date}
										aria-current={isToday ? 'date' : undefined}
									>
										<div
											className={cn(
												'flex w-full gap-4',
												past && 'text-muted-foreground',
											)}
										>
											<div className="w-16 shrink-0">
												<p className="text-sm font-semibold">
													{formatDay(group.date, locale, { weekday: 'short' })}
												</p>
												<p className="text-muted-foreground text-xs tabular-nums">
													{formatDay(group.date, locale, {
														month: 'short',
														day: 'numeric',
													})}
												</p>
												{isToday ? (
													<p className="text-xs font-medium">
														<Trans>Today</Trans>
													</p>
												) : null}
											</div>
											<ul className="flex min-w-0 flex-1 flex-col gap-3">
												{group.shifts.map((shift) => {
													const role =
														locale.startsWith('ar') && shift.positionNameAr
															? shift.positionNameAr
															: shift.positionName
													const place = manyPlaces
														? placeName(shift.scopeId)
														: null
													const upcoming = shift.startsAt > schedule.serverNow
													const detail = [role, place]
														.filter(Boolean)
														.join(' · ')
													return (
														<li
															key={shift.id}
															className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1"
														>
															<div className="min-w-0">
																<p className="text-base font-medium tabular-nums">
																	<bdi>
																		{formatRange(
																			shift.startsAt,
																			shift.endsAt,
																			shift.timeZone,
																			locale,
																		)}
																	</bdi>
																</p>
																{detail ? (
																	<p className="text-muted-foreground text-sm">
																		{detail}
																	</p>
																) : null}
																{shift.unpaidBreakMinutes > 0 ? (
																	<p className="text-muted-foreground text-xs">
																		{plural(shift.unpaidBreakMinutes, {
																			one: '# minute unpaid break',
																			other: '# minutes unpaid break',
																		})}
																	</p>
																) : null}
																{shift.notes ? (
																	<p className="mt-1 text-sm text-pretty">
																		{shift.notes}
																	</p>
																) : null}
															</div>
															{upcoming ? (
																<Button
																	size="sm"
																	type="button"
																	variant="ghost"
																	className="h-11 shrink-0 print:hidden"
																	onClick={() => setChanging(shift)}
																>
																	<Trans>Ask for a change</Trans>
																</Button>
															) : null}
														</li>
													)
												})}
											</ul>
										</div>
									</Item>
								)
							})}
						</ItemGroup>
					</div>
				)}
			</div>

			<ShiftChangeSheet
				api={api}
				shift={changing}
				locale={locale}
				onClose={() => setChanging(null)}
				onDone={() => {
					setChanging(null)
					onChanged()
				}}
			/>
		</div>
	)
}
