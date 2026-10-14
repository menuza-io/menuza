import { Plural, Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type ScheduleNotifyMode } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { FieldLegend, FieldSet } from '@repo/ui/field'
import { Item, ItemGroup } from '@repo/ui/item'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { useState } from 'react'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { publishWeek } from '#app/utils/staffing/schedule-api.ts'
import { describeScheduleError } from '#app/utils/staffing/schedule-errors.ts'
import {
	type PublishResultRow,
	type ScheduleWeek,
} from '#app/utils/staffing/schedule-types.ts'
import {
	estimateRecipients,
	formatDuration,
	summarizePublish,
} from '#app/utils/staffing/schedule-view.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { formatMoneyMinor } from '#app/utils/staffing/staff-format.ts'
import { formatPeriodLabel } from '#app/utils/staffing/timesheet-view.ts'
import { NotReachedList } from './notice-lists.tsx'

/**
 * Publish the week: everything unpublished (new drafts, edits, removals) goes
 * live together. The dialog first shows what the week will look like (shifts,
 * hours, estimated cost, warnings) and lets the manager pick who hears about
 * it; then, instead of closing, it says who was told and who could not be
 * reached. Warnings never block. A stale week (someone else published or
 * edited) reloads and asks to look again.
 */
export function PublishDialog({
	open,
	onClose,
	client,
	scopeId,
	week,
	locale,
	onDone,
	onStale,
	onHistory,
}: {
	open: boolean
	onClose: () => void
	client: StaffClient
	scopeId: string
	week: ScheduleWeek
	locale: string
	onDone: () => void
	onStale: () => void
	onHistory: () => void
}) {
	const { _ } = useLingui()
	const action = useStaffAction(describeScheduleError)
	const [mode, setMode] = useState<ScheduleNotifyMode>('changed')
	const [result, setResult] = useState<PublishResultRow | null>(null)
	const summary = summarizePublish(week)
	const range = formatPeriodLabel(week.weekStart, week.weekEnd, locale)
	const estimate = estimateRecipients(week, mode).people

	async function publish() {
		const outcome = await action.run(() =>
			publishWeek(client, {
				scopeId,
				weekStart: week.weekStart,
				notifyMode: mode,
				expectedVersion: week.version,
			}),
		)
		if (!outcome.ok) {
			// Re-read after any refusal: the week may have moved on.
			onStale()
			return
		}
		setResult(outcome.value)
		onDone()
	}

	function close() {
		setResult(null)
		action.reset()
		onClose()
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !next && close()}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
				{result ? (
					<PublishedView
						result={result}
						week={week}
						range={range}
						locale={locale}
						onClose={close}
						onHistory={() => {
							close()
							onHistory()
						}}
					/>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>
								<Trans>Publish this week</Trans>
							</DialogTitle>
							<DialogDescription>{range}</DialogDescription>
						</DialogHeader>
						{action.error ? (
							<Alert variant="destructive">
								<AlertDescription>{action.error}</AlertDescription>
							</Alert>
						) : null}

						<ItemGroup className="gap-1.5">
							<SummaryRow label={_(t`Shifts`)}>
								<Plural
									value={summary.liveShifts}
									one="# shift"
									other="# shifts"
								/>
								{summary.openShifts > 0 ? (
									<span className="text-muted-foreground">
										{' · '}
										<Plural
											value={summary.openShifts}
											one="# open"
											other="# open"
										/>
									</span>
								) : null}
							</SummaryRow>
							<SummaryRow label={_(t`Scheduled hours`)}>
								<bdi>{formatDuration(summary.minutes)}</bdi>
							</SummaryRow>
							{summary.costMinorByCurrency &&
							Object.keys(summary.costMinorByCurrency).length > 0 ? (
								<SummaryRow label={_(t`Estimated labor cost`)}>
									{Object.entries(summary.costMinorByCurrency)
										.map(([currency, minor]) =>
											formatMoneyMinor(minor, currency, locale),
										)
										.join(' · ')}
								</SummaryRow>
							) : null}
							<SummaryRow label={_(t`Warnings`)}>
								{summary.conflicted === 0 ? (
									<span className="text-muted-foreground">
										<Trans>None</Trans>
									</span>
								) : (
									<Plural
										value={summary.conflicted}
										one="# shift needs a look"
										other="# shifts need a look"
									/>
								)}
							</SummaryRow>
						</ItemGroup>

						<ul className="flex flex-col gap-1 text-sm tabular-nums">
							{summary.created > 0 ? (
								<li>
									<Plural
										value={summary.created}
										one="# new shift"
										other="# new shifts"
									/>
								</li>
							) : null}
							{summary.changed > 0 ? (
								<li>
									<Plural
										value={summary.changed}
										one="# changed shift"
										other="# changed shifts"
									/>
								</li>
							) : null}
							{summary.removed > 0 ? (
								<li>
									<Plural
										value={summary.removed}
										one="# shift removed"
										other="# shifts removed"
									/>
								</li>
							) : null}
						</ul>
						{summary.warned > 0 ? (
							<p className="text-sm">
								{plural(summary.warned, {
									one: '# of these shifts has a warning. You can still publish.',
									other:
										'# of these shifts have warnings. You can still publish.',
								})}
							</p>
						) : null}

						<FieldSet>
							<FieldLegend variant="label">
								<Trans>Tell your team</Trans>
							</FieldLegend>
							<RadioGroup
								value={mode}
								onValueChange={(next) => setMode(next as ScheduleNotifyMode)}
								aria-label={_(t`Who to notify`)}
							>
								<Label className="min-h-11 w-full items-start py-1">
									<RadioGroupItem value="changed" className="mt-0.5" />
									<span>
										<span className="font-medium">
											<Trans>People whose shifts changed</Trans>
										</span>
										<span className="text-muted-foreground block">
											<Trans>New, moved, edited and removed shifts.</Trans>
										</span>
									</span>
								</Label>
								<Label className="min-h-11 w-full items-start py-1">
									<RadioGroupItem value="everyone" className="mt-0.5" />
									<span className="font-medium">
										<Trans>Everyone on the schedule</Trans>
									</span>
								</Label>
								<Label className="min-h-11 w-full items-start py-1">
									<RadioGroupItem value="nobody" className="mt-0.5" />
									<span>
										<span className="font-medium">
											<Trans>Nobody</Trans>
										</span>
										<span className="text-muted-foreground block">
											<Trans>Publish quietly, for example to fix a typo.</Trans>
										</span>
									</span>
								</Label>
							</RadioGroup>
							<p className="text-muted-foreground text-sm" aria-live="polite">
								{mode === 'nobody' ? (
									<Trans>Nobody will be emailed.</Trans>
								) : (
									<Plural
										value={estimate}
										one="About # person will be emailed."
										other="About # people will be emailed."
									/>
								)}
							</p>
						</FieldSet>
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={close}>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								type="button"
								disabled={action.pending || summary.total === 0}
								onClick={() => void publish()}
							>
								{action.pending ? (
									<Trans>Publishing…</Trans>
								) : (
									<Trans>Publish</Trans>
								)}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	)
}

function SummaryRow({
	label,
	children,
}: {
	label: string
	children: React.ReactNode
}) {
	return (
		<Item
			variant="outline"
			size="xs"
			role="listitem"
			className="justify-between"
		>
			<span className="text-muted-foreground">{label}</span>
			<span className="text-end tabular-nums">{children}</span>
		</Item>
	)
}

function PublishedView({
	result,
	week,
	range,
	locale,
	onClose,
	onHistory,
}: {
	result: PublishResultRow
	week: ScheduleWeek
	range: string
	locale: string
	onClose: () => void
	onHistory: () => void
}) {
	const notification = result.publication.notification
	const mode = result.publication.notifyMode
	return (
		<>
			<DialogHeader>
				<DialogTitle>
					<Trans>Published</Trans>
				</DialogTitle>
				<DialogDescription>{range}</DialogDescription>
			</DialogHeader>
			<p className="text-sm" role="status">
				{mode === 'nobody' ? (
					<Trans>Published quietly. Nobody was emailed.</Trans>
				) : notification && notification.queued > 0 ? (
					<Plural
						value={notification.queued}
						one="Emailing # person now."
						other="Emailing # people now."
					/>
				) : (
					<Trans>Nobody needed an email.</Trans>
				)}
			</p>
			{notification && notification.notReached.length > 0 ? (
				<>
					<p className="text-sm">
						<Plural
							value={notification.notReached.length}
							one="# person could not be emailed. Add an email address to their profile, then resend from the publish history."
							other="# people could not be emailed. Add email addresses to their profiles, then resend from the publish history."
						/>
					</p>
					<NotReachedList
						entries={notification.notReached}
						people={week.people}
						locale={locale}
					/>
				</>
			) : null}
			<DialogFooter>
				<Button type="button" variant="ghost" onClick={onHistory}>
					<Trans>Publish history</Trans>
				</Button>
				<Button type="button" onClick={onClose}>
					<Trans>Done</Trans>
				</Button>
			</DialogFooter>
		</>
	)
}
