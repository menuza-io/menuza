import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { hasBlockingIssue, resolveLocalCardTimes } from '@repo/staffing'
import { Button } from '@repo/ui/button'
import { FieldError } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Item, ItemContent, ItemGroup } from '@repo/ui/item'
import { Label } from '@repo/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { formatClockDateTime } from '#app/utils/staffing/timeclock-format.ts'
import { describeTimesheetError } from '#app/utils/staffing/timesheet-errors.ts'
import { type TimesheetReviewData } from '#app/utils/staffing/timesheet-types.ts'
import {
	calendarDateOf,
	displayName,
	flattenRows,
	formatDateLabel,
	isReviewIssue,
	positionLabel,
	sortIssues,
	timeInputOf,
	type TimesheetRow,
} from '#app/utils/staffing/timesheet-view.ts'
import { StatusBadge, useIssueText } from './card-status.tsx'

type Props = {
	data: TimesheetReviewData
	client: StaffClient
	locale: string
	scopeNames: ReadonlyMap<string, string>
	showScope: boolean
	canUpdate: boolean
	cardHref: (id: string) => string
	onChanged: () => void
	/** Server clock, so a wrong device clock cannot let a future time through. */
	now: number
}

/**
 * The needs-review queue: the cards that cannot go to payroll as they are,
 * oldest first. Each says what is wrong in one line and offers the quickest
 * honest fix: type the missing clock-out right here, or press "Looks right" for
 * an issue that only needs a manager's eyes. Anything that needs real editing
 * opens the card.
 */
