import { type I18n } from '@lingui/core'
import { msg, Plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { addDays, localDateOf, startOfWeek } from '@repo/staffing'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
	data,
	type LoaderFunctionArgs,
	useLoaderData,
	useSearchParams,
} from 'react-router'
import { EntryHistoryDialog } from '#app/components/staffing/entry-history-dialog.tsx'
import { staffingErrorMessage } from '#app/components/staffing/staffing-errors.ts'
import {
	TimeEntryDialog,
	type TimeEntryDraft,
	type TimeEntryTarget,
} from '#app/components/staffing/time-entry-dialog.tsx'
import { useStaffingClient } from '#app/hooks/use-staffing-client.ts'
import { requireStaffingFeature } from '#app/utils/staffing/access.server.ts'
import {
	approveResultSchema,
	formatHours,
	formatWallDate,
	formatZonedTime,
	staffName,
	type TimeEntry,
	type Timesheet,
	timesheetSchema,
} from '#app/utils/staffing/client.ts'
import {
	loadMemberNames,
	loadStaffingLocations,
} from '#app/utils/staffing/locations.server.ts'
import { timesheetCsv } from '#app/utils/staffing/timesheet-csv.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireStaffingFeature(
		request,
		params.orgSlug,
		'timeclock',
		'read',
	)
	const [locations, memberNames] = await Promise.all([
		loadStaffingLocations(access.orgId),
		loadMemberNames(access.orgId),
	])
	return data(
		{
			orgSlug: params.orgSlug || '',
			canWrite: access.grants.timeclock === 'write',
			locations: locations.filter((location) => location.isActive),
			memberNames,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type Issue = TimeEntry['issues'][number]
type Status = 'approved' | 'pending' | 'open'
type Filter = 'all' | 'attention' | 'pending'

function entryStatus(entry: TimeEntry): Status {
	if (!entry.clockOutAt) return 'open'
	return entry.approvedAt ? 'approved' : 'pending'
}

function issueLabel(i18n: I18n, issue: Issue) {
	switch (issue) {
		case 'missing_clock_out':
			return i18n._(msg`Missing clock-out`)
		case 'unscheduled':
			return i18n._(msg`Not scheduled`)
		case 'late':
			return i18n._(msg`Late`)
	}
}

function statusLabel(i18n: I18n, status: Status) {
	switch (status) {
		case 'approved':
			return i18n._(msg`Approved`)
		case 'pending':
			return i18n._(msg`Needs approval`)
		case 'open':
			return i18n._(msg`Clocked in`)
	}
}

function downloadCsv(filename: string, csv: string) {
	const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
	const url = URL.createObjectURL(blob)
	const link = document.createElement('a')
	link.href = url
	link.download = filename
	link.click()
	URL.revokeObjectURL(url)
}

function ReopenDialog({
	entry,
	onOpenChange,
	onReopen,
}: {
	entry: TimeEntry | null
	onOpenChange: (open: boolean) => void
	onReopen: (entry: TimeEntry, reason: string) => Promise<string | null>
}) {
	const [reason, setReason] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	useEffect(() => {
		setReason('')
		setError(null)
	}, [entry])
	if (!entry) return null
	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent>
				<form
					className="space-y-4"
					onSubmit={async (event) => {
						event.preventDefault()
						setBusy(true)
						const message = await onReopen(entry, reason.trim())
						setBusy(false)
						if (message) setError(message)
						else onOpenChange(false)
					}}
				>
					<DialogHeader>
						<DialogTitle>
							<Trans>Reopen time card</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								Reopening removes the approval so the card can be edited. It
								will need to be approved again.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor="reopen-reason">
							<Trans>Reason</Trans>
						</Label>
						<Input
							id="reopen-reason"
							required
							maxLength={500}
							value={reason}
							onChange={(event) => setReason(event.target.value)}
						/>
					</div>
					{error ? (
						<p role="alert" className="text-destructive text-sm">
							{error}
						</p>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={busy || !reason.trim()}>
							<Trans>Reopen</Trans>
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

export default function StaffTimesheets() {
	const { orgSlug, canWrite, locations, memberNames } =
		useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const request = useStaffingClient(orgSlug)
	const [searchParams, setSearchParams] = useSearchParams()
	const location =
		locations.find((item) => item.id === searchParams.get('location')) ??
		locations[0] ??
		null
	const view = searchParams.get('view') === 'day' ? 'day' : 'week'
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
	const from = anchor
		? view === 'day'
			? anchor
			: startOfWeek(anchor, weekStartSetting)
		: null
	const to = from ? (view === 'day' ? from : addDays(from, 6)) : null

	const [sheet, setSheet] = useState<Timesheet | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [selected, setSelected] = useState<Set<string>>(new Set())
	const [filter, setFilter] = useState<Filter>('all')
	const [target, setTarget] = useState<TimeEntryTarget | null>(null)
	const [historyFor, setHistoryFor] = useState<TimeEntry | null>(null)
	const [reopenFor, setReopenFor] = useState<TimeEntry | null>(null)
	const [approving, setApproving] = useState(false)

	const refresh = useCallback(
		async (signal?: AbortSignal) => {
			if (!location || !from || !to) {
				setLoading(false)
				return
			}
			try {
				const query = new URLSearchParams({ locationId: location.id, from, to })
				const body = await request<{ timesheet: unknown }>(
					`/timesheets?${query}`,
					{ signal },
				)
				if (signal?.aborted) return
				const parsed = timesheetSchema.parse(body.timesheet)
				setWeekStartSetting(parsed.settings.weekStart)
				setSheet(parsed)
				setError(null)
			} catch (caught) {
				if (!signal?.aborted) setError(staffingErrorMessage(i18n, caught))
			} finally {
				if (!signal?.aborted) setLoading(false)
			}
		},
		[request, i18n, location, from, to],
	)

	useEffect(() => {
		const controller = new AbortController()
		void refresh(controller.signal)
		return () => controller.abort()
	}, [refresh])

	useEffect(() => {
		setSelected(new Set())
	}, [location?.id, from, to])

	const navigate = (next: {
		location?: string
		date?: string
		view?: 'day' | 'week'
	}) => {
		const params = new URLSearchParams(searchParams)
		if (next.location) params.set('location', next.location)
		if (next.date) params.set('date', next.date)
		if (next.view) params.set('view', next.view)
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
		sheet && sheet.from === from && sheet.locationId === location?.id
			? sheet
			: null
	const staffById = useMemo(
		() => new Map((current?.staff ?? []).map((member) => [member.id, member])),
		[current],
	)
	const positionById = useMemo(
		() => new Map((current?.positions ?? []).map((item) => [item.id, item])),
		[current],
	)
	const nameOf = useCallback(
		(staffId: string) => {
			const member = staffById.get(staffId)
			return member ? staffName(member) : _(msg`Removed person`)
		},
		[staffById, _],
	)
	const positionName = useCallback(
		(positionId: string | null) =>
			positionId
				? (positionById.get(positionId)?.name ?? _(msg`Removed position`))
				: _(msg`No position`),
		[positionById, _],
	)
	const entries = useMemo(() => {
		const list = [...(current?.entries ?? [])].sort(
			(a, b) =>
				a.localDate.localeCompare(b.localDate) ||
				nameOf(a.staffId).localeCompare(nameOf(b.staffId), i18n.locale) ||
				a.clockInAt.localeCompare(b.clockInAt),
		)
		if (filter === 'attention') {
			return list.filter((entry) => entry.issues.length > 0)
		}
		if (filter === 'pending') {
			return list.filter((entry) => entryStatus(entry) === 'pending')
		}
		return list
	}, [current, filter, nameOf, i18n.locale])

	const all = current?.entries ?? []
	const totalMinutes = all.reduce((sum, entry) => sum + entry.paidMinutes, 0)
	const pendingIds = all
		.filter((entry) => entryStatus(entry) === 'pending')
		.map((entry) => entry.id)
	const attentionCount = all.filter((entry) => entry.issues.length > 0).length
	const openCount = all.filter((entry) => !entry.clockOutAt).length
	const selectable = entries.filter((entry) => entryStatus(entry) === 'pending')
	const allSelected =
		selectable.length > 0 && selectable.every((entry) => selected.has(entry.id))
	const threshold = current?.settings.weeklyHoursThreshold ?? null
	const weeks = useMemo(
		() =>
			[...(current?.weeks ?? [])].sort(
				(a, b) =>
					a.weekStart.localeCompare(b.weekStart) ||
					nameOf(a.staffId).localeCompare(nameOf(b.staffId), i18n.locale),
			),
		[current, nameOf, i18n.locale],
	)

	if (!location) {
		return (
			<p className="bg-muted rounded-md p-3 text-sm">
				<Trans>
					Add an active location in Settings → Locations to track time.
				</Trans>
			</p>
		)
	}

	const today = localDateOf(new Date(), location.timezone)
	const step = view === 'day' ? 1 : 7
	const rangeLabel =
		from && to
			? view === 'day'
				? formatWallDate(i18n.locale, from, {
						weekday: 'long',
						month: 'short',
						day: 'numeric',
						year: 'numeric',
					})
				: `${formatWallDate(i18n.locale, from, { month: 'short', day: 'numeric' })} – ${formatWallDate(
						i18n.locale,
						to,
						{ month: 'short', day: 'numeric', year: 'numeric' },
					)}`
			: ''

	const approve = async (ids: string[]) => {
		if (!ids.length) return
		setApproving(true)
		setNotice(null)
		try {
			const body = await request<{ result: unknown }>('/time-entries/approve', {
				method: 'POST',
				body: JSON.stringify({ locationId: location.id, entryIds: ids }),
			})
			const { result } = approveResultSchema.parse(body)
			const approved = result.approved
			const skipped = result.skipped.length
			setNotice(
				skipped
					? _(msg`Approved ${approved}. ${skipped} could not be approved.`)
					: _(msg`Approved ${approved}.`),
			)
			setSelected(new Set())
			await refresh()
		} catch (caught) {
			setError(staffingErrorMessage(i18n, caught))
		} finally {
			setApproving(false)
		}
	}

	const exportCsv = () => {
		if (!current || !from || !to) return
		const csv = timesheetCsv(
			current,
			{
				person: _(msg`Person`),
				date: _(msg`Date`),
				position: _(msg`Position`),
				clockIn: _(msg`Clock in`),
				clockOut: _(msg`Clock out`),
				unpaidBreak: _(msg`Unpaid break (minutes)`),
				paidHours: _(msg`Paid hours`),
				status: _(msg`Status`),
				issues: _(msg`Issues`),
				source: _(msg`Source`),
				note: _(msg`Note`),
				weeklyTotals: _(msg`Weekly totals`),
				weekStarting: _(msg`Week starting`),
				regularHours: _(msg`Regular hours`),
				overThresholdHours: _(msg`Hours over weekly threshold`),
				statusLabel: (status) => statusLabel(i18n, status),
				issueLabel: (issue) => issueLabel(i18n, issue),
				sourceLabel: (source) =>
					source === 'kiosk' ? _(msg`Time clock`) : _(msg`Manager`),
			},
			nameOf,
		)
		const slug = location.name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
		downloadCsv(`timesheet-${slug || 'location'}-${from}-to-${to}.csv`, csv)
	}

	const totalHours = formatHours(i18n.locale, totalMinutes)
	const pendingCount = pendingIds.length
	const selectedCount = selected.size

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
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
					<div
						className="flex items-center gap-1"
						role="group"
						aria-label={_(msg`View`)}
					>
						<Button
							size="sm"
							variant={view === 'day' ? 'default' : 'outline'}
							aria-pressed={view === 'day'}
							onClick={() => navigate({ view: 'day', date: from ?? today })}
						>
							<Trans>Day</Trans>
						</Button>
						<Button
							size="sm"
							variant={view === 'week' ? 'default' : 'outline'}
							aria-pressed={view === 'week'}
							onClick={() => navigate({ view: 'week' })}
						>
							<Trans>Week</Trans>
						</Button>
					</div>
					<div className="flex items-center gap-1">
						<Button
							size="sm"
							variant="outline"
							aria-label={
								view === 'day' ? _(msg`Previous day`) : _(msg`Previous week`)
							}
							onClick={() => from && navigate({ date: addDays(from, -step) })}
						>
							<Icon name="chevron-left" className="size-4 rtl:rotate-180" />
						</Button>
						<Button
							size="sm"
							variant="outline"
							onClick={() => navigate({ date: today })}
						>
							{view === 'day' ? <Trans>Today</Trans> : <Trans>This week</Trans>}
						</Button>
						<Button
							size="sm"
							variant="outline"
							aria-label={view === 'day' ? _(msg`Next day`) : _(msg`Next week`)}
							onClick={() => from && navigate({ date: addDays(from, step) })}
						>
							<Icon name="chevron-right" className="size-4 rtl:rotate-180" />
						</Button>
					</div>
					<h2 className="text-sm font-medium">{rangeLabel}</h2>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button variant="outline" disabled={!current} onClick={exportCsv}>
						<Icon name="download" className="size-4" />
						<Trans>Export CSV</Trans>
					</Button>
					{canWrite ? (
						<>
							<Button
								variant="outline"
								disabled={!current}
								onClick={() =>
									setTarget({
										kind: 'create',
										localDate:
											view === 'day' ||
											!from ||
											!to ||
											today < from ||
											today > to
												? (from ?? today)
												: today,
									})
								}
							>
								<Icon name="plus" className="size-4" />
								<Trans>Add time card</Trans>
							</Button>
							<Button
								disabled={approving || pendingCount === 0}
								onClick={() =>
									void approve(selectedCount ? [...selected] : pendingIds)
								}
							>
								{selectedCount ? (
									<Trans>Approve selected ({selectedCount})</Trans>
								) : (
									<Trans>Approve all ({pendingCount})</Trans>
								)}
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
			{notice ? (
				<p role="status" className="text-sm">
					{notice}
				</p>
			) : null}

			{current ? (
				<dl className="grid gap-3 sm:grid-cols-4">
					<div className="rounded-lg border p-3">
						<dt className="text-muted-foreground text-xs">
							<Trans>Paid hours</Trans>
						</dt>
						<dd className="text-lg font-semibold tabular-nums">{totalHours}</dd>
					</div>
					<div className="rounded-lg border p-3">
						<dt className="text-muted-foreground text-xs">
							<Trans>Needs approval</Trans>
						</dt>
						<dd className="text-lg font-semibold tabular-nums">
							{pendingCount}
						</dd>
					</div>
					<div className="rounded-lg border p-3">
						<dt className="text-muted-foreground text-xs">
							<Trans>Needs attention</Trans>
						</dt>
						<dd
							className={cn(
								'text-lg font-semibold tabular-nums',
								attentionCount > 0 && 'text-destructive',
							)}
						>
							{attentionCount}
						</dd>
					</div>
					<div className="rounded-lg border p-3">
						<dt className="text-muted-foreground text-xs">
							<Trans>Clocked in now</Trans>
						</dt>
						<dd className="text-lg font-semibold tabular-nums">{openCount}</dd>
					</div>
				</dl>
			) : null}

			{current ? (
				<div className="flex items-center gap-2">
					<Label htmlFor="timesheet-filter" className="text-sm">
						<Trans>Show</Trans>
					</Label>
					<select
						id="timesheet-filter"
						className="border-input bg-background h-9 rounded-md border px-2 text-sm"
						value={filter}
						onChange={(event) => setFilter(event.target.value as Filter)}
					>
						<option value="all">{_(msg`All time cards`)}</option>
						<option value="attention">{_(msg`Needs attention`)}</option>
						<option value="pending">{_(msg`Needs approval`)}</option>
					</select>
				</div>
			) : null}

			{loading && !current ? (
				<p role="status">
					<Trans>Loading timesheet…</Trans>
				</p>
			) : current && entries.length === 0 ? (
				<p className="bg-muted rounded-md p-3 text-sm">
					{filter === 'all' ? (
						<Trans>No time cards for these dates.</Trans>
					) : (
						<Trans>Nothing matches this filter.</Trans>
					)}
				</p>
			) : current ? (
				<div className="overflow-x-auto rounded-lg border">
					<table className="w-full border-collapse text-sm">
						<thead className="bg-muted/50 text-xs">
							<tr>
								{canWrite ? (
									<th scope="col" className="w-10 p-2">
										<Checkbox
											aria-label={_(msg`Select all that need approval`)}
											checked={allSelected}
											disabled={selectable.length === 0}
											onCheckedChange={(checked) =>
												setSelected(
													checked === true
														? new Set(selectable.map((entry) => entry.id))
														: new Set(),
												)
											}
										/>
									</th>
								) : null}
								<th scope="col" className="p-2 text-start font-medium">
									<Trans>Person</Trans>
								</th>
								<th scope="col" className="p-2 text-start font-medium">
									<Trans>Date</Trans>
								</th>
								<th scope="col" className="p-2 text-start font-medium">
									<Trans>Position</Trans>
								</th>
								<th scope="col" className="p-2 text-start font-medium">
									<Trans>Scheduled</Trans>
								</th>
								<th scope="col" className="p-2 text-start font-medium">
									<Trans>Clock in</Trans>
								</th>
								<th scope="col" className="p-2 text-start font-medium">
									<Trans>Clock out</Trans>
								</th>
								<th scope="col" className="p-2 text-end font-medium">
									<Trans>Break</Trans>
								</th>
								<th scope="col" className="p-2 text-end font-medium">
									<Trans>Paid hours</Trans>
								</th>
								<th scope="col" className="p-2 text-start font-medium">
									<Trans>Status</Trans>
								</th>
								<th scope="col" className="p-2">
									<span className="sr-only">
										<Trans>Actions</Trans>
									</span>
								</th>
							</tr>
						</thead>
						<tbody className="divide-border divide-y">
							{entries.map((entry) => {
								const status = entryStatus(entry)
								const name = nameOf(entry.staffId)
								const zone = entry.timeZone
								const device = entry.deviceId
									? current.devices[entry.deviceId]
									: null
								const breakMinutes = entry.unpaidBreakMinutes
								return (
									<tr key={entry.id} className="align-top">
										{canWrite ? (
											<td className="p-2">
												<Checkbox
													aria-label={_(msg`Select ${name}`)}
													checked={selected.has(entry.id)}
													disabled={status !== 'pending'}
													onCheckedChange={(checked) =>
														setSelected((currentSet) => {
															const next = new Set(currentSet)
															if (checked === true) next.add(entry.id)
															else next.delete(entry.id)
															return next
														})
													}
												/>
											</td>
										) : null}
										<th scope="row" className="p-2 text-start font-medium">
											{name}
											{entry.source === 'kiosk' && device ? (
												<span className="text-muted-foreground block text-xs font-normal">
													{device}
												</span>
											) : null}
										</th>
										<td className="p-2 whitespace-nowrap">
											{formatWallDate(i18n.locale, entry.localDate)}
										</td>
										<td className="p-2">
											{entry.positionId ? positionName(entry.positionId) : '—'}
										</td>
										<td className="text-muted-foreground p-2 whitespace-nowrap tabular-nums">
											{entry.scheduled
												? `${formatZonedTime(i18n.locale, entry.scheduled.startAt, zone)}–${formatZonedTime(
														i18n.locale,
														entry.scheduled.endAt,
														zone,
													)}`
												: '—'}
										</td>
										<td className="p-2 whitespace-nowrap tabular-nums">
											{formatZonedTime(i18n.locale, entry.clockInAt, zone)}
										</td>
										<td className="p-2 whitespace-nowrap tabular-nums">
											{entry.clockOutAt
												? formatZonedTime(i18n.locale, entry.clockOutAt, zone)
												: '—'}
										</td>
										<td className="p-2 text-end tabular-nums">
											{breakMinutes ? <Trans>{breakMinutes} min</Trans> : '—'}
										</td>
										<td className="p-2 text-end tabular-nums">
											{formatHours(i18n.locale, entry.paidMinutes)}
										</td>
										<td className="p-2">
											<div className="flex flex-wrap gap-1">
												<Badge
													variant={
														status === 'approved' ? 'default' : 'secondary'
													}
												>
													{statusLabel(i18n, status)}
												</Badge>
												{entry.issues.map((issue) => (
													<Badge key={issue} variant="destructive">
														{issueLabel(i18n, issue)}
													</Badge>
												))}
												{entry.edited ? (
													<Badge variant="outline">
														<Trans>Edited</Trans>
													</Badge>
												) : null}
											</div>
											{entry.note ? (
												<p className="text-muted-foreground mt-1 text-xs">
													{entry.note}
												</p>
											) : null}
										</td>
										<td className="p-2">
											<div className="flex justify-end gap-1">
												{canWrite && status !== 'approved' ? (
													<Button
														size="sm"
														variant="ghost"
														onClick={() => setTarget({ kind: 'edit', entry })}
													>
														<Trans>Edit</Trans>
													</Button>
												) : null}
												{canWrite && status === 'approved' ? (
													<Button
														size="sm"
														variant="ghost"
														onClick={() => setReopenFor(entry)}
													>
														<Trans>Reopen</Trans>
													</Button>
												) : null}
												<Button
													size="sm"
													variant="ghost"
													onClick={() => setHistoryFor(entry)}
												>
													<Trans>History</Trans>
												</Button>
											</div>
										</td>
									</tr>
								)
							})}
						</tbody>
					</table>
				</div>
			) : null}

			{current && weeks.length > 0 ? (
				<section className="space-y-2">
					<h3 className="text-sm font-medium">
						<Trans>Weekly totals</Trans>
					</h3>
					<p className="text-muted-foreground text-xs">
						{threshold !== null ? (
							<Trans>
								Totals count every location this person worked that week. Hours
								over {threshold} a week are shown separately.
							</Trans>
						) : (
							<Trans>
								Totals count every location this person worked that week. Set a
								weekly hours threshold in schedule settings to flag extra hours.
							</Trans>
						)}
					</p>
					<div className="overflow-x-auto rounded-lg border">
						<table className="w-full border-collapse text-sm">
							<thead className="bg-muted/50 text-xs">
								<tr>
									<th scope="col" className="p-2 text-start font-medium">
										<Trans>Person</Trans>
									</th>
									<th scope="col" className="p-2 text-start font-medium">
										<Trans>Week starting</Trans>
									</th>
									<th scope="col" className="p-2 text-end font-medium">
										<Trans>Paid hours</Trans>
									</th>
									{threshold !== null ? (
										<>
											<th scope="col" className="p-2 text-end font-medium">
												<Trans>Regular hours</Trans>
											</th>
											<th scope="col" className="p-2 text-end font-medium">
												<Trans>Over threshold</Trans>
											</th>
										</>
									) : null}
								</tr>
							</thead>
							<tbody className="divide-border divide-y">
								{weeks.map((week) => (
									<tr key={`${week.staffId}|${week.weekStart}`}>
										<th scope="row" className="p-2 text-start font-medium">
											{nameOf(week.staffId)}
										</th>
										<td className="p-2">
											{formatWallDate(i18n.locale, week.weekStart)}
										</td>
										<td className="p-2 text-end tabular-nums">
											{formatHours(i18n.locale, week.paidMinutes)}
										</td>
										{threshold !== null ? (
											<>
												<td className="p-2 text-end tabular-nums">
													{formatHours(i18n.locale, week.regularMinutes)}
												</td>
												<td
													className={cn(
														'p-2 text-end tabular-nums',
														week.overThresholdMinutes > 0 &&
															'text-destructive font-medium',
													)}
												>
													{formatHours(i18n.locale, week.overThresholdMinutes)}
												</td>
											</>
										) : null}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</section>
			) : null}

			{current && openCount > 0 ? (
				<p className="text-muted-foreground text-xs">
					<Plural
						value={openCount}
						one="# person is still clocked in. Open cards can’t be approved until they clock out or you add a clock-out time."
						other="# people are still clocked in. Open cards can’t be approved until they clock out or you add a clock-out time."
					/>
				</p>
			) : null}

			{current ? (
				<TimeEntryDialog
					target={target}
					onOpenChange={(open) => {
						if (!open) setTarget(null)
					}}
					sheet={current}
					onSave={(draft: TimeEntryDraft) =>
						attempt(() => {
							const { staffId, ...fields } = draft
							return target?.kind === 'edit'
								? request(
										`/time-entries/${encodeURIComponent(target.entry.id)}`,
										{ method: 'PATCH', body: JSON.stringify(fields) },
									)
								: request('/time-entries', {
										method: 'POST',
										body: JSON.stringify({
											...fields,
											staffId,
											locationId: location.id,
										}),
									})
						})
					}
					onDelete={(entry, reason) =>
						attempt(() =>
							request(`/time-entries/${encodeURIComponent(entry.id)}`, {
								method: 'DELETE',
								body: JSON.stringify({ reason }),
							}),
						)
					}
				/>
			) : null}
			<EntryHistoryDialog
				entry={historyFor}
				onOpenChange={(open) => {
					if (!open) setHistoryFor(null)
				}}
				request={request}
				memberNames={memberNames}
				positionName={positionName}
				personName={historyFor ? nameOf(historyFor.staffId) : ''}
			/>
			<ReopenDialog
				entry={reopenFor}
				onOpenChange={(open) => {
					if (!open) setReopenFor(null)
				}}
				onReopen={(entry, reason) =>
					attempt(() =>
						request(`/time-entries/${encodeURIComponent(entry.id)}/reopen`, {
							method: 'POST',
							body: JSON.stringify({ reason }),
						}),
					)
				}
			/>
		</div>
	)
}
