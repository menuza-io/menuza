import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Item, ItemGroup } from '@repo/ui/item'
import { Skeleton } from '@repo/ui/skeleton'
import { useState } from 'react'
import {
	type MyAvailability,
	type MyRequests,
	type MyScheduleApi,
	type MyShiftRequest,
	type MyTimeOff,
} from '#app/utils/my-schedule/my-schedule-api.ts'
import {
	formatDay,
	formatRange,
	formatSpan,
	intlLocale,
} from '#app/utils/my-schedule/my-schedule-format.ts'
import { describeMyScheduleError } from '#app/utils/my-schedule/my-schedule-messages.ts'
import {
	formatMinute,
	weekdayName,
} from '#app/utils/staffing/schedule-requests.ts'
import { AvailabilitySheet } from './availability-sheet.tsx'
import { RequestStatus } from './status-badge.tsx'
import { TimeOffSheet } from './time-off-sheet.tsx'

/**
 * Everything the person has asked for, and the two things they can start from
 * here: time off and availability. Swaps, covers and drops start from a shift on
 * the schedule. A request that is still waiting can be taken back; once a
 * manager has answered, that is theirs to change.
 */
export function RequestsView({
	api,
	requests,
	error,
	loading,
	today,
	locale,
	onChanged,
}: {
	api: MyScheduleApi
	requests: MyRequests | null
	error: unknown
	loading: boolean
	today: string
	locale: string
	onChanged: () => void
}) {
	const { _ } = useLingui()
	const [sheet, setSheet] = useState<'time-off' | 'availability' | null>(null)
	const [busy, setBusy] = useState<string | null>(null)
	const [failure, setFailure] = useState<string | null>(null)

	async function cancel(id: string, run: () => Promise<unknown>) {
		if (busy) return
		setBusy(id)
		setFailure(null)
		try {
			await run()
			onChanged()
		} catch (problem) {
			setFailure(describeMyScheduleError(problem, _))
		} finally {
			setBusy(null)
		}
	}

	const numeric = intlLocale(locale)
	const timeOffWhen = (row: MyTimeOff) =>
		row.startDate === row.endDate
			? formatDay(row.startDate, locale)
			: formatSpan(row.startDate, row.endDate, locale)
	const kindLabel = (category: string) =>
		category === 'sick'
			? _(t`Sick`)
			: category === 'pto'
				? _(t`Paid time off`)
				: _(t`Unpaid time off`)
	const availabilityLabel = (row: MyAvailability) => {
		const day =
			row.kind === 'weekly' && row.weekday !== null
				? weekdayName(row.weekday, numeric)
				: row.date
					? formatDay(row.date, locale)
					: ''
		const free = row.availability === 'available'
		const hours =
			row.allDay || row.startMinute === null || row.endMinute === null
				? null
				: `${formatMinute(row.startMinute, numeric)} – ${formatMinute(row.endMinute, numeric)}`
		if (hours) {
			return free
				? _(t`${day}: available ${hours}`)
				: _(t`${day}: unavailable ${hours}`)
		}
		return free
			? _(t`${day}: available all day`)
			: _(t`${day}: unavailable all day`)
	}
	const shiftRequestLabel = (row: MyShiftRequest) => {
		const when = `${formatDay(row.localDate, locale)}, ${formatRange(row.startsAt, row.endsAt, row.timeZone, locale)}`
		const who = row.targetName ?? ''
		return row.kind === 'swap'
			? _(t`Swap ${when} with ${who}`)
			: row.kind === 'cover'
				? _(t`${who} to cover ${when}`)
				: _(t`Give away ${when}`)
	}

	if (!requests) {
		return error ? (
			<Alert>
				<AlertDescription>{describeMyScheduleError(error, _)}</AlertDescription>
			</Alert>
		) : (
			<div aria-hidden={!loading} className="flex flex-col gap-3">
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-16 w-full" />
			</div>
		)
	}

	const shown = {
		timeOff: requests.timeOff.filter(
			(row) => row.status !== 'cancelled' && row.endDate >= today,
		),
		availability: requests.availability.filter(
			(row) => row.status === 'pending',
		),
		shiftRequests: requests.shiftRequests.filter(
			(row) =>
				row.status !== 'cancelled' && row.endsAt > Date.now() - 86_400_000,
		),
	}

	return (
		<div className="flex flex-col gap-8">
			{failure ? (
				<Alert variant="destructive">
					<AlertDescription>{failure}</AlertDescription>
				</Alert>
			) : null}

			<section
				aria-labelledby="time-off-heading"
				className="flex flex-col gap-3"
			>
				<div className="flex items-center justify-between gap-3">
					<h2 id="time-off-heading" className="text-base font-semibold">
						<Trans>Time off</Trans>
					</h2>
					<Button
						type="button"
						variant="outline"
						className="h-11"
						onClick={() => setSheet('time-off')}
					>
						<Trans>Request time off</Trans>
					</Button>
				</div>
				{shown.timeOff.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No time off requested.</Trans>
					</p>
				) : (
					<ItemGroup className="gap-2">
						{shown.timeOff.map((row) => (
							<Item variant="outline" size="sm" role="listitem" key={row.id}>
								<div className="flex w-full flex-col gap-2">
									<div className="flex flex-wrap items-start justify-between gap-2">
										<div>
											<p className="text-sm font-medium">
												<bdi>{timeOffWhen(row)}</bdi>
											</p>
											<p className="text-muted-foreground text-sm">
												{kindLabel(row.category)}
												{!row.allDay &&
												row.startMinute !== null &&
												row.endMinute !== null ? (
													<>
														{' · '}
														<bdi>
															{formatMinute(row.startMinute, numeric)} –{' '}
															{formatMinute(row.endMinute, numeric)}
														</bdi>
													</>
												) : null}
											</p>
										</div>
										<RequestStatus status={row.status} />
									</div>
									{row.decisionNote ? (
										<p className="text-sm text-pretty">{row.decisionNote}</p>
									) : null}
									{row.status === 'pending' ? (
										<Button
											size="sm"
											type="button"
											variant="ghost"
											className="h-11 self-start"
											disabled={busy === row.id}
											onClick={() =>
												void cancel(row.id, () => api.cancelTimeOff(row.id))
											}
										>
											<Trans>Cancel request</Trans>
										</Button>
									) : null}
								</div>
							</Item>
						))}
					</ItemGroup>
				)}
			</section>

			<section
				aria-labelledby="availability-heading"
				className="flex flex-col gap-3"
			>
				<div className="flex items-center justify-between gap-3">
					<h2 id="availability-heading" className="text-base font-semibold">
						<Trans>Availability</Trans>
					</h2>
					<Button
						type="button"
						variant="outline"
						className="h-11"
						onClick={() => setSheet('availability')}
					>
						<Trans>Update availability</Trans>
					</Button>
				</div>
				{shown.availability.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>Nothing waiting for a manager.</Trans>
					</p>
				) : (
					<ItemGroup className="gap-2">
						{shown.availability.map((row) => (
							<Item variant="outline" size="sm" role="listitem" key={row.id}>
								<div className="flex w-full flex-wrap items-center justify-between gap-2">
									<p className="text-sm">{availabilityLabel(row)}</p>
									<div className="flex items-center gap-2">
										<RequestStatus status={row.status} />
										<Button
											size="sm"
											type="button"
											variant="ghost"
											className="h-11"
											disabled={busy === row.id}
											onClick={() =>
												void cancel(row.id, () =>
													api.cancelAvailability(row.id),
												)
											}
										>
											<Trans>Cancel</Trans>
										</Button>
									</div>
								</div>
							</Item>
						))}
					</ItemGroup>
				)}
			</section>

			<section
				aria-labelledby="shift-changes-heading"
				className="flex flex-col gap-3"
			>
				<h2 id="shift-changes-heading" className="text-base font-semibold">
					<Trans>Shift changes</Trans>
				</h2>
				{shown.shiftRequests.length === 0 ? (
					<p className="text-muted-foreground text-sm text-balance">
						<Trans>
							To give away, cover or swap a shift, open it on your schedule and
							choose Ask for a change.
						</Trans>
					</p>
				) : (
					<ItemGroup className="gap-2">
						{shown.shiftRequests.map((row) => (
							<Item variant="outline" size="sm" role="listitem" key={row.id}>
								<div className="flex w-full flex-col gap-2">
									<div className="flex flex-wrap items-start justify-between gap-2">
										<p className="text-sm font-medium text-pretty">
											{shiftRequestLabel(row)}
										</p>
										<RequestStatus status={row.status} />
									</div>
									{row.decisionNote ? (
										<p className="text-sm text-pretty">{row.decisionNote}</p>
									) : null}
									{row.status === 'pending' ? (
										<Button
											size="sm"
											type="button"
											variant="ghost"
											className="h-11 self-start"
											disabled={busy === row.id}
											onClick={() =>
												void cancel(row.id, () =>
													api.cancelShiftRequest(row.id),
												)
											}
										>
											<Trans>Cancel request</Trans>
										</Button>
									) : null}
								</div>
							</Item>
						))}
					</ItemGroup>
				)}
			</section>

			<TimeOffSheet
				open={sheet === 'time-off'}
				api={api}
				today={today}
				locale={locale}
				onClose={() => setSheet(null)}
				onDone={() => {
					setSheet(null)
					onChanged()
				}}
			/>
			<AvailabilitySheet
				open={sheet === 'availability'}
				api={api}
				locale={locale}
				onClose={() => setSheet(null)}
				onDone={() => {
					setSheet(null)
					onChanged()
				}}
			/>
		</div>
	)
}
