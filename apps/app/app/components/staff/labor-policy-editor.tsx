import { type I18n } from '@lingui/core'
import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	BUILTIN_LABOR_POLICY,
	type BreakRule,
	type LaborPolicyFields,
	type LaborPolicyProblem,
	STAFFING_PERMISSIONS as P,
} from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { FieldSet } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Separator } from '@repo/ui/separator'
import { Skeleton } from '@repo/ui/skeleton'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import {
	CoreRules,
	PresetPicker,
} from '#app/components/staff/labor-core-rules.tsx'
import { LaborExample } from '#app/components/staff/labor-example.tsx'
import {
	MinutesField,
	OptionalSetting,
	SettingGroup,
	ThresholdFields,
	UnitField,
	useRoundingOptions,
	useWeekdayOptions,
} from '#app/components/staff/labor-policy-fields.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import {
	buildPolicyPatch,
	DAILY_DOUBLE_TIME_PRESET,
	DAILY_OVERTIME_PRESET,
	hoursTextToMinutes,
	isDirty,
	minuteToTimeValue,
	minutesToHoursText,
	policyFormProblems,
	problemFor,
	timeValueToMinute,
} from '#app/utils/staffing/labor-policy-form.ts'
import { applyPreset, detectPreset } from '#app/utils/staffing/labor-presets.ts'
import { StaffApiError } from '#app/utils/staffing/staff-client.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import {
	defaultPolicyResponseSchema,
	laborPolicyViewSchema,
	type LaborPolicyViewRow,
} from '#app/utils/staffing/timeclock-types.ts'

type ScopeOption = { id: string; name: string; timeZone: string }

const DEFAULT_SCOPE = 'default'

/** Which advanced group each setting lives in, to open the group with a problem. */
const SECTION_PATHS = [
	{ id: 'timesheets', paths: ['timesheetApprovalMode'] },
	{
		id: 'schedule',
		paths: [
			'allowUnscheduled',
			'preventEarlyMinutes',
			'lateGraceMinutes',
			'missedClockOutReminderMinutes',
			'autoClockOutMinutes',
		],
	},
	{
		id: 'alerts',
		paths: [
			'noClockInAlertMinutes',
			'preShiftReminderMinutes',
			'overtimeAlertMinutes',
		],
	},
	{ id: 'breaks', paths: ['breakRules.rules'] },
	{
		id: 'overtime',
		paths: [
			'dailyOvertime',
			'dailyDoubleTime',
			'holiday',
			'weekStartsOn',
			'workdayStartMinute',
			'aggregateOvertimeAcrossScopes',
		],
	},
	{ id: 'rounding', paths: ['rounding'] },
]

/** The settings written as sentences above Advanced; their problems show there. */
const CORE_POLICY_PATHS = [
	'longShiftMinutes',
	'breakRules.autoDeduction',
	'weeklyOvertime',
	'timeTrackingEnabled',
]

/**
 * Labor rules per scope, with an organization default that new scopes
 * start from. Plain-language groups, starter values on request, and a
 * clear note that these are settings and estimates, not legal advice.
 */