export function ReviewQueue({
	data,
	client,
	locale,
	scopeNames,
	showScope,
	canUpdate,
	cardHref,
	onChanged,
	now,
}: Props) {
	const { _ } = useLingui()
	const text = useIssueText()
	const [issue, setIssue] = useState('all')
	const [bulkBusy, setBulkBusy] = useState(false)

	const rows = useMemo(
		() =>
			flattenRows(data.people).sort(
				(a, b) => a.card.clockInAt - b.card.clockInAt,
			),
		[data.people],
	)
	const visible = useMemo(
		() =>
			issue === 'all'
				? rows
				: rows.filter((row) => row.card.issues.includes(issue)),
		[rows, issue],
	)
	const issueCounts = Object.entries(data.byIssue)
		.filter(([, count]) => count > 0)
		.sort(([a], [b]) => a.localeCompare(b))
	const reviewable = visible.filter(
		(row) =>
			row.card.status === 'needs_review' &&
			row.card.clockOutAt !== null &&
			!hasBlockingIssue(row.card.issues),
	)

	const reviewableCount = reviewable.length

	async function markAllReviewed() {
		if (bulkBusy || reviewable.length === 0) return
		setBulkBusy(true)
		let done = 0
		let failed = 0
		for (const row of reviewable) {
			try {
				await client.request(
					`/timesheets/entries/${encodeURIComponent(row.card.id)}/review`,
					{ method: 'POST', json: { expectedVersion: row.card.version } },
				)
				done += 1
			} catch {
				failed += 1
			}
		}
		setBulkBusy(false)
		if (done > 0) {
			toast.success(
				plural(done, {
					one: '# card marked as reviewed',
					other: '# cards marked as reviewed',
				}),
			)
		}
		if (failed > 0) {
			toast.error(
				plural(failed, {
					one: '# card changed while you were looking. Reloaded.',
					other: '# cards changed while you were looking. Reloaded.',
				}),
			)
		}
		onChanged()
	}

	if (rows.length === 0) {
		return (
			<EmptyState
				title={
					<>
						<Trans>Nothing needs review</Trans>
					</>
				}
				description={
					<>
						<Trans>
							Cards with a missing clock-out, a missed break or a very long
							shift show up here until someone looks at them.
						</Trans>
					</>
				}
				icons={['circle-check', 'clock', 'shield-check']}
			/>
		)
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<ToggleGroup
					aria-label={_(t`Filter by issue`)}
					value={[issue]}
					onValueChange={(next) => {
						const picked = next[0]
						if (picked) setIssue(picked)
					}}
					variant="segmented"
					className="flex-wrap"
				>
					<ToggleGroupItem className="h-11 md:h-7" value="all">
						<Trans>All</Trans>
						<span className="text-muted-foreground tabular-nums">
							{rows.length}
						</span>
					</ToggleGroupItem>
					{issueCounts.map(([code, count]) => (
						<ToggleGroupItem className="h-11 md:h-7" key={code} value={code}>
							{text.label(code)}
							<span className="text-muted-foreground tabular-nums">
								{count}
							</span>
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				{canUpdate && reviewable.length > 1 ? (
					<Button
						variant="outline"
						disabled={bulkBusy}
						onClick={() => void markAllReviewed()}
					>
						<Icon name="check" />
						{bulkBusy ? (
							<Trans>Marking…</Trans>
						) : (
							<Trans>Mark {reviewableCount} as reviewed</Trans>
						)}
					</Button>
				) : null}
			</div>

			{data.truncated ? (
				<p role="status" className="text-muted-foreground text-sm">
					<Trans>
						There are more cards than we can show here. Resolve these first.
					</Trans>
				</p>
			) : null}

			{visible.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>Nothing left with that issue.</Trans>
				</p>
			) : (
				<ItemGroup className="gap-2">
					{visible.map((row) => (
						<ReviewItem
							key={row.card.id}
							row={row}
							client={client}
							locale={locale}
							place={showScope ? scopeNames.get(row.card.scopeId) : undefined}
							canUpdate={canUpdate}
							href={cardHref(row.card.id)}
							onChanged={onChanged}
							now={now}
						/>
					))}
				</ItemGroup>
			)}
		</div>
	)
}

function ReviewItem({
	row,
	client,
	locale,
	place,
	canUpdate,
	href,
	onChanged,
	now,
}: {
	row: TimesheetRow
	client: StaffClient
	locale: string
	place?: string
	canUpdate: boolean
	href: string
	onChanged: () => void
	now: number
}) {
	const { _ } = useLingui()
	const text = useIssueText()
	const action = useStaffAction(describeTimesheetError)
	const { person, card } = row
	const name = displayName(person, locale)
	const position = positionLabel(card, locale)
	const issues = sortIssues(card.issues).filter(isReviewIssue)
	const missingOut = card.clockOutAt === null
	const blocking = missingOut || hasBlockingIssue(card.issues)
	const [endTime, setEndTime] = useState('')
	const [clientError, setClientError] = useState<string | null>(null)

	const resolved = useMemo(() => {
		if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) return null
		return resolveLocalCardTimes(
			{
				date: calendarDateOf(card.clockInAt, card.timeZone),
				startTime: timeInputOf(card.clockInAt, card.timeZone),
				endTime,
			},
			card.timeZone,
		).clockOutAt
	}, [endTime, card.clockInAt, card.timeZone])

	async function setClockOut() {
		if (resolved === null) {
			setClientError(_(t`Enter the time they left.`))
			return
		}
		if (resolved > now) {
			setClientError(_(t`That time has not happened yet.`))
			return
		}
		// Typed text cannot tell the two 1:30s of a clock-change night apart, so a
		// time that lands before the real clock-in is refused here, not sent.
		if (resolved <= card.clockInAt) {
			setClientError(_(t`That time is before they clocked in.`))
			return
		}
		setClientError(null)
		const result = await action.run(() =>
			client.request(`/timesheets/entries/${encodeURIComponent(card.id)}`, {
				method: 'PATCH',
				json: {
					expectedVersion: card.version,
					clockOutAt: resolved,
					reason: _(t`Forgot to clock out`),
				},
			}),
		)
		if (result.ok) {
			toast.success(_(t`Clock-out set for ${name}.`))
			onChanged()
		}
	}

	async function lookedAtIt() {
		const result = await action.run(() =>
			client.request(
				`/timesheets/entries/${encodeURIComponent(card.id)}/review`,
				{ method: 'POST', json: { expectedVersion: card.version } },
			),
		)
		if (result.ok) {
			toast.success(_(t`Marked as reviewed.`))
			onChanged()
		}
	}

	const day = formatDateLabel(card.localDate, locale)
	const since = formatClockDateTime(card.clockInAt, now, card.timeZone, locale)
	const error = clientError ?? action.error
	const range = missingOut
		? _(t`In ${since}`)
		: `${since} – ${formatClockDateTime(card.clockOutAt!, now, card.timeZone, locale)}`
	const leftAt =
		resolved === null
			? null
			: `${formatClockDateTime(resolved, resolved, card.timeZone, locale)}${
					calendarDateOf(resolved, card.timeZone) !== card.localDate
						? ` (${formatDateLabel(calendarDateOf(resolved, card.timeZone), locale)})`
						: ''
				}`

	return (
		<Item variant="outline">
			<ItemContent className="w-full">
				<div className="flex flex-col gap-3">
					<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
						<Link
							to={href}
							className="focus-visible:ring-ring/50 -m-1 flex min-h-11 min-w-0 flex-col justify-center rounded p-1 outline-none focus-visible:ring-3"
						>
							<span className="text-sm font-medium">{name}</span>
							<span className="text-muted-foreground text-xs">
								{[day, position, place].filter(Boolean).join(' · ')}
							</span>
						</Link>
						<span className="flex items-center gap-2">
							<span className="text-muted-foreground text-sm tabular-nums">
								{range}
							</span>
							<StatusBadge status={card.status} />
						</span>
					</div>

					<ul className="flex flex-col gap-0.5 text-sm">
						{issues.map((code) => (
							<li key={code} className="flex items-start gap-2">
								<Icon
									name="alert-triangle"
									className="text-muted-foreground mt-0.5 size-4 shrink-0"
								/>
								<span>
									<span className="font-medium">{text.label(code)}.</span>{' '}
									<span className="text-muted-foreground">
										{text.help(code)}
									</span>
								</span>
							</li>
						))}
					</ul>

					{canUpdate ? (
						<div className="flex flex-wrap items-center gap-2">
							{missingOut ? (
								<>
									<Label className="sr-only" htmlFor={`out-${card.id}`}>
										<Trans>Clocked out at, for {name}</Trans>
									</Label>
									<Input
										id={`out-${card.id}`}
										type="time"
										step={60}
										dir="ltr"
										value={endTime}
										onChange={(event) => {
											setEndTime(event.target.value)
											setClientError(null)
										}}
										onKeyDown={(event) => {
											if (event.key === 'Enter') {
												event.preventDefault()
												void setClockOut()
											}
										}}
										aria-invalid={error ? true : undefined}
										className="h-11 w-36 md:h-8"
									/>
									<Button
										size="sm"
										disabled={action.pending || endTime === ''}
										onClick={() => void setClockOut()}
									>
										{action.pending ? (
											<Trans>Saving…</Trans>
										) : (
											<Trans>Set clock-out</Trans>
										)}
									</Button>
									{leftAt ? (
										<span className="text-muted-foreground text-xs">
											<Trans>Left {leftAt}</Trans>
										</span>
									) : null}
								</>
							) : blocking ? (
								<Button size="sm" render={<Link to={href} />}>
									<Icon name="pencil" />
									<Trans>Fix this card</Trans>
								</Button>
							) : (
								<>
									<Button
										size="sm"
										disabled={action.pending}
										onClick={() => void lookedAtIt()}
									>
										<Icon name="check" />
										{action.pending ? (
											<Trans>Saving…</Trans>
										) : (
											<Trans>Looks right</Trans>
										)}
									</Button>
									<Button
										size="sm"
										variant="outline"
										render={<Link to={href} />}
									>
										<Icon name="pencil" />
										<Trans>Edit</Trans>
									</Button>
								</>
							)}
							{missingOut ? (
								<Button size="sm" variant="ghost" render={<Link to={href} />}>
									<Trans>Edit card</Trans>
								</Button>
							) : null}
						</div>
					) : null}
					{error ? <FieldError>{error}</FieldError> : null}
				</div>
			</ItemContent>
		</Item>
	)
}
