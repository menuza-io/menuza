import { Plural, Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Icon } from '@repo/ui/icon'
import { Item, ItemGroup } from '@repo/ui/item'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { Skeleton } from '@repo/ui/skeleton'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { SheetPanel } from '#app/components/staff/sheet-frame.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { resendNotices } from '#app/utils/staffing/schedule-api.ts'
import { describeScheduleError } from '#app/utils/staffing/schedule-errors.ts'
import {
	noticesSchema,
	publicationsSchema,
	type SchedulePersonRow,
	type SchedulePublicationRow,
} from '#app/utils/staffing/schedule-types.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import { formatPeriodLabel } from '#app/utils/staffing/timesheet-view.ts'
import {
	NotReachedList,
	usePersonName,
	useReasonLabel,
} from './notice-lists.tsx'

/**
 * Everything published for the week on screen, newest first: when, what
 * changed, who was told and who was not. This is the change-after-publish
 * record: every later edit appears as its own publication. A manager who can
 * edit the schedule can resend the latest one to the people it has not reached.
 * Only ids and counts are stored with a publication; names come from the week
 * on screen.
 */
export function PublicationHistorySheet({
	open,
	onClose,
	client,
	ready,
	scopeId,
	week,
	locale,
	canWrite,
}: {
	open: boolean
	onClose: () => void
	client: StaffClient
	ready: boolean
	scopeId: string
	week: {
		weekStart: string
		weekEnd: string
		timeZone: string
		people: SchedulePersonRow[]
	}
	locale: string
	canWrite: boolean
}) {
	const { _ } = useLingui()
	const query = useStaffQuery(
		client,
		open && ready
			? `/publications?${new URLSearchParams({ scopeId, weekStart: week.weekStart })}`
			: null,
		publicationsSchema,
	)
	const rows = query.data ?? []
	return (
		<Sheet open={open} onOpenChange={(next) => !next && onClose()}>
			<SheetContent className="sm:max-w-md">
				<SheetPanel
					title={_(t`Publish history`)}
					description={formatPeriodLabel(week.weekStart, week.weekEnd, locale)}
				>
					{query.error && !query.data ? (
						<div className="flex flex-col items-start gap-3">
							<Alert>
								<AlertDescription>
									{describeStaffError(query.error, _)}
								</AlertDescription>
							</Alert>
							<Button variant="outline" onClick={query.reload}>
								<Trans>Try again</Trans>
							</Button>
						</div>
					) : query.loading ? (
						<div aria-hidden="true" className="flex flex-col gap-3">
							<Skeleton className="h-14 w-full" />
							<Skeleton className="h-14 w-full" />
						</div>
					) : rows.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>This week has not been published yet.</Trans>
						</p>
					) : (
						<ItemGroup className="gap-2">
							{rows.map((row, index) => (
								<PublicationItem
									key={row.id}
									row={row}
									first={index === 0}
									client={client}
									week={week}
									locale={locale}
									canWrite={canWrite}
								/>
							))}
						</ItemGroup>
					)}
				</SheetPanel>
			</SheetContent>
		</Sheet>
	)
}

function PublicationItem({
	row,
	first,
	client,
	week,
	locale,
	canWrite,
}: {
	row: SchedulePublicationRow
	first: boolean
	client: StaffClient
	week: { timeZone: string; people: SchedulePersonRow[] }
	locale: string
	canWrite: boolean
}) {
	const { _ } = useLingui()
	const [expanded, setExpanded] = useState(first)
	const panelId = useId()
	const when = formatWhen(row.publishedAt, week.timeZone, locale)
	const created = row.summary.created ?? 0
	const changed = row.summary.changed ?? 0
	const cancelled = row.summary.cancelled ?? 0
	const told = row.notification?.queued ?? null

	return (
		<Item variant="outline" size="sm" role="listitem">
			<div className="w-full">
				<Collapsible open={expanded} onOpenChange={setExpanded}>
					<CollapsibleTrigger className="flex w-full items-start justify-between gap-3 text-start">
						<span className="flex min-w-0 flex-col gap-0.5">
							<span className="text-sm font-medium">
								<bdi>{when}</bdi>
							</span>
							<span className="text-muted-foreground text-xs">
								<ChangeSummary
									created={created}
									changed={changed}
									cancelled={cancelled}
								/>
								{' · '}
								{row.notifyMode === 'nobody' ? (
									<Trans>Nobody told</Trans>
								) : told === null ? (
									<Trans>Told</Trans>
								) : (
									<Plural
										value={told}
										one="# person told"
										other="# people told"
									/>
								)}
							</span>
						</span>
						<Icon
							name={expanded ? 'chevron-up' : 'chevron-down'}
							className="text-muted-foreground mt-0.5 size-4 shrink-0"
							aria-hidden="true"
						/>
						<span className="sr-only">
							{expanded ? _(t`Hide details`) : _(t`Show details`)}
						</span>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div
							id={panelId}
							className="border-border mt-3 flex flex-col gap-5 border-t pt-4"
						>
							<PublicationDetail
								row={row}
								current={first}
								client={client}
								week={week}
								locale={locale}
								canWrite={canWrite}
							/>
						</div>
					</CollapsibleContent>
				</Collapsible>
			</div>
		</Item>
	)
}

function ChangeSummary({
	created,
	changed,
	cancelled,
}: {
	created: number
	changed: number
	cancelled: number
}) {
	const parts: React.ReactNode[] = []
	if (created > 0) {
		parts.push(<Plural key="c" value={created} one="# new" other="# new" />)
	}
	if (changed > 0) {
		parts.push(
			<Plural key="e" value={changed} one="# changed" other="# changed" />,
		)
	}
	if (cancelled > 0) {
		parts.push(
			<Plural key="r" value={cancelled} one="# removed" other="# removed" />,
		)
	}
	if (parts.length === 0) return <Trans>No shift changes</Trans>
	return (
		<>
			{parts.map((part, index) => (
				<span key={index}>
					{index > 0 ? ', ' : null}
					{part}
				</span>
			))}
		</>
	)
}