export function LaborPolicyEditor({
	scopes,
	canEditDefault,
	dataRegion,
}: {
	scopes: readonly ScopeOption[]
	canEditDefault: boolean
	dataRegion: 'us' | 'ksa'
}) {
	const { _ } = useLingui()
	const { client, can, ready, unavailable } = useStaffClient('timeclock')
	const canWrite = can(P.UPDATE_LABOR_POLICY)

	const scopeOptions = useMemo(() => {
		const list: Array<{ value: string; label: string }> = []
		if (canEditDefault && scopes.length > 1) {
			list.push({ value: DEFAULT_SCOPE, label: _(t`All workplaces (default)`) })
		}
		for (const item of scopes) {
			list.push({ value: item.id, label: item.name })
		}
		return list
	}, [_, canEditDefault, scopes])

	const [scope, setScope] = useState(scopeOptions[0]?.value ?? DEFAULT_SCOPE)
	const [dirty, setDirty] = useState(false)
	const [pendingScope, setPendingScope] = useState<string | null>(null)

	// A browser prompt is the last line of defence against closing the tab.
	useEffect(() => {
		if (!dirty) return
		function onBeforeUnload(event: BeforeUnloadEvent) {
			event.preventDefault()
		}
		window.addEventListener('beforeunload', onBeforeUnload)
		return () => window.removeEventListener('beforeunload', onBeforeUnload)
	}, [dirty])

	const isDefault = scope === DEFAULT_SCOPE
	const viewQuery = useStaffQuery(
		client,
		ready && !isDefault ? `/policies/${encodeURIComponent(scope)}` : null,
		laborPolicyViewSchema,
	)
	const defaultQuery = useStaffQuery(
		client,
		ready && isDefault ? '/policies/default' : null,
		defaultPolicyResponseSchema,
	)
	const query = isDefault ? defaultQuery : viewQuery

	const view: LaborPolicyViewRow | null = useMemo(() => {
		if (isDefault) {
			const stored = defaultQuery.data
			if (!stored) return null
			return (
				stored.policy ?? {
					...BUILTIN_LABOR_POLICY,
					id: null,
					scopeId: null,
					source: 'builtin' as const,
					version: 1,
					updatedAt: null,
					aggregateDecisionRequired: false,
				}
			)
		}
		return viewQuery.data
	}, [isDefault, defaultQuery.data, viewQuery.data])

	if (unavailable) {
		return (
			<Alert variant="destructive">
				<AlertDescription>
					<Trans>We could not confirm your access. Reload the page.</Trans>
				</AlertDescription>
			</Alert>
		)
	}
	if (scopes.length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>No workplace is available to your account yet.</Trans>
			</p>
		)
	}

	function chooseScope(next: string) {
		if (next === scope) return
		if (dirty) setPendingScope(next)
		else setScope(next)
	}

	return (
		<div className="flex flex-col gap-8">
			{scopes.length > 1 ? (
				<div className="max-w-sm">
					<SelectField
						label={<Trans>Rules for</Trans>}
						value={scope}
						onValueChange={chooseScope}
						options={scopeOptions}
					/>
				</div>
			) : null}

			{!ready || query.loading || !view ? (
				query.error && !view ? (
					<div className="flex flex-col items-start gap-3">
						<Alert variant="destructive">
							<AlertDescription>
								{describeStaffError(query.error, _)}
							</AlertDescription>
						</Alert>
						<Button variant="outline" onClick={query.reload}>
							<Trans>Try again</Trans>
						</Button>
					</div>
				) : (
					<div role="status" className="flex flex-col gap-4">
						<span className="sr-only">
							<Trans>Loading labor rules</Trans>
						</span>
						<Skeleton className="h-10 w-72" />
						<Skeleton className="h-40 w-full" />
						<Skeleton className="h-40 w-full" />
					</div>
				)
			) : (
				<PolicyForm
					key={`${scope}:${view.source}:${view.version}`}
					scope={scope}
					view={view}
					canWrite={canWrite}
					dataRegion={dataRegion}
					multiScope={scopes.length > 1}
					onDirtyChange={setDirty}
					onSaved={() => query.reload()}
				/>
			)}

			<AlertDialog
				open={pendingScope !== null}
				onOpenChange={(open) => {
					if (!open) setPendingScope(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Discard unsaved changes?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								You changed some rules and have not saved them. Switching now
								throws those changes away.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Keep editing</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								if (pendingScope) setScope(pendingScope)
								setPendingScope(null)
								setDirty(false)
							}}
						>
							<Trans>Discard and switch</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

function describeProblem(
	problem: LaborPolicyProblem | undefined,
	_: I18n['_'],
): string | null {
	if (!problem) return null
	if (problem.code === 'out_of_range' && problem.path === 'longShiftMinutes') {
		return _(t`Enter between 1 and 48 hours.`)
	}
	switch (problem.code) {
		case 'double_time_before_overtime':
			return _(t`Double time must start after daily overtime.`)
		case 'deduction_longer_than_shift':
			return _(
				t`The deducted break must be shorter than the shift it applies after.`,
			)
		case 'reminder_after_auto_clock_out':
			return _(t`The reminder must come before the automatic clock-out.`)
		case 'duplicate_rule':
			return _(t`Two break rules start at the same point in the shift.`)
		case 'required_for_multi_scope_staff':
			return _(t`Choose how overtime is counted across workplaces.`)
		default:
			return _(t`This value is outside the allowed range.`)
	}
}

function PolicyForm({
	scope,
	view,
	canWrite,
	dataRegion,
	multiScope,
	onDirtyChange,
	onSaved,
}: {
	scope: string
	view: LaborPolicyViewRow
	canWrite: boolean
	dataRegion: 'us' | 'ksa'
	multiScope: boolean
	onDirtyChange: (dirty: boolean) => void
	onSaved: () => void
}) {
	const { _ } = useLingui()
	const { client } = useStaffClient('timeclock')
	const action = useStaffAction()
	const baseline = view as LaborPolicyFields
	const [policy, setPolicy] = useState<LaborPolicyFields>(baseline)
	const [stale, setStale] = useState(false)
	// The server's refusals, as `{ path, code }`, shown beside the fields.
	const serverProblems: LaborPolicyProblem[] = Object.entries(
		action.issues,
	).map(([path, code]) => ({ path, code }))

	const dirty = isDirty(baseline, policy)
	useEffect(() => {
		onDirtyChange(dirty)
		return () => onDirtyChange(false)
	}, [dirty, onDirtyChange])

	const clientProblems = useMemo(() => policyFormProblems(policy), [policy])
	const problems = [...clientProblems, ...serverProblems]
	const serverWantsAggregate = serverProblems.some(
		(problem) => problem.path === 'aggregateOvertimeAcrossScopes',
	)
	const askAggregate = multiScope || view.aggregateDecisionRequired
	// Only an unanswered question that someone works across scopes blocks a save.
	const blockingAggregate =
		policy.aggregateOvertimeAcrossScopes === null &&
		(view.aggregateDecisionRequired || serverWantsAggregate)

	function update(patch: Partial<LaborPolicyFields>) {
		action.reset()
		setStale(false)
		setPolicy((current) => ({ ...current, ...patch }))
	}
	const fieldError = (path: string) =>
		describeProblem(problemFor(problems, path), _)

	const hasProblems = problems.length > 0 || blockingAggregate

	// Advanced settings stay closed until something inside them needs attention,
	// so a refused save never points at a hidden field.
	const [advancedOpen, setAdvancedOpen] = useState(false)
	const advancedForcedOpen =
		blockingAggregate ||
		problems.some(
			(problem) =>
				!CORE_POLICY_PATHS.some(
					(path) =>
						problem.path === path || problem.path.startsWith(`${path}.`),
				),
		)

	// One group open at a time, plus any group holding a problem, so a refused
	// save never points at a hidden field.
	const [chosenSection, setChosenSection] = useState<string[]>([])
	const forcedSections = [
		...SECTION_PATHS.filter(({ paths }) =>
			problems.some((problem) =>
				paths.some(
					(path) =>
						problem.path === path || problem.path.startsWith(`${path}.`),
				),
			),
		).map(({ id }) => id),
		// The unanswered multi-scope overtime question blocks saving.
		...(blockingAggregate ? ['overtime'] : []),
	]
	const openSections = [...new Set([...chosenSection, ...forcedSections])]
	const weekdays = useWeekdayOptions()
	const roundingModes = useRoundingOptions()
	const onCount = [
		policy.noClockInAlertMinutes,
		policy.preShiftReminderMinutes,
		policy.overtimeAlertMinutes,
	].filter((minutes) => minutes !== null).length
	const breakCount = policy.breakRules.rules.length
	const lateMinutes = policy.lateGraceMinutes
	const weekStart =
		weekdays.find((day) => day.value === String(policy.weekStartsOn))?.label ??
		''
	const roundingLabel =
		roundingModes.find((mode) => mode.value === policy.rounding.mode)?.label ??
		''
	const roundingMinutes = policy.rounding.incrementMinutes
	const summaries = {
		timesheets:
			policy.timesheetApprovalMode === 'none'
				? _(t`No approval needed`)
				: policy.timesheetApprovalMode === 'approve'
					? _(t`A manager approves them`)
					: _(t`A manager approves and locks them`),
		schedule: policy.allowUnscheduled
			? _(t`Late after ${lateMinutes} min · Unscheduled clock-ins allowed`)
			: _(t`Late after ${lateMinutes} min · Scheduled people only`),
		alerts: _(t`${onCount} of 3 on`),
		breaks:
			breakCount === 0
				? _(t`No break rules`)
				: breakCount === 1
					? _(t`1 break rule`)
					: _(t`${breakCount} break rules`),
		overtime: policy.dailyOvertime
			? _(t`Daily overtime on · Week starts ${weekStart}`)
			: _(t`Daily overtime off · Week starts ${weekStart}`),
		rounding:
			policy.rounding.mode === 'none'
				? roundingLabel
				: _(t`${roundingLabel}, ${roundingMinutes} minutes`),
	}

	async function save() {
		if (hasProblems) return
		const patch = buildPolicyPatch(baseline, policy)
		const exists =
			view.source === 'scope' ||
			(scope === DEFAULT_SCOPE && view.source === 'default')
		const path =
			scope === DEFAULT_SCOPE
				? '/policies/default'
				: `/policies/${encodeURIComponent(scope)}`
		const result = await action.run(async () => {
			try {
				return laborPolicyViewSchema.parse(
					await client.request(path, {
						method: 'PUT',
						json: exists ? { ...patch, expectedVersion: view.version } : patch,
					}),
				)
			} catch (error) {
				if (error instanceof StaffApiError && error.code === 'stale_version') {
					setStale(true)
				}
				throw error
			}
		})
		if (result.ok) {
			setStale(false)
			toast.success(_(t`Labor rules saved.`))
			onSaved()
		}
	}

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault()
				void save()
			}}
			noValidate
			className="flex flex-col gap-8"
		>
			<InheritsNotice scope={scope} view={view} multiScope={multiScope} />

			<FieldSet disabled={!canWrite || action.pending} className="contents">
				<PresetPicker
					current={detectPreset(policy, dataRegion)}
					disabled={!canWrite || action.pending}
					onChoose={(id) => {
						action.reset()
						setPolicy((current) => applyPreset(id, current, dataRegion))
					}}
				/>
				<div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
					<div className="flex min-w-0 flex-col gap-6">
						<CoreRules
							policy={policy}
							update={update}
							fieldError={fieldError}
						/>
						<Collapsible
							open={advancedOpen || advancedForcedOpen}
							onOpenChange={setAdvancedOpen}
						>
							<CollapsibleTrigger
								render={
									<Button
										type="button"
										variant="outline"
										className="h-auto min-h-11 w-full justify-start gap-3 rounded-lg px-4 py-3 text-start"
									/>
								}
							>
								<Icon name="settings" size="sm" />
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="text-sm font-medium">
										<Trans>Advanced settings</Trans>
									</span>
									<span className="text-muted-foreground text-xs font-normal text-wrap">
										<Trans>
											Schedule checks, alerts, breaks, overtime details,
											rounding
										</Trans>
									</span>
								</span>
								<Icon
									name={
										advancedOpen || advancedForcedOpen
											? 'chevron-up'
											: 'chevron-down'
									}
									size="sm"
								/>
							</CollapsibleTrigger>
							<CollapsibleContent>
								<div className="flex flex-col gap-2 pt-4">
									<AdvancedSection
										id="timesheets"
										open={openSections.includes('timesheets')}
										onOpenChange={(open) =>
											setChosenSection(open ? ['timesheets'] : [])
										}
										summary={summaries.timesheets}
										title={<Trans>Timesheets</Trans>}
										description={<Trans>Who signs off on time cards.</Trans>}
									>
										<SettingGroup>
											<SelectField
												label={<Trans>Timesheets</Trans>}
												value={policy.timesheetApprovalMode}
												onValueChange={(value) =>
													update({
														timesheetApprovalMode:
															value as LaborPolicyFields['timesheetApprovalMode'],
													})
												}
												options={[
													{ value: 'none', label: _(t`No approval needed`) },
													{
														value: 'approve',
														label: _(t`A manager approves them`),
													},
													{
														value: 'approve_lock',
														label: _(t`A manager approves and locks them`),
													},
												]}
												hint={
													<Trans>
														Locked timesheets cannot be edited until someone
														unlocks them.
													</Trans>
												}
											/>
										</SettingGroup>
									</AdvancedSection>

									<AdvancedSection
										id="schedule"
										open={openSections.includes('schedule')}
										onOpenChange={(open) =>
											setChosenSection(open ? ['schedule'] : [])
										}
										summary={summaries.schedule}
										title={<Trans>Schedule enforcement</Trans>}
										description={
											<Trans>
												How strict the clock is about the published schedule.
												These checks start working once scheduling is turned on.
											</Trans>
										}
									>
										<SettingGroup>
											<SwitchField
												label={
													<Trans>
														Allow clock-in without a scheduled shift
													</Trans>
												}
												description={
													<Trans>
														When off, people with no shift cannot clock in and
														need a manager.
													</Trans>
												}
												checked={policy.allowUnscheduled}
												onCheckedChange={(allowUnscheduled) =>
													update({ allowUnscheduled })
												}
											/>
											<OptionalSetting
												label={<Trans>Block clock-in that is too early</Trans>}
												description={
													<Trans>
														Stops people from starting long before their shift.
													</Trans>
												}
												enabled={policy.preventEarlyMinutes !== null}
												onEnabledChange={(on) =>
													update({ preventEarlyMinutes: on ? 10 : null })
												}
											>
												<MinutesField
													label={
														<Trans>Earliest clock-in, before the shift</Trans>
													}
													value={policy.preventEarlyMinutes ?? 10}
													min={1}
													max={240}
													onValueChange={(preventEarlyMinutes) =>
														update({ preventEarlyMinutes })
													}
													error={fieldError('preventEarlyMinutes')}
												/>
											</OptionalSetting>
											<MinutesField
												label={<Trans>Count as late after</Trans>}
												hint={
													<Trans>
														Minutes past the start of a shift before a clock-in
														is marked late.
													</Trans>
												}
												value={policy.lateGraceMinutes}
												max={120}
												onValueChange={(lateGraceMinutes) =>
													update({ lateGraceMinutes })
												}
												error={fieldError('lateGraceMinutes')}
											/>
											<OptionalSetting
												label={<Trans>Remind about a missed clock-out</Trans>}
												description={
													<Trans>
														Checked every few minutes while people are clocked
														in, and at least once an hour, so a reminder can
														arrive a little late.
													</Trans>
												}
												enabled={policy.missedClockOutReminderMinutes !== null}
												onEnabledChange={(on) =>
													update({
														missedClockOutReminderMinutes: on ? 30 : null,
													})
												}
												error={fieldError('missedClockOutReminderMinutes')}
											>
												<MinutesField
													label={<Trans>Remind after the shift ends by</Trans>}
													value={policy.missedClockOutReminderMinutes ?? 30}
													min={5}
													max={60 * 24}
													onValueChange={(missedClockOutReminderMinutes) =>
														update({ missedClockOutReminderMinutes })
													}
												/>
											</OptionalSetting>
											<OptionalSetting
												label={<Trans>Clock people out automatically</Trans>}
												description={
													<Trans>
														Closes a forgotten shift and marks it for a manager
														to fix. Off by default.
													</Trans>
												}
												enabled={policy.autoClockOutMinutes !== null}
												onEnabledChange={(on) =>
													update({ autoClockOutMinutes: on ? 60 : null })
												}
											>
												<UnitField
													label={
														<Trans>Clock out after the shift ends by</Trans>
													}
													value={policy.autoClockOutMinutes ?? 60}
													onValueChange={(autoClockOutMinutes) =>
														update({ autoClockOutMinutes })
													}
													toText={minutesToHoursText}
													fromText={(text) => {
														const minutes = hoursTextToMinutes(text)
														return minutes !== null &&
															minutes >= 30 &&
															minutes <= 2880
															? minutes
															: null
													}}
													unit={<Trans>hours</Trans>}
												/>
											</OptionalSetting>
										</SettingGroup>
									</AdvancedSection>

									<AdvancedSection
										id="alerts"
										open={openSections.includes('alerts')}
										onOpenChange={(open) =>
											setChosenSection(open ? ['alerts'] : [])
										}
										summary={summaries.alerts}
										title={<Trans>Alerts and reminders</Trans>}
										description={
											<Trans>
												Who gets told when the clock and the schedule disagree.
												Checked every few minutes while people are clocked in,
												and at least once an hour.
											</Trans>
										}
									>
										<SettingGroup>
											<OptionalSetting
												label={
													<Trans>
														Tell managers when someone has not clocked in
													</Trans>
												}
												description={
													<Trans>
														Needs a published schedule. Managers choose how they
														hear about it in their notification settings.
													</Trans>
												}
												enabled={policy.noClockInAlertMinutes !== null}
												onEnabledChange={(on) =>
													update({ noClockInAlertMinutes: on ? 15 : null })
												}
												error={fieldError('noClockInAlertMinutes')}
											>
												<MinutesField
													label={<Trans>Alert after the shift starts by</Trans>}
													value={policy.noClockInAlertMinutes ?? 15}
													min={1}
													max={240}
													onValueChange={(noClockInAlertMinutes) =>
														update({ noClockInAlertMinutes })
													}
												/>
											</OptionalSetting>
											<OptionalSetting
												label={<Trans>Remind people before their shift</Trans>}
												description={
													<Trans>
														Sent by email to people who have an address on file.
													</Trans>
												}
												enabled={policy.preShiftReminderMinutes !== null}
												onEnabledChange={(on) =>
													update({ preShiftReminderMinutes: on ? 240 : null })
												}
												error={fieldError('preShiftReminderMinutes')}
											>
												<UnitField
													label={
														<Trans>Remind before the shift starts by</Trans>
													}
													value={policy.preShiftReminderMinutes ?? 240}
													onValueChange={(preShiftReminderMinutes) =>
														update({ preShiftReminderMinutes })
													}
													toText={minutesToHoursText}
													fromText={(text) => {
														const minutes = hoursTextToMinutes(text)
														return minutes !== null &&
															minutes >= 15 &&
															minutes <= 2880
															? minutes
															: null
													}}
													unit={<Trans>hours</Trans>}
												/>
											</OptionalSetting>
											<OptionalSetting
												label={<Trans>Warn managers about overtime</Trans>}
												description={
													<Trans>
														Only applies where overtime rules are set below.
														Exempt people are never counted.
													</Trans>
												}
												enabled={policy.overtimeAlertMinutes !== null}
												onEnabledChange={(on) =>
													update({ overtimeAlertMinutes: on ? 60 : null })
												}
												error={fieldError('overtimeAlertMinutes')}
											>
												<MinutesField
													label={
														<Trans>Warn when this close to the limit</Trans>
													}
													value={policy.overtimeAlertMinutes ?? 60}
													min={15}
													max={60 * 24}
													onValueChange={(overtimeAlertMinutes) =>
														update({ overtimeAlertMinutes })
													}
												/>
											</OptionalSetting>
										</SettingGroup>
									</AdvancedSection>

									<AdvancedSection
										id="breaks"
										open={openSections.includes('breaks')}
										onOpenChange={(open) =>
											setChosenSection(open ? ['breaks'] : [])
										}
										summary={summaries.breaks}
										title={<Trans>Breaks</Trans>}
										description={
											<Trans>
												Which breaks people take, and whether a missing one is
												flagged.
											</Trans>
										}
									>
										<BreakRulesEditor
											policy={policy}
											update={update}
											fieldError={fieldError}
										/>
									</AdvancedSection>

									<AdvancedSection
										id="overtime"
										open={openSections.includes('overtime')}
										onOpenChange={(open) =>
											setChosenSection(open ? ['overtime'] : [])
										}
										summary={summaries.overtime}
										title={<Trans>Overtime and pay week</Trans>}
										description={
											<Trans>
												Overtime rules used to estimate hours and cost. Leave
												them off if you do not use them.
											</Trans>
										}
									>
										<OvertimeEditor
											policy={policy}
											update={update}
											fieldError={fieldError}
											needsAggregate={askAggregate}
											aggregateBlocking={blockingAggregate}
										/>
									</AdvancedSection>

									<AdvancedSection
										id="rounding"
										open={openSections.includes('rounding')}
										onOpenChange={(open) =>
											setChosenSection(open ? ['rounding'] : [])
										}
										summary={summaries.rounding}
										title={<Trans>Rounding</Trans>}
										description={
											<Trans>
												Rounds clock-in and clock-out when hours are added up.
												The exact punch times are always kept.
											</Trans>
										}
									>
										<RoundingEditor policy={policy} update={update} />
									</AdvancedSection>
								</div>
							</CollapsibleContent>
						</Collapsible>
					</div>
					<div className="lg:sticky lg:top-6">
						<LaborExample policy={policy} />
					</div>
				</div>
			</FieldSet>

			<p className="text-muted-foreground max-w-prose text-sm text-pretty">
				<Trans>
					These are settings, not legal advice. Overtime, break and cost figures
					are estimates to help you plan, and are not payroll. Check the rules
					that apply to your business before relying on them.
				</Trans>
			</p>

			<SaveBar
				canWrite={canWrite}
				dirty={dirty}
				pending={action.pending}
				problemCount={problems.length + (blockingAggregate ? 1 : 0)}
				error={action.error}
				stale={stale}
				onDiscard={() => {
					action.reset()
					setStale(false)
					setPolicy(baseline)
				}}
				onReload={() => onSaved()}
			/>
		</form>
	)
}

