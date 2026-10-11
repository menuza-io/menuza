import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	addDays,
	findOverlappingShiftIds,
	localDateOf,
	paidMinutes,
	startOfWeek,
	summarizeSchedule,
	weekDates as datesOfWeek,
} from '@repo/staffing'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	positionSurfaceVariants,
	PositionSwatch,
	toPositionColor,
} from '@repo/ui/position-color'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
	data,
	type LoaderFunctionArgs,
	useLoaderData,
	useSearchParams,
} from 'react-router'
import { CopyWeekDialog } from '#app/components/staffing/copy-week-dialog.tsx'
import { PublishDialog } from '#app/components/staffing/publish-dialog.tsx'
import {
	ShiftDialog,
	type ShiftDialogTarget,
	type ShiftDraft,
} from '#app/components/staffing/shift-dialog.tsx'
import { staffingErrorMessage } from '#app/components/staffing/staffing-errors.ts'
import { useStaffingClient } from '#app/hooks/use-staffing-client.ts'
import { requireStaffingFeature } from '#app/utils/staffing/access.server.ts'
import {
	formatHours,
	formatWallDate,
	formatWallTime,
	publishResultSchema,
	type Schedule,
	scheduleSchema,
	type Shift,
	staffName,
} from '#app/utils/staffing/client.ts'
import {
	loadMemberNames,
	loadStaffingLocations,
} from '#app/utils/staffing/locations.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireStaffingFeature(
		request,
		params.orgSlug,
		'schedule',
		'read',
	)
	const [locations, memberNames] = await Promise.all([
		loadStaffingLocations(access.orgId),
		loadMemberNames(access.orgId),
	])
	return data(
		{
			orgSlug: params.orgSlug || '',
			canWrite: access.grants.schedule === 'write',
			locations: locations.filter((location) => location.isActive),
			memberNames,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export default function StaffSchedule() {
	const { orgSlug, canWrite, locations, memberNames } =
		useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const request = useStaffingClient(orgSlug)
	const [searchParams, setSearchParams] = useSearchParams()
	const location =
		locations.find((item) => item.id === searchParams.get('location')) ??
		locations[0] ??
		null
	const requestedDate = searchParams.get('date')
	const anchor =
		requestedDate && DATE_RE.test(requestedDate)
			? requestedDate
			: location
				? localDateOf(new Date(), location.timezone)
				: null
	const [weekStartSetting, setWeekStartSetting] = useState<'monday' | 'sunday'>(
		'monday',
	)
	const weekStart = anchor ? startOfWeek(anchor, weekStartSetting) : null
	const days = useMemo(
		() => (weekStart ? datesOfWeek(weekStart) : []),
		[weekStart],
	)

	const [schedule, setSchedule] = useState<Schedule | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [target, setTarget] = useState<ShiftDialogTarget | null>(null)
	const [dialog, setDialog] = useState<'copy' | 'publish' | null>(null)

	const refresh = useCallback(
		async (signal?: AbortSignal) => {
			if (!location || !weekStart) {
				setLoading(false)
				return
			}
			try {
				const query = new URLSearchParams({
					locationId: location.id,
					weekStart,
				})
				const body = await request<{ schedule: unknown }>(
					`/schedule?${query}`,
					{ signal },
				)
				if (signal?.aborted) return
				const parsed = scheduleSchema.parse(body.schedule)
				setWeekStartSetting(parsed.settings.weekStart)
				setSchedule(parsed)
				setError(null)
			} catch (caught) {
				if (!signal?.aborted) setError(staffingErrorMessage(i18n, caught))
			} finally {
				if (!signal?.aborted) setLoading(false)
			}
		},
		[request, i18n, location, weekStart],
	)

	useEffect(() => {
		const controller = new AbortController()
		void refresh(controller.signal)
		return () => controller.abort()
	}, [refresh])

	const navigate = (next: { location?: string; date?: string }) => {
		const params = new URLSearchParams(searchParams)
		if (next.location) params.set('location', next.location)
		if (next.date) params.set('date', next.date)
		setSearchParams(params, { replace: true })
	}

	const attempt = async (work: () => Promise<unknown>) => {
		try {
			await work()
			await refresh()
			return null
		} catch (caught) {
			return staffingErrorMessage(i18n, caught)
		}
	}

	const current =
		schedule &&
		schedule.weekStart === weekStart &&
		schedule.locationId === location?.id
			? schedule
			: null
	const live = useMemo(
		() => (current?.shifts ?? []).filter((shift) => shift.state !== 'removed'),
		[current],
	)
	const intervals = useMemo(
		() =>
			live.map((shift) => ({
				id: shift.id,
				staffId: shift.staffId,
				localDate: shift.localDate,
				startAt: new Date(shift.startAt),
				endAt: new Date(shift.endAt),
				unpaidBreakMinutes: shift.unpaidBreakMinutes,
			})),
		[live],
	)
	const overlapping = useMemo(
		() =>
			findOverlappingShiftIds([
				...intervals,
				...(current?.elsewhere ?? []).map((shift) => ({
					id: `elsewhere:${shift.id}`,
					staffId: shift.staffId,
					startAt: new Date(shift.startAt),
					endAt: new Date(shift.endAt),
				})),
			]),
		[intervals, current],
	)
	const summary = useMemo(() => summarizeSchedule(intervals), [intervals])
	const weekMinutes = intervals.reduce(
		(sum, shift) => sum + paidMinutes(shift),
		0,
	)
	const positionById = useMemo(
		() => new Map((current?.positions ?? []).map((item) => [item.id, item])),
		[current],
	)
	const threshold = current?.settings.weeklyHoursThreshold ?? null
	const shiftsByCell = useMemo(() => {
		const map = new Map<string, Shift[]>()
		for (const shift of current?.shifts ?? []) {
			const key = `${shift.staffId ?? 'open'}|${shift.localDate}`
			const list = map.get(key) ?? []
			list.push(shift)
			map.set(key, list)
		}
		return map
	}, [current])
	const rows = useMemo(() => {
		const staff = current?.staff ?? []
		return [...staff].sort((a, b) => {
			if (a.status !== b.status) return a.status === 'active' ? -1 : 1
			return staffName(a).localeCompare(staffName(b), i18n.locale)
		})
	}, [current, i18n.locale])

	if (!location) {
		return (
			<p className="bg-muted rounded-md p-3 text-sm">
				<Trans>
					Add an active location in Settings → Locations to build a schedule.
				</Trans>
			</p>
		)
	}

	const weekLabel = weekStart
		? formatWallDate(i18n.locale, weekStart, {
				month: 'short',
				day: 'numeric',
				year: 'numeric',
			})
		: ''
	const unpublishedCount = current?.unpublishedCount ?? 0
	const today = localDateOf(new Date(), location.timezone)
	const locationName = location.name

	const renderShift = (shift: Shift) => {
		const position = shift.positionId
			? positionById.get(shift.positionId)
			: null
		const removed = shift.state === 'removed'
		const conflict = overlapping.has(shift.id)
		const start = formatWallTime(i18n.locale, shift.startTime)
		const end = formatWallTime(i18n.locale, shift.endTime)
		return (
			<button
				key={shift.id}
				type="button"
				onClick={() => setTarget({ kind: 'edit', shift })}
				className={cn(
					positionSurfaceVariants({
						color: toPositionColor(position?.colorKey),
					}),
					'w-full rounded-md px-2 py-1 text-start text-xs',
					removed && 'text-muted-foreground line-through opacity-70',
					conflict && 'ring-destructive ring-2',
				)}
			>
				<span className="block font-medium tabular-nums">
					{start}–{end}
				</span>
				{position ? (
					<span className="block truncate">{position.name}</span>
				) : null}
				<span className="flex flex-wrap gap-1 print:hidden">
					{shift.state === 'draft' ? (
						<span className="text-muted-foreground">
							<Trans>Draft</Trans>
						</span>
					) : null}
					{shift.state === 'changed' ? (
						<span className="text-muted-foreground">
							<Trans>Edited</Trans>
						</span>
					) : null}
					{removed ? (
						<span>
							<Trans>Removed</Trans>
						</span>
					) : null}
					{conflict ? (
						<span className="text-destructive font-medium">
							<Trans>Overlaps</Trans>
						</span>
					) : null}
				</span>
			</button>
		)
	}

	const renderCell = (staffId: string | null, date: string) => {
		const cellShifts = shiftsByCell.get(`${staffId ?? 'open'}|${date}`) ?? []
		return (
			<td
				key={date}
				className={cn(
					'min-w-32 border-s p-1 align-top',
					date === today && 'bg-muted/30',
				)}
			>
				<div className="flex flex-col gap-1">
					{cellShifts.map(renderShift)}
					{canWrite ? (
						<button
							type="button"
							onClick={() =>
								setTarget({ kind: 'create', localDate: date, staffId })
							}
							className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring rounded-md py-1 text-xs focus-visible:ring-2 focus-visible:outline-none print:hidden"
						>
							<Icon name="plus" className="size-3" />
							<span className="sr-only">
								<Trans>Add shift</Trans>
							</span>
						</button>
					) : null}
				</div>
			</td>
		)
	}

	return (
		<div className="space-y-4">
			<div className="hidden print:block">
				<h2 className="text-lg font-semibold">
					<Trans>
						{locationName}: week of {weekLabel}
					</Trans>
				</h2>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
				<div className="flex flex-wrap items-center gap-2">
					{locations.length > 1 ? (
						<select
							aria-label={_(msg`Location`)}
							className="border-input bg-background h-9 rounded-md border px-2 text-sm"
							value={location.id}
							onChange={(event) => navigate({ location: event.target.value })}
						>
							{locations.map((item) => (
								<option key={item.id} value={item.id}>
									{item.name}
								</option>
							))}
						</select>
					) : null}
					<div className="flex items-center gap-1">
						<Button
							size="sm"
							variant="outline"
							aria-label={_(msg`Previous week`)}
							onClick={() =>
								weekStart && navigate({ date: addDays(weekStart, -7) })
							}
						>
							<Icon name="chevron-left" className="size-4 rtl:rotate-180" />
						</Button>
						<Button
							size="sm"
							variant="outline"
							onClick={() => navigate({ date: today })}
						>
							<Trans>This week</Trans>
						</Button>
						<Button
							size="sm"
							variant="outline"
							aria-label={_(msg`Next week`)}
							onClick={() =>
								weekStart && navigate({ date: addDays(weekStart, 7) })
							}
						>
							<Icon name="chevron-right" className="size-4 rtl:rotate-180" />
						</Button>
					</div>
					<h2 className="text-sm font-medium">
						<Trans>Week of {weekLabel}</Trans>
					</h2>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button variant="outline" onClick={() => window.print()}>
						<Trans>Print</Trans>
					</Button>
					{canWrite ? (
						<>
							<Button variant="outline" onClick={() => setDialog('copy')}>
								<Trans>Copy week</Trans>
							</Button>
							<Button
								disabled={unpublishedCount === 0}
								onClick={() => setDialog('publish')}
							>
								<Trans>Publish</Trans>
								{unpublishedCount > 0 ? (
									<Badge variant="secondary">{unpublishedCount}</Badge>
								) : null}
							</Button>
						</>
					) : null}
				</div>
			</div>

			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
			{overlapping.size > 0 ? (
				<p role="status" className="text-destructive text-sm print:hidden">
					<Trans>
						Some people are double-booked. Overlapping shifts are outlined.
					</Trans>
				</p>
			) : null}

			{loading && !current ? (
				<p role="status">
					<Trans>Loading schedule…</Trans>
				</p>
			) : current ? (
				<div className="overflow-x-auto rounded-lg border print:overflow-visible">
					<table className="w-full border-collapse text-sm">
						<thead className="bg-muted/50 text-xs">
							<tr>
								<th scope="col" className="min-w-40 p-2 text-start font-medium">
									<Trans>Team</Trans>
								</th>
								{days.map((date) => (
									<th
										key={date}
										scope="col"
										className={cn(
											'border-s p-2 text-start font-medium',
											date === today && 'text-primary',
										)}
									>
										{formatWallDate(i18n.locale, date)}
									</th>
								))}
								<th scope="col" className="border-s p-2 text-end font-medium">
									<Trans>Hours</Trans>
								</th>
							</tr>
						</thead>
						<tbody className="divide-border divide-y">
							<tr>
								<th
									scope="row"
									className="p-2 text-start align-top font-medium"
								>
									<Trans>Open shifts</Trans>
								</th>
								{days.map((date) => renderCell(null, date))}
								<td className="border-s p-2" />
							</tr>
							{rows.map((member) => {
								const minutes = summary.staffTotals.get(member.id) ?? 0
								const over =
									threshold !== null && minutes > Math.round(threshold * 60)
								const hours = formatHours(i18n.locale, minutes)
								const primary = member.positionIds[0]
									? positionById.get(member.positionIds[0])
									: null
								return (
									<tr key={member.id}>
										<th
											scope="row"
											className="p-2 text-start align-top font-normal"
										>
											<span className="flex items-center gap-2 font-medium">
												<PositionSwatch color={primary?.colorKey} />
												{staffName(member)}
											</span>
											{member.status === 'terminated' ? (
												<span className="text-muted-foreground text-xs">
													<Trans>Terminated</Trans>
												</span>
											) : !member.hasEmail ? (
												<span className="text-muted-foreground text-xs print:hidden">
													<Trans>No email</Trans>
												</span>
											) : null}
										</th>
										{days.map((date) => renderCell(member.id, date))}
										<td
											className={cn(
												'border-s p-2 text-end align-top tabular-nums',
												over && 'text-destructive font-medium',
											)}
										>
											{hours}
											{over ? (
												<span className="block text-xs">
													<Trans>Over weekly hours</Trans>
												</span>
											) : null}
										</td>
									</tr>
								)
							})}
						</tbody>
						<tfoot className="bg-muted/50 text-xs">
							<tr>
								<th scope="row" className="p-2 text-start font-medium">
									<Trans>Hours · people</Trans>
								</th>
								{days.map((date) => {
									const day = summary.days.get(date)
									const dayHours = formatHours(i18n.locale, day?.minutes ?? 0)
									const people = day?.headcount ?? 0
									return (
										<td key={date} className="border-s p-2 tabular-nums">
											<Trans>
												{dayHours} h · {people}
											</Trans>
										</td>
									)
								})}
								<td className="border-s p-2 text-end font-medium tabular-nums">
									{formatHours(i18n.locale, weekMinutes)}
								</td>
							</tr>
						</tfoot>
					</table>
				</div>
			) : null}

			{current && current.publications.length > 0 ? (
				<section className="space-y-2 print:hidden">
					<h3 className="text-sm font-medium">
						<Trans>Publish history</Trans>
					</h3>
					<ul className="divide-border divide-y rounded-lg border text-sm">
						{current.publications.map((publication) => {
							const when = i18n.date(new Date(publication.publishedAt), {
								dateStyle: 'medium',
								timeStyle: 'short',
							})
							const who =
								memberNames[publication.publishedBy] ?? _(msg`A former member`)
							const changed = publication.changedCount
							const notified = publication.notifiedCount
							const missed = publication.notNotifiedCount
							return (
								<li key={publication.id} className="flex flex-wrap gap-x-3 p-2">
									<span className="font-medium">{when}</span>
									<span>{who}</span>
									<span className="text-muted-foreground">
										<Trans>
											{changed} changes · {notified} emailed · {missed} not
											notified
										</Trans>
									</span>
								</li>
							)
						})}
					</ul>
				</section>
			) : null}

			{current ? (
				<ShiftDialog
					target={target}
					onOpenChange={(open) => {
						if (!open) setTarget(null)
					}}
					schedule={current}
					weekDates={days}
					canWrite={canWrite}
					onSave={(draft: ShiftDraft, alsoOn) =>
						attempt(() => {
							const shift = { ...draft, locationId: location.id }
							return target?.kind === 'edit'
								? request(`/shifts/${encodeURIComponent(target.shift.id)}`, {
										method: 'PATCH',
										body: JSON.stringify(shift),
									})
								: request('/shifts', {
										method: 'POST',
										body: JSON.stringify({ shift, alsoOn }),
									})
						})
					}
					onDelete={(shift) =>
						attempt(() =>
							request(`/shifts/${encodeURIComponent(shift.id)}`, {
								method: 'DELETE',
							}),
						)
					}
					onRestore={(shift) =>
						attempt(() =>
							request(`/shifts/${encodeURIComponent(shift.id)}/restore`, {
								method: 'POST',
							}),
						)
					}
				/>
			) : null}
			{current && weekStart ? (
				<CopyWeekDialog
					open={dialog === 'copy'}
					onOpenChange={(open) => setDialog(open ? 'copy' : null)}
					weekStart={weekStart}
					positions={current.positions}
					onCopy={async (input) => {
						try {
							const body = await request<{
								result: { created: number; opened: number }
							}>('/schedule/copy-week', {
								method: 'POST',
								body: JSON.stringify({
									...input,
									locationId: location.id,
									toWeekStart: weekStart,
								}),
							})
							await refresh()
							return body.result
						} catch (caught) {
							return { error: staffingErrorMessage(i18n, caught) }
						}
					}}
				/>
			) : null}
			{current && weekStart ? (
				<PublishDialog
					open={dialog === 'publish'}
					onOpenChange={(open) => setDialog(open ? 'publish' : null)}
					unpublishedCount={unpublishedCount}
					weekLabel={weekLabel}
					onPublish={async () => {
						try {
							const body = await request<{ result: unknown }>(
								'/schedule/publish',
								{
									method: 'POST',
									body: JSON.stringify({
										locationId: location.id,
										weekStart,
										locationName: location.name,
										emailLocale: i18n.locale.startsWith('ar') ? 'ar' : 'en',
									}),
								},
							)
							const result = publishResultSchema.parse(body.result)
							await refresh()
							return { result }
						} catch (caught) {
							return { error: staffingErrorMessage(i18n, caught) }
						}
					}}
				/>
			) : null}
		</div>
	)
}
