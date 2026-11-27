import { Trans, useLingui } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
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
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { WorkspacePage } from '@repo/ui/workspace'
import { useState } from 'react'
import { Link, useFetcher } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'

export type ScheduleListItem = {
	id: string
	title: string | null
	builtIn: string | null
	savedReportId: string | null
	cadence: string
	weekday: number | null
	hour: number
	timeZone: string
	locale: string
	pausedAt: string | null
	pausedReason: string | null
	lastSentAt: string | null
	lastError: string | null
	recipients: Array<{
		userId: string
		name: string | null
		email: string
		unsubscribed: boolean
		lastStatus: string | null
	}>
}

export type ScheduleReportOption = {
	id: string
	title: string
	/** Reads a customer name, phone or email: cannot be scheduled. */
	personal: boolean
}

export type ScheduleMemberOption = {
	id: string
	name: string | null
	email: string
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]
const HOURS = Array.from({ length: 24 }, (_, i) => i)

type FormState = {
	id: string | null
	report: string
	cadence: 'daily' | 'weekly' | 'monthly'
	weekday: string
	hour: string
	timeZone: string
	locale: 'en' | 'ar'
	recipients: string[]
}

const DAILY_SUMMARY = 'daily_summary'

/**
 * Reports, Scheduled reports (#121): the schedules of the organization, with a
 * dialog to make or edit one. Report emails are sent from the region the
 * organization's data lives in; a recipient must be a member and still hold
 * the grants for the report at send time.
 */