// ---------------------------------------------------------------------------
// Banner, save bar
// ---------------------------------------------------------------------------

function InheritsNotice({
	scope,
	view,
	multiScope,
}: {
	scope: string
	view: LaborPolicyViewRow
	multiScope: boolean
}) {
	// A scope with no copy of its own follows the default (several scopes only).
	const inherits =
		multiScope && scope !== DEFAULT_SCOPE && view.source === 'default'
	if (!inherits) return null
	return (
		<Alert role="status">
			<AlertDescription>
				<Trans>
					This workplace follows the default rules. Saving gives it its own
					copy, so later changes to the default will not reach it.
				</Trans>
			</AlertDescription>
		</Alert>
	)
}

/** One collapsed group of advanced settings: its name and a one-line summary until opened. */
function AdvancedSection({
	id,
	open,
	onOpenChange,
	title,
	summary,
	description,
	children,
}: {
	id: string
	open: boolean
	onOpenChange: (open: boolean) => void
	title: ReactNode
	summary: ReactNode
	description?: ReactNode
	children: ReactNode
}) {
	return (
		<Card className="gap-0 py-0" data-section={id}>
			<Collapsible open={open} onOpenChange={onOpenChange}>
				<CollapsibleTrigger
					render={
						<Button
							type="button"
							variant="ghost"
							className="h-auto min-h-11 w-full justify-start gap-3 rounded-lg px-4 py-3.5 text-start"
						/>
					}
				>
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="text-sm font-medium">{title}</span>
						<span className="text-muted-foreground text-xs font-normal text-pretty">
							{summary}
						</span>
					</span>
					<Icon name={open ? 'chevron-up' : 'chevron-down'} size="sm" />
				</CollapsibleTrigger>
				<CollapsibleContent>
					<Separator />
					<div className="flex flex-col gap-4 px-4 pt-4 pb-5">
						{description ? (
							<p className="text-muted-foreground text-sm text-pretty">
								{description}
							</p>
						) : null}
						{children}
					</div>
				</CollapsibleContent>
			</Collapsible>
		</Card>
	)
}

