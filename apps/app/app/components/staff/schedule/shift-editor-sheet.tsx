import { Plural, Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
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
import { Button } from '@repo/ui/button'
import { FieldLegend, FieldSet } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemTitle,
} from '@repo/ui/item'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { type FormEvent, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
	SelectField,
	TextAreaField,
	TextField,
	type Option,
} from '#app/components/staff/controls.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import {
	assignShift,
	createShifts,
	deleteShift,
	revertShift,
	updateShift,
} from '#app/utils/staffing/schedule-api.ts'
import {
	describeConflict,
	describeScheduleError,
} from '#app/utils/staffing/schedule-errors.ts'
import {
	buildCreateBodies,
	buildUpdateBody,
	emptyForm,
	formFromShift,
	hasErrors,
	NO_POSITION,
	repeatCount,
	spanMinutes,
	validateShiftForm,
	type FormIssue,
	type ShiftForm,
} from '#app/utils/staffing/schedule-form.ts'
import {
	type ScheduleShiftRow,
	type ScheduleWeek,
} from '#app/utils/staffing/schedule-types.ts'
import {
	type BackfillStatus,
	formatDuration,
	formatHhmm,
	isBlockedStatus,
	OPEN_ROW,
	positionName,
	rankBackfill,
	timeSteps,
} from '#app/utils/staffing/schedule-view.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { staffDisplayName } from '#app/utils/staffing/staff-format.ts'
import { formatDateLabel } from '#app/utils/staffing/timesheet-view.ts'
import { type CellRef } from './board-types.ts'

export type EditorMode =
	| { kind: 'create'; cell: CellRef; preset?: ShiftForm }
	| { kind: 'edit'; shift: ScheduleShiftRow }

type Props = {
	mode: EditorMode | null
	week: ScheduleWeek
	scopeId: string
	client: StaffClient
	locale: string
	narrow: boolean
	/** Default times for a new shift: the last ones used. */
	lastTimes: { startTime: string; endTime: string } | null
	onClose: () => void
	/** A change went through (or the shift changed under us): reload the week. */
	onChanged: (shifts: ScheduleShiftRow[]) => void
	onReload: () => void
	onCopy: (shift: ScheduleShiftRow) => void
	onRepeat: (shift: ScheduleShiftRow) => void
}

function useFormIssueText() {
	const { _ } = useLingui()
	return (issue: FormIssue | undefined): string | null => {
		if (!issue) return null
		const copy: Record<FormIssue, string> = {
			same_time: _(t`The end cannot be the same as the start.`),
			break_too_long: _(t`The break has to be shorter than the shift.`),
			break_invalid: _(t`Enter the break in whole minutes, up to 720.`),
			note_too_long: _(t`Notes can be up to 500 characters.`),
			no_dates: _(t`Choose at least one day.`),
			second_same_time: _(t`The second shift cannot end when it starts.`),
			second_overlaps: _(t`The second shift overlaps the first.`),
		}
		return copy[issue]
	}
}

/**
 * Add or edit one shift in a sheet over the schedule. Times move in 15-minute
 * steps; a new shift can repeat on several days and can be split in two. An
 * open shift (or any shift) offers ranked suggestions for who could take it.
 * Nothing is saved until Save, and warnings never stop a save.
 */
export function ShiftEditorSheet(props: Props) {
	const { mode, narrow, onClose } = props
	return (
		<Sheet open={mode !== null} onOpenChange={(open) => !open && onClose()}>
			<SheetContent
				side={narrow ? 'bottom' : 'right'}
				className={narrow ? 'max-h-[92dvh]' : 'sm:max-w-md'}
			>
				{mode ? (
					<EditorBody
						// A new shift or another shift is a fresh form.
						key={
							mode.kind === 'edit'
								? mode.shift.id
								: `new:${mode.cell.rowKey}:${mode.cell.date}`
						}
						{...props}
						mode={mode}
					/>
				) : null}
			</SheetContent>
		</Sheet>
	)
}