export function ReportSchedulesScreen({
	orgSlug,
	enabled,
	schedules,
	reports,
	members,
	defaultTimeZone,
	limits,
	initialReport,
}: {
	orgSlug: string
	enabled: boolean
	schedules: ScheduleListItem[]
	reports: ScheduleReportOption[]
	members: ScheduleMemberOption[]
	defaultTimeZone: string
	limits: { schedules: number; recipients: number }
	/** A report (or `daily_summary`) a link asked to schedule: opens the dialog. */
	initialReport: string | null
}) {
	const { t, i18n } = useLingui()
	const fetcher = useFetcher<{ ok: boolean; error?: string; detail?: string[] }>()
	const empty: FormState = {
		id: null,
		report: initialReport ?? DAILY_SUMMARY,
		cadence: 'daily',
		weekday: '1',
		hour: '8',
		timeZone: defaultTimeZone,
		locale: 'en',
		recipients: [],
	}
	const [form, setForm] = useState<FormState | null>(
		initialReport && enabled ? empty : null,
	)
	const busy = fetcher.state !== 'idle'
	const failed =
		fetcher.state === 'idle' && fetcher.data && fetcher.data.ok === false
			? fetcher.data
			: null

	const errorText = (code: string | undefined) => {
		switch (code) {
			case 'report_has_personal_fields':
				return t`This report shows a customer name, phone or email, so it cannot be emailed on a schedule. Remove those columns or filters first.`
			case 'too_many_schedules':
				return t`An organization can have ${limits.schedules} schedules. Delete one first.`
			case 'too_many_recipients':
				return t`A schedule can have ${limits.recipients} recipients.`
			case 'invalid_recipient':
				return t`Recipients must be members of this organization.`
			case 'no_recipients':
				return t`Pick at least one recipient.`
			case 'report_not_found':
				return t`That report is not available to you.`
			case 'daily_summary_is_daily':
				return t`The daily summary is sent every day.`
			case 'feature_off':
				return t`Scheduled reports are not switched on for this organization.`
			default:
				return t`Could not save the schedule. Try again.`
		}
	}

	const weekdayName = (day: number) =>
		new Intl.DateTimeFormat(i18n.locale, { weekday: 'long', timeZone: 'UTC' }).format(
			new Date(Date.UTC(2023, 0, 1 + day)),
		)
	const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`
	const when = (s: ScheduleListItem) =>
		s.cadence === 'daily'
			? t`Every day at ${hourLabel(s.hour)} (${s.timeZone})`
			: s.cadence === 'weekly'
				? t`Every ${weekdayName(s.weekday ?? 1)} at ${hourLabel(s.hour)} (${s.timeZone})`
				: t`On the 1st of each month at ${hourLabel(s.hour)} (${s.timeZone})`
	const date = (iso: string | null) =>
		iso
			? new Intl.DateTimeFormat(i18n.locale, {
					dateStyle: 'medium',
					timeStyle: 'short',
				}).format(new Date(iso))
			: '—'
	const submit = (body: Record<string, unknown>) =>
		void fetcher.submit(body as never, {
			method: 'post',
			encType: 'application/json',
		})

	const reportOptions = [
		{ value: DAILY_SUMMARY, label: t`Daily summary (yesterday against the same weekday last week)` },
		...reports.map((report) => ({
			value: report.id,
			label: report.personal
				? t`${report.title} (shows customer details, cannot be scheduled)`
				: report.title,
		})),
	]
	const selectedPersonal =
		form !== null && reports.find((r) => r.id === form.report)?.personal === true

	return (
		<WorkspacePage>
			<PageHeader
				title={<Trans>Scheduled reports</Trans>}
				description={
					<Trans>
						Email a saved report, or a daily summary, to members of your team
						at a set time. Reports are run and sent from the region your data
						lives in, and never include customer names, phones or emails.
					</Trans>
				}
				actions={
					<div className="flex flex-wrap gap-2">
						<Button variant="outline" render={<Link to={`/${orgSlug}/reports`} />}>
							<Trans>Back to reports</Trans>
						</Button>
						{enabled ? (
							<Button
								onClick={() => setForm(empty)}
								disabled={schedules.length >= limits.schedules}
								data-testid="schedule-new"
							>
								<Icon name="plus" />
								<Trans>New schedule</Trans>
							</Button>
						) : null}
					</div>
				}
			/>
			{!enabled ? (
				<Alert data-testid="schedules-off">
					<Icon name="alert-triangle" />
					<AlertDescription>
						<Trans>Scheduled reports are not switched on for this organization yet.</Trans>
					</AlertDescription>
				</Alert>
			) : schedules.length === 0 ? (
				<EmptyState
					title={<Trans>No scheduled reports yet</Trans>}
					description={
						<Trans>
							Start with the daily summary: yesterday&apos;s sales, orders,
							tips and more, every morning.
						</Trans>
					}
					icons={['calendar', 'clock', 'users']}
				/>
			) : (
				<Frame>
					<Table variant="card" data-testid="schedules-table">
						<TableHeader>
							<TableRow>
								<TableHead><Trans>Report</Trans></TableHead>
								<TableHead><Trans>When</Trans></TableHead>
								<TableHead><Trans>Recipients</Trans></TableHead>
								<TableHead><Trans>Last sent</Trans></TableHead>
								<TableHead><Trans>Status</Trans></TableHead>
								<TableHead className="text-end"><Trans>Actions</Trans></TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{schedules.map((s) => (
								<TableRow key={s.id} data-testid={`schedule-row-${s.id}`}>
									<TableCell className="font-medium">
										{s.builtIn ? t`Daily summary` : (s.title ?? t`Report`)}
									</TableCell>
									<TableCell className="text-sm">{when(s)}</TableCell>
									<TableCell className="text-sm">
										<div className="flex flex-col">
											{s.recipients.map((r) => (
												<span key={r.userId} className="wrap-anywhere">
													{r.name || r.email}
													{r.unsubscribed ? (
														<span className="text-muted-foreground"> · {t`unsubscribed`}</span>
													) : r.lastStatus === 'skipped_no_access' ? (
														<span className="text-warning"> · {t`skipped: no access`}</span>
													) : r.lastStatus === 'skipped_not_member' ? (
														<span className="text-warning"> · {t`skipped: no longer a member`}</span>
													) : null}
												</span>
											))}
										</div>
									</TableCell>
									<TableCell className="text-sm">
										{date(s.lastSentAt)}
										{s.lastError ? (
											<div className="text-destructive" data-testid={`schedule-error-${s.id}`}>
												{t`Last error: ${s.lastError}`}
											</div>
										) : null}
									</TableCell>
									<TableCell>
										{s.pausedAt ? (
											<Badge variant="warning">
												{s.pausedReason === 'failures'
													? t`Paused after failures`
													: t`Paused`}
											</Badge>
										) : (
											<Badge variant="success">
												<Trans>Active</Trans>
											</Badge>
										)}
									</TableCell>
									<TableCell className="text-end">
										<div className="flex justify-end gap-1.5">
											<Button
												size="sm"
												variant="outline"
												disabled={busy}
												onClick={() =>
													submit({ intent: s.pausedAt ? 'resume' : 'pause', id: s.id })
												}
												data-testid={`schedule-pause-${s.id}`}
											>
												{s.pausedAt ? t`Resume` : t`Pause`}
											</Button>
											<Button
												size="sm"
												variant="outline"
												disabled={busy}
												onClick={() =>
													setForm({
														id: s.id,
														report: s.builtIn ? DAILY_SUMMARY : (s.savedReportId ?? DAILY_SUMMARY),
														cadence: s.cadence as FormState['cadence'],
														weekday: String(s.weekday ?? 1),
														hour: String(s.hour),
														timeZone: s.timeZone,
														locale: s.locale === 'ar' ? 'ar' : 'en',
														recipients: s.recipients.map((r) => r.userId),
													})
												}
												data-testid={`schedule-edit-${s.id}`}
											>
												<Trans>Edit</Trans>
											</Button>
											<Button
												size="sm"
												variant="destructive"
												disabled={busy}
												onClick={() => submit({ intent: 'delete', id: s.id })}
												data-testid={`schedule-delete-${s.id}`}
											>
												<Trans>Delete</Trans>
											</Button>
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Frame>
			)}

			<Dialog open={form !== null} onOpenChange={(open) => !open && setForm(null)}>
				<DialogContent data-testid="schedule-dialog">
					{form ? (
						<>
							<DialogHeader>
								<DialogTitle>
									{form.id ? t`Edit schedule` : t`New scheduled report`}
								</DialogTitle>
								<DialogDescription>
									<Trans>
										The email holds a summary and a link to download the CSV.
										It is sent at the hour you pick, in the time zone you pick.
									</Trans>
								</DialogDescription>
							</DialogHeader>
							<div className="flex flex-col gap-4">
								<SelectField
									label={t`Report`}
									options={reportOptions}
									value={form.report}
									disabled={form.id !== null}
									onValueChange={(report) =>
										setForm({
											...form,
											report,
											cadence: report === DAILY_SUMMARY ? 'daily' : form.cadence,
										})
									}
									testId="schedule-report"
								/>
								{selectedPersonal ? (
									<p role="alert" className="text-destructive text-sm" data-testid="schedule-personal">
										{errorText('report_has_personal_fields')}
									</p>
								) : null}
								<div className="grid gap-3 sm:grid-cols-2">
									<SelectField
										label={t`How often`}
										options={[
											{ value: 'daily', label: t`Every day` },
											...(form.report === DAILY_SUMMARY
												? []
												: [
														{ value: 'weekly', label: t`Every week` },
														{ value: 'monthly', label: t`On the 1st of the month` },
													]),
										]}
										value={form.cadence}
										onValueChange={(cadence) =>
											setForm({ ...form, cadence: cadence as FormState['cadence'] })
										}
										testId="schedule-cadence"
									/>
									{form.cadence === 'weekly' ? (
										<SelectField
											label={t`Weekday`}
											options={WEEKDAYS.map((d) => ({
												value: String(d),
												label: weekdayName(d),
											}))}
											value={form.weekday}
											onValueChange={(weekday) => setForm({ ...form, weekday })}
											testId="schedule-weekday"
										/>
									) : null}
									<SelectField
										label={t`Send at`}
										options={HOURS.map((h) => ({
											value: String(h),
											label: hourLabel(h),
										}))}
										value={form.hour}
										onValueChange={(hour) => setForm({ ...form, hour })}
										testId="schedule-hour"
									/>
									<TextField
										label={t`Time zone`}
										hint={t`The organization's reporting time zone. A day is each location's own.`}
										value={form.timeZone}
										onChange={(event) =>
											setForm({ ...form, timeZone: event.target.value })
										}
										data-testid="schedule-timezone"
									/>
									<SelectField
										label={t`Language`}
										options={[
											{ value: 'en', label: 'English' },
											{ value: 'ar', label: 'العربية' },
										]}
										value={form.locale}
										onValueChange={(locale) =>
											setForm({ ...form, locale: locale as 'en' | 'ar' })
										}
										testId="schedule-locale"
									/>
								</div>
								<fieldset className="flex flex-col gap-2">
									<legend className="text-sm font-medium">
										<Trans>Recipients</Trans>
									</legend>
									<p className="text-muted-foreground text-xs">
										<Trans>
											Members only, up to {limits.recipients}. Each person
											receives only what their own access allows.
										</Trans>
									</p>
									<div className="max-h-48 overflow-auto rounded-md border p-2">
										{members.map((member) => {
											const checked = form.recipients.includes(member.id)
											return (
												<label key={member.id} className="flex items-center gap-2 py-1 text-sm">
													<Checkbox
														checked={checked}
														onCheckedChange={(next) =>
															setForm({
																...form,
																recipients: next
																	? [...form.recipients, member.id]
																	: form.recipients.filter((id) => id !== member.id),
															})
														}
														data-testid={`schedule-recipient-${member.id}`}
													/>
													<span className="wrap-anywhere">
														{member.name ? `${member.name} · ` : ''}
														{member.email}
													</span>
												</label>
											)
										})}
									</div>
								</fieldset>
								{failed ? (
									<p role="alert" className="text-destructive text-sm" data-testid="schedule-error">
										{errorText(failed.error)}
									</p>
								) : null}
							</div>
							<DialogFooter>
								<Button variant="outline" onClick={() => setForm(null)}>
									<Trans>Cancel</Trans>
								</Button>
								<Button
									disabled={busy || selectedPersonal || form.recipients.length === 0}
									onClick={() => {
										submit({
											intent: form.id ? 'update' : 'create',
											id: form.id,
											savedReportId: form.report === DAILY_SUMMARY ? null : form.report,
											cadence: form.cadence,
											weekday: form.cadence === 'weekly' ? Number(form.weekday) : null,
											hour: Number(form.hour),
											timeZone: form.timeZone.trim(),
											locale: form.locale,
											recipientUserIds: form.recipients,
										})
									}}
									data-testid="schedule-save"
								>
									<Trans>Save schedule</Trans>
								</Button>
							</DialogFooter>
						</>
					) : null}
				</DialogContent>
			</Dialog>
			{fetcher.state === 'idle' && fetcher.data?.ok && form !== null ? (
				<CloseOnSuccess onClose={() => setForm(null)} />
			) : null}
		</WorkspacePage>
	)
}

function CloseOnSuccess({ onClose }: { onClose: () => void }) {
	// Runs once when the action answered ok while the dialog is still open.
	useState(() => {
		queueMicrotask(onClose)
		return null
	})
	return null
}