function SaveBar({
	canWrite,
	dirty,
	pending,
	problemCount,
	error,
	stale,
	onDiscard,
	onReload,
}: {
	canWrite: boolean
	dirty: boolean
	pending: boolean
	problemCount: number
	error: string | null
	stale: boolean
	onDiscard: () => void
	onReload: () => void
}) {
	if (!canWrite) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>You can view these rules but not change them.</Trans>
			</p>
		)
	}
	return (
		<div className="bg-background/95 border-border sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 backdrop-blur-sm md:-mx-6 md:px-6">
			<div role="status" className="min-w-0 text-sm">
				{error ? (
					<span
						role="alert"
						className="text-destructive flex items-center gap-2"
					>
						<Icon name="alert-triangle" />
						{error}
					</span>
				) : problemCount > 0 ? (
					<span className="text-destructive">
						<Trans>Fix the highlighted settings to save.</Trans>
					</span>
				) : dirty ? (
					<span>
						<Trans>You have unsaved changes.</Trans>
					</span>
				) : (
					<span className="text-muted-foreground">
						<Trans>All changes saved.</Trans>
					</span>
				)}
			</div>
			<div className="flex items-center gap-2">
				{stale ? (
					<Button type="button" variant="outline" onClick={onReload}>
						<Trans>Reload</Trans>
					</Button>
				) : null}
				<Button
					type="button"
					variant="ghost"
					disabled={!dirty || pending}
					onClick={onDiscard}
				>
					<Trans>Discard</Trans>
				</Button>
				<Button type="submit" disabled={!dirty || pending || problemCount > 0}>
					{pending ? <Trans>Saving…</Trans> : <Trans>Save changes</Trans>}
				</Button>
			</div>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

type EditorProps = {
	policy: LaborPolicyFields
	update: (patch: Partial<LaborPolicyFields>) => void
	fieldError: (path: string) => string | null
}

function BreakRulesEditor({ policy, update, fieldError }: EditorProps) {
	const { rules, autoDeduction } = policy.breakRules
	function setRules(next: BreakRule[]) {
		update({ breakRules: { rules: next, autoDeduction } })
	}
	function patchRule(index: number, patch: Partial<BreakRule>) {
		setRules(
			rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
		)
	}
	return (
		<div className="flex flex-col gap-6">
			{rules.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>
						No break rules. People can still record breaks on the tablet.
					</Trans>
				</p>
			) : (
				<div className="flex flex-col gap-3">
					{rules.map((rule, index) => (
						<Card key={`${rule.kind}-${index}`} size="sm">
							<CardContent className="flex flex-col gap-3">
								<div className="flex items-start justify-between gap-3">
									<h3 className="text-sm font-medium">
										{rule.kind === 'meal' ? (
											<Trans>Meal break</Trans>
										) : (
											<Trans>Rest break</Trans>
										)}
									</h3>
									<Button
										type="button"
										variant="ghost"
										className="text-destructive -my-1"
										onClick={() =>
											setRules(rules.filter((_, i) => i !== index))
										}
									>
										<Icon name="trash-2" />
										<Trans>Remove</Trans>
									</Button>
								</div>
								<div className="flex flex-wrap items-start gap-x-6 gap-y-3">
									<UnitField
										label={<Trans>Due after</Trans>}
										value={rule.afterMinutes}
										onValueChange={(afterMinutes) =>
											patchRule(index, { afterMinutes })
										}
										toText={minutesToHoursText}
										fromText={(text) => {
											const minutes = hoursTextToMinutes(text)
											return minutes !== null && minutes >= 1 && minutes <= 1440
												? minutes
												: null
										}}
										unit={<Trans>hours into the shift</Trans>}
										error={fieldError(`breakRules.rules.${index}`)}
									/>
									<MinutesField
										label={<Trans>Length</Trans>}
										value={rule.minutes}
										min={1}
										max={240}
										onValueChange={(minutes) => patchRule(index, { minutes })}
									/>
								</div>
								<SwitchField
									label={<Trans>Paid break</Trans>}
									checked={rule.paid}
									onCheckedChange={(paid) => patchRule(index, { paid })}
								/>
								<SwitchField
									label={<Trans>Required</Trans>}
									description={
										<Trans>
											Flag a shift for review when this break was not taken.
										</Trans>
									}
									checked={rule.mandatory}
									onCheckedChange={(mandatory) =>
										patchRule(index, { mandatory })
									}
								/>
							</CardContent>
						</Card>
					))}
				</div>
			)}
			{rules.length < 6 ? (
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={() =>
							setRules([
								...rules,
								{
									kind: 'meal',
									afterMinutes: 6 * 60,
									minutes: 30,
									paid: false,
									mandatory: false,
								},
							])
						}
					>
						<Icon name="plus" />
						<Trans>Add meal break</Trans>
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() =>
							setRules([
								...rules,
								{
									kind: 'rest',
									afterMinutes: 4 * 60,
									minutes: 10,
									paid: true,
									mandatory: false,
								},
							])
						}
					>
						<Icon name="plus" />
						<Trans>Add rest break</Trans>
					</Button>
				</div>
			) : null}
		</div>
	)
}