function EditorBody({
	mode,
	week,
	scopeId,
	client,
	locale,
	lastTimes,
	onClose,
	onChanged,
	onReload,
	onCopy,
	onRepeat,
}: Props & { mode: EditorMode }) {
	const { _ } = useLingui()
	const action = useStaffAction(describeScheduleError)
	const issueText = useFormIssueText()
	const editing = mode.kind === 'edit' ? mode.shift : null
	const [form, setForm] = useState<ShiftForm>(() =>
		editing
			? formFromShift(editing)
			: (mode.kind === 'create' && mode.preset) ||
				emptyForm({
					rowKey: mode.kind === 'create' ? mode.cell.rowKey : OPEN_ROW,
					date: mode.kind === 'create' ? mode.cell.date : week.dates[0]!,
					...lastTimes,
				}),
	)
	const [errors, setErrors] = useState(() =>
		validateShiftForm(form, { creating: !editing }),
	)
	const [showErrors, setShowErrors] = useState(false)
	const [confirmDelete, setConfirmDelete] = useState(false)
	const set = (patch: Partial<ShiftForm>) => {
		const next = { ...form, ...patch }
		setForm(next)
		setErrors(validateShiftForm(next, { creating: !editing }))
	}

	const times = useMemo(() => timeSteps(), [])
	const timeOptions: Option[] = useMemo(
		() => times.map((value) => ({ value, label: formatHhmm(value, locale) })),
		[times, locale],
	)
	const selectedPosition =
		form.positionId === NO_POSITION ? null : form.positionId
	const people = useMemo(() => {
		const shown = week.people.filter(
			(person) =>
				(person.showInSchedule && person.status !== 'terminated') ||
				person.id === editing?.staffId,
		)
		return shown
			.map((person) => ({
				person,
				name: staffDisplayName(person, locale),
				holds: selectedPosition
					? person.positionIds.includes(selectedPosition)
					: true,
			}))
			.sort(
				(a, b) =>
					Number(b.holds) - Number(a.holds) ||
					a.name.localeCompare(b.name, locale),
			)
	}, [week.people, locale, selectedPosition, editing?.staffId])
	const personOptions: Option[] = [
		{ value: OPEN_ROW, label: _(t`Open shift (nobody yet)`) },
		...people.map(({ name }, index) => ({
			value: people[index]!.person.id,
			label: name,
		})),
	]
	const positionOptions: Option[] = [
		{ value: NO_POSITION, label: _(t`No position`) },
		...week.positions.map((position) => ({
			value: position.id,
			label: positionName(position, locale),
		})),
	]
	const chosen = people.find((entry) => entry.person.id === form.staffId)
	const notSetUp = Boolean(chosen && selectedPosition && !chosen.holds)

	const length =
		form.startTime === form.endTime
			? 0
			: spanMinutes(form.startTime, form.endTime)
	const overnight = length > 0 && form.endTime <= form.startTime

	const suggestions = useMemo(
		() =>
			editing
				? rankBackfill({ shift: editing, week, includeBlocked: true }).slice(
						0,
						8,
					)
				: [],
		[editing, week],
	)

	function finish(shifts: ScheduleShiftRow[], saved: string) {
		const flagged = shifts.reduce(
			(sum, shift) => sum + shift.conflicts.length,
			0,
		)
		if (flagged > 0) {
			const first = shifts.flatMap((shift) => shift.conflicts)[0]
			toast.warning(
				`${saved} ${plural(flagged, { one: '# warning:', other: '# warnings:' })} ${first ? describeConflict(first.code, _) : ''}`.trim(),
			)
		} else toast.success(saved)
		onChanged(shifts)
		onClose()
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		setShowErrors(true)
		const found = validateShiftForm(form, { creating: !editing })
		setErrors(found)
		if (hasErrors(found)) return
		const result = await action.run(async () => {
			if (editing) {
				const body = buildUpdateBody(form, editing)
				const written = body
					? (await updateShift(client, editing.id, body)).shifts
					: []
				if (form.split) {
					const [, second] = buildCreateBodies(
						{ ...form, dates: [editing.localDate] },
						scopeId,
					)
					if (second)
						written.push(...(await createShifts(client, second)).shifts)
				}
				return written
			}
			const written: ScheduleShiftRow[] = []
			try {
				for (const body of buildCreateBodies(form, scopeId)) {
					written.push(...(await createShifts(client, body)).shifts)
				}
			} catch (error) {
				if (written.length > 0) {
					// The first half of a split shift is already on the schedule: a
					// retry must add only the second half, never the first again.
					setForm({
						...form,
						startTime: form.startTime2,
						endTime: form.endTime2,
						unpaidBreak: '0',
						split: false,
					})
					setErrors({})
					onReload()
				}
				throw error
			}
			return written
		})
		if (!result.ok) {
			// Whatever went wrong, the week may have moved on: look again.
			if (editing) onReload()
			return
		}
		if (result.value.length === 0) {
			onClose()
			return
		}
		finish(
			result.value,
			editing
				? _(t`Shift saved.`)
				: plural(result.value.length, {
						one: '# shift added.',
						other: '# shifts added.',
					}),
		)
	}

	async function runAssign(staffId: string | null) {
		if (!editing) return
		const result = await action.run(() =>
			assignShift(client, editing.id, staffId, editing.version),
		)
		if (result.ok) {
			finish(
				result.value.shifts,
				staffId ? _(t`Shift assigned.`) : _(t`Shift is now open.`),
			)
		}
	}

	async function runDelete() {
		if (!editing) return
		const result = await action.run(() =>
			deleteShift(client, editing.id, editing.version),
		)
		setConfirmDelete(false)
		if (!result.ok) return
		toast.success(
			result.value.state === 'deleted'
				? _(t`Shift removed.`)
				: _(t`Shift will be removed when you publish.`),
		)
		onChanged([])
		onClose()
	}

	async function runRevert() {
		if (!editing) return
		const result = await action.run(() => revertShift(client, editing.id))
		if (result.ok) finish(result.value.shifts, _(t`Changes undone.`))
	}

	const dayLabel = formatDateLabel(
		editing?.localDate ?? form.dates[0] ?? week.dates[0]!,
		locale,
		{
			weekday: 'long',
			month: 'long',
			day: 'numeric',
		},
	)
	const canRevert =
		editing &&
		(editing.state === 'changed' || editing.state === 'cancel_pending')
	const removing = editing?.state === 'cancel_pending'

	return (
		<>
			<SheetForm
				title={editing ? _(t`Edit shift`) : _(t`Add a shift`)}
				description={dayLabel}
				onSubmit={submit}
				footer={
					<>
						<Button type="button" variant="ghost" onClick={onClose}>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={action.pending || removing}>
							{action.pending ? (
								<Trans>Saving…</Trans>
							) : editing ? (
								<Trans>Save</Trans>
							) : (
								<Trans>Add</Trans>
							)}
						</Button>
					</>
				}
			>
				{action.error ? (
					<Alert variant="destructive">
						<AlertDescription>{action.error}</AlertDescription>
					</Alert>
				) : null}

				{editing && editing.conflicts.length > 0 ? (
					<Alert variant="destructive" role="status">
						<Icon name="alert-triangle" aria-hidden="true" />
						<AlertTitle>
							<Plural
								value={editing.conflicts.length}
								one="# warning"
								other="# warnings"
							/>
						</AlertTitle>
						<AlertDescription>
							<ul className="text-foreground flex list-disc flex-col gap-0.5 ps-4">
								{editing.conflicts.map((conflict, index) => (
									<li key={`${conflict.code}-${index}`}>
										{describeConflict(conflict.code, _)}
									</li>
								))}
							</ul>
							<p className="pt-1 text-xs">
								<Trans>
									Warnings do not stop you from saving or publishing.
								</Trans>
							</p>
						</AlertDescription>
					</Alert>
				) : null}

				{removing ? (
					<p className="text-sm">
						<Trans>
							This shift is set to be removed when you publish. Undo that to
							edit it.
						</Trans>
					</p>
				) : null}

				<SelectField
					label={<Trans>Who works</Trans>}
					value={form.staffId}
					options={personOptions}
					onValueChange={(staffId) => set({ staffId })}
					hint={
						notSetUp ? (
							<Trans>
								This person is not set up for that position here. You can still
								schedule them.
							</Trans>
						) : undefined
					}
				/>
				<SelectField
					label={<Trans>Position</Trans>}
					value={form.positionId}
					options={positionOptions}
					onValueChange={(positionId) => set({ positionId })}
				/>

				<div className="grid grid-cols-2 gap-3">
					<SelectField
						label={<Trans>Starts</Trans>}
						value={form.startTime}
						options={timeOptions}
						onValueChange={(startTime) => set({ startTime })}
					/>
					<SelectField
						label={<Trans>Ends</Trans>}
						value={form.endTime}
						options={timeOptions}
						onValueChange={(endTime) => set({ endTime })}
						error={showErrors ? issueText(errors.endTime) : null}
					/>
				</div>
				<p
					className="text-muted-foreground -mt-3 text-sm tabular-nums"
					aria-live="polite"
				>
					{length > 0 ? (
						<>
							{formatDuration(length)}
							{overnight ? (
								<>
									{' '}
									· <Trans>ends the next day</Trans>
								</>
							) : null}
						</>
					) : null}
				</p>

				<TextField
					label={<Trans>Unpaid break (minutes)</Trans>}
					inputMode="numeric"
					value={form.unpaidBreak}
					onChange={(event) => set({ unpaidBreak: event.target.value })}
					error={showErrors ? issueText(errors.unpaidBreak) : null}
				/>

				{!editing ? (
					<FieldSet>
						<FieldLegend variant="label">
							<Trans>Repeat on</Trans>
						</FieldLegend>
						<ToggleGroup
							multiple
							variant="outline"
							spacing={1}
							className="flex-wrap"
							value={form.dates}
							aria-label={_(t`Days to add this shift on`)}
							onValueChange={(dates) => set({ dates: dates as string[] })}
						>
							{week.dates.map((date) => (
								<ToggleGroupItem
									key={date}
									value={date}
									className="h-11 min-w-12"
								>
									{formatDateLabel(date, locale, { weekday: 'short' })}
								</ToggleGroupItem>
							))}
						</ToggleGroup>
						{showErrors && errors.dates ? (
							<Alert variant="destructive">
								<AlertDescription>{issueText(errors.dates)}</AlertDescription>
							</Alert>
						) : null}
					</FieldSet>
				) : (
					<SelectField
						label={<Trans>Day</Trans>}
						value={form.dates[0] ?? editing.localDate}
						options={week.dates.map((date) => ({
							value: date,
							label: formatDateLabel(date, locale, {
								weekday: 'long',
								month: 'short',
								day: 'numeric',
							}),
						}))}
						onValueChange={(date) => set({ dates: [date] })}
					/>
				)}

				<div className="flex flex-col gap-3">
					<SwitchField
						label={<Trans>Split shift</Trans>}
						description={
							<Trans>
								Add a second shift later the same day, like lunch and dinner.
							</Trans>
						}
						checked={form.split}
						onCheckedChange={(split) => set({ split })}
					/>
					{form.split ? (
						<div className="grid grid-cols-2 gap-3">
							<SelectField
								label={<Trans>Second shift starts</Trans>}
								value={form.startTime2}
								options={timeOptions}
								onValueChange={(startTime2) => set({ startTime2 })}
							/>
							<SelectField
								label={<Trans>Second shift ends</Trans>}
								value={form.endTime2}
								options={timeOptions}
								onValueChange={(endTime2) => set({ endTime2 })}
								error={showErrors ? issueText(errors.time2) : null}
							/>
						</div>
					) : null}
					{!editing && repeatCount(form) > 1 ? (
						<p className="text-muted-foreground text-sm" aria-live="polite">
							<Plural
								value={repeatCount(form)}
								one="This adds # shift."
								other="This adds # shifts."
							/>
						</p>
					) : null}
				</div>

				<TextAreaField
					label={<Trans>Notes</Trans>}
					optional
					rows={3}
					value={form.notes}
					onChange={(event) => set({ notes: event.target.value })}
					error={showErrors ? issueText(errors.notes) : null}
				/>

				{editing && !removing ? (
					<section
						aria-labelledby="backfill-heading"
						className="flex flex-col gap-2"
					>
						<h3 id="backfill-heading" className="text-sm font-medium">
							{editing.staffId === null ? (
								<Trans>Who could take this shift</Trans>
							) : (
								<Trans>Who else could take this shift</Trans>
							)}
						</h3>
						{suggestions.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								<Trans>Nobody else holds this position here.</Trans>
							</p>
						) : (
							<ul className="flex flex-col gap-1">
								{suggestions.map((candidate) => (
									<Item
										key={candidate.person.id}
										size="sm"
										variant="outline"
										render={<li />}
									>
										<ItemContent>
											<ItemTitle>
												{staffDisplayName(candidate.person, locale)}
											</ItemTitle>
											<ItemDescription>
												<BackfillStatusText status={candidate.status} />
												{' · '}
												<span className="tabular-nums">
													{formatDuration(candidate.weekMinutes)} →{' '}
													{formatDuration(candidate.afterMinutes)}
												</span>
												{candidate.overtime ? (
													<>
														{' · '}
														<Trans>already at overtime</Trans>
													</>
												) : null}
											</ItemDescription>
										</ItemContent>
										<ItemActions>
											<Button
												size="sm"
												type="button"
												variant={
													isBlockedStatus(candidate.status)
														? 'ghost'
														: 'outline'
												}

												disabled={action.pending}
												onClick={() => void runAssign(candidate.person.id)}
											>
												<Trans>Assign</Trans>
											</Button>
										</ItemActions>
									</Item>
								))}
							</ul>
						)}
					</section>
				) : null}

				{editing ? (
					<div className="border-border flex flex-wrap gap-2 border-t pt-4">
						{canRevert ? (
							<Button
								type="button"
								variant="outline"
								disabled={action.pending}
								onClick={() => void runRevert()}
							>
								<Icon name="undo-2" />
								<Trans>Undo changes</Trans>
							</Button>
						) : null}
						{editing.staffId !== null && !removing ? (
							<Button
								type="button"
								variant="outline"
								disabled={action.pending}
								onClick={() => void runAssign(null)}
							>
								<Trans>Make open</Trans>
							</Button>
						) : null}
						<Button
							type="button"
							variant="outline"
							onClick={() => onCopy(editing)}
						>
							<Icon name="copy" />
							<Trans>Copy</Trans>
						</Button>
						<Button
							type="button"
							variant="outline"
							onClick={() => onRepeat(editing)}
						>
							<Trans>Repeat on other days</Trans>
						</Button>
						{!removing ? (
							<Button
								type="button"
								variant="destructive"
								disabled={action.pending}
								onClick={() => setConfirmDelete(true)}
							>
								<Icon name="trash-2" />
								<Trans>Remove</Trans>
							</Button>
						) : null}
					</div>
				) : null}
			</SheetForm>

			<AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Remove this shift?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							{editing && editing.state !== 'draft' ? (
								<Trans>
									This shift is already published. It stays on the schedule
									until you publish the week, and you can undo the removal
									before then.
								</Trans>
							) : (
								<Trans>This draft shift is deleted straight away.</Trans>
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Keep it</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => void runDelete()}
						>
							<Trans>Remove</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}

function BackfillStatusText({ status }: { status: BackfillStatus }) {
	switch (status) {
		case 'available':
			return <Trans>Available then</Trans>
		case 'unknown':
			return <Trans>No availability set</Trans>
		case 'outside':
			return <Trans>Outside their usual hours</Trans>
		case 'unavailable':
			return <Trans>Marked unavailable</Trans>
		case 'time_off':
			return <Trans>On time off</Trans>
		case 'overlap':
			return <Trans>Already working then</Trans>
	}
}