function PublicationDetail({
	row,
	current,
	client,
	week,
	locale,
	canWrite,
}: {
	row: SchedulePublicationRow
	current: boolean
	client: StaffClient
	week: { people: SchedulePersonRow[] }
	locale: string
	canWrite: boolean
}) {
	const { _ } = useLingui()
	const reasonLabel = useReasonLabel()
	const nameOf = usePersonName(week.people, locale)
	const action = useStaffAction(describeScheduleError)
	const notices = useStaffQuery(
		client,
		`/publications/${encodeURIComponent(row.id)}/notices`,
		noticesSchema,
	)

	const affected = new Map<
		string,
		{ created: number; changed: number; cancelled: number }
	>()
	for (const change of row.changes) {
		for (const staffId of [change.staffId, change.previousStaffId]) {
			if (!staffId) continue
			const entry = affected.get(staffId) ?? {
				created: 0,
				changed: 0,
				cancelled: 0,
			}
			if (change.kind === 'created') entry.created += 1
			else if (change.kind === 'cancelled') entry.cancelled += 1
			else entry.changed += 1
			affected.set(staffId, entry)
		}
	}

	async function resend(scope: 'unsent' | 'all') {
		const result = await action.run(() => resendNotices(client, row.id, scope))
		if (!result.ok) return
		const queued = result.value.queued
		toast.success(
			queued > 0
				? _(
						plural(queued, {
							one: 'Sending again to # person.',
							other: 'Sending again to # people.',
						}),
					)
				: _(t`Nobody needed it again.`),
		)
		notices.reload()
	}

	const data = notices.data
	const canResend = canWrite && current && data?.current === true
	const stateLabel = (state: string, reason: string | null) =>
		state === 'sent'
			? _(t`Sent`)
			: state === 'pending'
				? _(t`Waiting to send`)
				: state === 'failed'
					? _(t`Could not be sent`)
					: reasonLabel(reason)

	return (
		<>
			{affected.size > 0 ? (
				<div className="flex flex-col gap-2">
					<h3 className="text-sm font-medium">
						<Trans>Who changed</Trans>
					</h3>
					<ul className="divide-border divide-y text-sm">
						{[...affected.entries()].map(([staffId, counts]) => (
							<li
								key={staffId}
								className="flex flex-wrap items-baseline justify-between gap-x-3 py-2 first:pt-0 last:pb-0"
							>
								<span>{nameOf(staffId)}</span>
								<span className="text-muted-foreground text-xs">
									<ChangeSummary {...counts} />
								</span>
							</li>
						))}
					</ul>
				</div>
			) : null}

			{notices.error && !data ? (
				<Alert>
					<AlertDescription>
						{describeStaffError(notices.error, _)}
					</AlertDescription>
				</Alert>
			) : !data ? (
				<Skeleton aria-hidden="true" className="h-10 w-full" />
			) : (
				<>
					{data.notices.length > 0 ? (
						<div className="flex flex-col gap-2">
							<h3 className="text-sm font-medium">
								<Trans>Emails</Trans>
							</h3>
							<ul className="divide-border divide-y text-sm">
								{data.notices.map((notice) => (
									<li
										key={notice.staffId}
										className="flex flex-wrap items-baseline justify-between gap-x-3 py-2 first:pt-0 last:pb-0"
									>
										<span>{nameOf(notice.staffId)}</span>
										<span className="text-muted-foreground text-xs">
											{stateLabel(notice.state, notice.reason)}
											{notice.round > 0 ? (
												<>
													{' · '}
													<Trans>sent again</Trans>
												</>
											) : null}
										</span>
									</li>
								))}
							</ul>
						</div>
					) : null}
					<NotReachedList
						entries={data.notReached}
						people={week.people}
						locale={locale}
					/>
					{data.notices.length === 0 && data.notReached.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							{row.notifyMode === 'nobody' ? (
								<Trans>This was published quietly. Nobody was emailed.</Trans>
							) : (
								<Trans>Nobody needed an email.</Trans>
							)}
						</p>
					) : null}
					{!data.emailEnabled ? (
						<p className="text-sm">
							<Trans>
								Staff email is switched off, so nothing can be sent.
							</Trans>
						</p>
					) : null}
					{!data.current ? (
						<p className="text-muted-foreground text-sm">
							<Trans>
								A newer version of this week was published after this one.
							</Trans>
						</p>
					) : null}
				</>
			)}

			{action.error ? (
				<Alert variant="destructive">
					<AlertDescription>{action.error}</AlertDescription>
				</Alert>
			) : null}
			{canResend && data?.emailEnabled ? (
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						size="sm"
						disabled={action.pending}
						onClick={() => void resend('unsent')}
					>
						<Trans>Resend to people not yet reached</Trans>
					</Button>
					<Button
						variant="ghost"
						size="sm"
						disabled={action.pending}
						onClick={() => void resend('all')}
					>
						<Trans>Resend to everyone</Trans>
					</Button>
				</div>
			) : null}
		</>
	)
}

function formatWhen(at: number, timeZone: string, locale: string): string {
	try {
		return new Intl.DateTimeFormat(locale, {
			dateStyle: 'medium',
			timeStyle: 'short',
			timeZone,
		}).format(at)
	} catch {
		return new Date(at).toISOString()
	}
}