function OvertimeEditor({
	policy,
	update,
	fieldError,
	needsAggregate,
	aggregateBlocking,
}: EditorProps & { needsAggregate: boolean; aggregateBlocking: boolean }) {
	const { _ } = useLingui()
	const weekdays = useWeekdayOptions()
	const [holidayInput, setHolidayInput] = useState('')
	const [holidayError, setHolidayError] = useState<string | null>(null)

	function addHoliday() {
		setHolidayError(null)
		if (!/^\d{4}-\d{2}-\d{2}$/.test(holidayInput)) {
			setHolidayError(_(t`Pick a date.`))
			return
		}
		if (policy.holiday.dates.includes(holidayInput)) {
			setHolidayError(_(t`That date is already listed.`))
			return
		}
		update({
			holiday: {
				...policy.holiday,
				dates: [...policy.holiday.dates, holidayInput].sort(),
			},
		})
		setHolidayInput('')
	}

	return (
		<div className="flex flex-col gap-6">
			<OptionalSetting
				label={<Trans>Daily overtime</Trans>}
				description={
					<Trans>Hours beyond a daily limit are paid at a higher rate.</Trans>
				}
				enabled={policy.dailyOvertime !== null}
				onEnabledChange={(on) =>
					update({ dailyOvertime: on ? { ...DAILY_OVERTIME_PRESET } : null })
				}
			>
				{policy.dailyOvertime ? (
					<ThresholdFields
						idPrefix="daily-ot"
						rule={policy.dailyOvertime}
						onChange={(dailyOvertime) => update({ dailyOvertime })}
						thresholdLabel={<Trans>After</Trans>}
						multiplierLabel={<Trans>Pay rate</Trans>}
						thresholdError={fieldError('dailyOvertime')}
					/>
				) : null}
			</OptionalSetting>

			<OptionalSetting
				label={<Trans>Daily double time</Trans>}
				description={
					<Trans>A second, higher rate after more hours in a day.</Trans>
				}
				enabled={policy.dailyDoubleTime !== null}
				onEnabledChange={(on) =>
					update({
						dailyDoubleTime: on ? { ...DAILY_DOUBLE_TIME_PRESET } : null,
					})
				}
				error={fieldError('dailyDoubleTime')}
			>
				{policy.dailyDoubleTime ? (
					<ThresholdFields
						idPrefix="double-time"
						rule={policy.dailyDoubleTime}
						onChange={(dailyDoubleTime) => update({ dailyDoubleTime })}
						thresholdLabel={<Trans>After</Trans>}
						multiplierLabel={<Trans>Pay rate</Trans>}
					/>
				) : null}
			</OptionalSetting>

			<SettingGroup title={<Trans>Holidays</Trans>}>
				<UnitField
					label={<Trans>Holiday pay rate</Trans>}
					hint={
						<Trans>
							1 means no premium. Holiday hours are not counted toward overtime.
						</Trans>
					}
					value={policy.holiday.multiplierBp}
					onValueChange={(multiplierBp) =>
						update({ holiday: { ...policy.holiday, multiplierBp } })
					}
					toText={(bp) => String(Math.round(bp / 100) / 100)}
					fromText={(text) => {
						const normalized = text.trim().replace(',', '.')
						if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return null
						const bp = Math.round(Number(normalized) * 10_000)
						return bp >= 10_000 && bp <= 40_000 ? bp : null
					}}
					unit={<span aria-hidden="true">×</span>}
				/>
				<div className="flex flex-col gap-2">
					<div className="flex items-end gap-2">
						<TextField
							label={<Trans>Add a holiday date</Trans>}
							type="date"
							value={holidayInput}
							onChange={(event) => setHolidayInput(event.target.value)}
							error={holidayError}
							className="max-w-48"
						/>
						<Button type="button" variant="outline" onClick={addHoliday}>
							<Icon name="plus" />
							<Trans>Add</Trans>
						</Button>
					</div>
					{policy.holiday.dates.length > 0 ? (
						<ul className="flex flex-wrap gap-2">
							{policy.holiday.dates.map((date) => (
								<li key={date}>
									<Badge variant="outline" className="h-8 gap-2 ps-3 pe-1">
										<span className="tabular-nums" dir="ltr">
											{date}
										</span>
										<Button
											type="button"
											variant="ghost"
											size="icon-xs"
											className="size-6"
											aria-label={_(t`Remove ${date}`)}
											onClick={() =>
												update({
													holiday: {
														...policy.holiday,
														dates: policy.holiday.dates.filter(
															(item) => item !== date,
														),
													},
												})
											}
										>
											<Icon name="x" size="xs" />
										</Button>
									</Badge>
								</li>
							))}
						</ul>
					) : null}
				</div>
			</SettingGroup>

			<SettingGroup title={<Trans>Pay week</Trans>}>
				<div className="flex flex-wrap items-start gap-x-6 gap-y-3">
					<SelectField
						className="min-w-48"
						label={<Trans>Week starts on</Trans>}
						value={String(policy.weekStartsOn)}
						onValueChange={(value) => update({ weekStartsOn: Number(value) })}
						options={weekdays}
					/>
					<TextField
						className="min-w-40"
						label={<Trans>Business day starts at</Trans>}
						type="time"
						dir="ltr"
						value={minuteToTimeValue(policy.workdayStartMinute)}
						onChange={(event) => {
							const minute = timeValueToMinute(event.target.value)
							if (minute !== null) update({ workdayStartMinute: minute })
						}}
						hint={
							<Trans>
								Shifts that run past midnight belong to the day they began.
							</Trans>
						}
					/>
				</div>
			</SettingGroup>

			{needsAggregate ? (
				<SelectField
					label={<Trans>People who work at more than one workplace</Trans>}
					value={
						policy.aggregateOvertimeAcrossScopes === null
							? 'unset'
							: policy.aggregateOvertimeAcrossScopes
								? 'all'
								: 'each'
					}
					onValueChange={(value) =>
						update({
							aggregateOvertimeAcrossScopes:
								value === 'unset' ? null : value === 'all',
						})
					}
					options={[
						{ value: 'unset', label: _(t`Choose…`) },
						{ value: 'each', label: _(t`Count overtime at each workplace`) },
						{
							value: 'all',
							label: _(t`Add hours across all workplaces`),
						},
					]}
					error={
						aggregateBlocking
							? _(t`Choose how overtime is counted before saving.`)
							: null
					}
					hint={
						<Trans>
							We do not pick this for you. Until you choose, overtime is
							estimated at each workplace separately.
						</Trans>
					}
				/>
			) : null}
		</div>
	)
}

function RoundingEditor({
	policy,
	update,
}: Pick<EditorProps, 'policy' | 'update'>) {
	const { _ } = useLingui()
	const modes = useRoundingOptions()
	const rounding = policy.rounding
	return (
		<div className="flex flex-wrap items-start gap-x-6 gap-y-3">
			<SelectField
				className="min-w-56"
				label={<Trans>Round hours</Trans>}
				value={rounding.mode}
				onValueChange={(mode) =>
					update({
						rounding: {
							mode: mode as LaborPolicyFields['rounding']['mode'],
							incrementMinutes:
								mode === 'none'
									? 1
									: rounding.incrementMinutes === 1
										? 15
										: rounding.incrementMinutes,
						},
					})
				}
				options={modes}
			/>
			{rounding.mode !== 'none' ? (
				<SelectField
					className="min-w-40"
					label={<Trans>Rounding step</Trans>}
					value={String(rounding.incrementMinutes)}
					onValueChange={(value) =>
						update({
							rounding: { ...rounding, incrementMinutes: Number(value) },
						})
					}
					options={[5, 6, 10, 15, 30].map((minutes) => ({
						value: String(minutes),
						label: _(t`${minutes} minutes`),
					}))}
				/>
			) : null}
		</div>
	)
}
