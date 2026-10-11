import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
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
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useState } from 'react'
import {
	formatWallDate,
	formatWallTime,
	type Schedule,
	type Shift,
	staffName,
} from '#app/utils/staffing/client.ts'

export type ShiftDraft = {
	staffId: string | null
	positionId: string | null
	localDate: string
	startTime: string
	endTime: string
	unpaidBreakMinutes: number
	note: string
}

export type ShiftDialogTarget =
	| { kind: 'create'; localDate: string; staffId: string | null }
	| { kind: 'edit'; shift: Shift }

const selectClass =
	'border-input bg-background h-9 w-full rounded-md border px-2 text-sm'

function initialDraft(
	target: ShiftDialogTarget,
	staff: Schedule['staff'],
): ShiftDraft {
	if (target.kind === 'edit') {
		const { shift } = target
		return {
			staffId: shift.staffId,
			positionId: shift.positionId,
			localDate: shift.localDate,
			startTime: shift.startTime,
			endTime: shift.endTime,
			unpaidBreakMinutes: shift.unpaidBreakMinutes,
			note: shift.note,
		}
	}
	const person = staff.find((member) => member.id === target.staffId)
	return {
		staffId: target.staffId,
		positionId: person?.positionIds[0] ?? null,
		localDate: target.localDate,
		startTime: '09:00',
		endTime: '17:00',
		unpaidBreakMinutes: 0,
		note: '',
	}
}

export function ShiftDialog({
	target,
	onOpenChange,
	schedule,
	weekDates,
	canWrite,
	onSave,
	onDelete,
	onRestore,
}: {
	target: ShiftDialogTarget | null
	onOpenChange: (open: boolean) => void
	schedule: Schedule
	weekDates: string[]
	canWrite: boolean
	onSave: (draft: ShiftDraft, alsoOn: string[]) => Promise<string | null>
	onDelete: (shift: Shift) => Promise<string | null>
	onRestore: (shift: Shift) => Promise<string | null>
}) {
	const { _, i18n } = useLingui()
	const [draft, setDraft] = useState<ShiftDraft | null>(null)
	const [alsoOn, setAlsoOn] = useState<string[]>([])
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		if (target) {
			setDraft(initialDraft(target, schedule.staff))
			setAlsoOn([])
			setError(null)
		}
	}, [target, schedule.staff])

	if (!target || !draft) return null
	const editing = target.kind === 'edit' ? target.shift : null
	const removed = editing?.state === 'removed'
	const readOnly = !canWrite || removed
	const assignable = schedule.staff.filter(
		(member) =>
			(member.status === 'active' && member.assignedHere) ||
			member.id === draft.staffId,
	)
	const positions = schedule.positions.filter(
		(position) => !position.archived || position.id === draft.positionId,
	)
	const overnight = draft.endTime <= draft.startTime
	const publishedStart = editing?.published
		? formatWallTime(i18n.locale, editing.published.startTime)
		: ''
	const publishedEnd = editing?.published
		? formatWallTime(i18n.locale, editing.published.endTime)
		: ''
	const publishedDay = editing?.published
		? formatWallDate(i18n.locale, editing.published.localDate)
		: ''
	const run = async (work: () => Promise<string | null>) => {
		setBusy(true)
		const message = await work()
		setBusy(false)
		setError(message)
		if (!message) onOpenChange(false)
	}

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault()
						void run(() => onSave(draft, alsoOn))
					}}
				>
					<DialogHeader>
						<DialogTitle>
							{editing ? <Trans>Edit shift</Trans> : <Trans>Add shift</Trans>}
						</DialogTitle>
						<DialogDescription>
							{removed ? (
								<Trans>
									This shift is removed. Staff are told when you next publish.
								</Trans>
							) : (
								<Trans>
									Changes stay in draft until you publish the schedule.
								</Trans>
							)}
						</DialogDescription>
					</DialogHeader>
					{editing?.published && editing.state === 'changed' ? (
						<p className="bg-muted rounded-md p-2 text-xs">
							<Trans>
								Staff were told {publishedStart}–{publishedEnd} on{' '}
								{publishedDay}
							</Trans>
						</p>
					) : null}
					<fieldset disabled={readOnly || busy} className="space-y-4">
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-2">
								<Label htmlFor="shift-staff">
									<Trans>Person</Trans>
								</Label>
								<select
									id="shift-staff"
									className={selectClass}
									value={draft.staffId ?? ''}
									onChange={(event) => {
										const staffId = event.target.value || null
										const person = schedule.staff.find(
											(member) => member.id === staffId,
										)
										setDraft({
											...draft,
											staffId,
											positionId:
												draft.positionId ?? person?.positionIds[0] ?? null,
										})
									}}
								>
									<option value="">{_(msg`Open shift`)}</option>
									{assignable.map((member) => (
										<option key={member.id} value={member.id}>
											{staffName(member)}
										</option>
									))}
								</select>
							</div>
							<div className="space-y-2">
								<Label htmlFor="shift-position">
									<Trans>Position</Trans>
								</Label>
								<select
									id="shift-position"
									className={selectClass}
									value={draft.positionId ?? ''}
									onChange={(event) =>
										setDraft({
											...draft,
											positionId: event.target.value || null,
										})
									}
								>
									<option value="">{_(msg`No position`)}</option>
									{positions.map((position) => (
										<option key={position.id} value={position.id}>
											{position.name}
										</option>
									))}
								</select>
							</div>
						</div>
						<div className="grid gap-4 sm:grid-cols-3">
							<div className="space-y-2">
								<Label htmlFor="shift-date">
									<Trans>Day</Trans>
								</Label>
								<select
									id="shift-date"
									className={selectClass}
									value={draft.localDate}
									onChange={(event) => {
										setDraft({ ...draft, localDate: event.target.value })
										setAlsoOn((dates) =>
											dates.filter((date) => date !== event.target.value),
										)
									}}
								>
									{weekDates.map((date) => (
										<option key={date} value={date}>
											{formatWallDate(i18n.locale, date)}
										</option>
									))}
								</select>
							</div>
							<div className="space-y-2">
								<Label htmlFor="shift-start">
									<Trans>Start</Trans>
								</Label>
								<Input
									id="shift-start"
									type="time"
									required
									value={draft.startTime}
									onChange={(event) =>
										setDraft({ ...draft, startTime: event.target.value })
									}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="shift-end">
									<Trans>End</Trans>
								</Label>
								<Input
									id="shift-end"
									type="time"
									required
									value={draft.endTime}
									onChange={(event) =>
										setDraft({ ...draft, endTime: event.target.value })
									}
								/>
							</div>
						</div>
						{overnight && draft.endTime !== draft.startTime ? (
							<p className="text-muted-foreground text-xs">
								<Trans>Ends the next day.</Trans>
							</p>
						) : null}
						<div className="space-y-2">
							<Label htmlFor="shift-break">
								<Trans>Unpaid break (minutes)</Trans>
							</Label>
							<Input
								id="shift-break"
								type="number"
								min={0}
								max={480}
								step={5}
								className="w-32"
								value={draft.unpaidBreakMinutes}
								onChange={(event) =>
									setDraft({
										...draft,
										unpaidBreakMinutes: Math.max(
											0,
											Math.min(480, Number(event.target.value) || 0),
										),
									})
								}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="shift-note">
								<Trans>Note (staff see this)</Trans>
							</Label>
							<Textarea
								id="shift-note"
								rows={2}
								maxLength={500}
								value={draft.note}
								onChange={(event) =>
									setDraft({ ...draft, note: event.target.value })
								}
							/>
						</div>
						{!editing ? (
							<fieldset className="space-y-2">
								<legend className="text-sm font-medium">
									<Trans>Also add on</Trans>
								</legend>
								<div className="flex flex-wrap gap-3">
									{weekDates
										.filter((date) => date !== draft.localDate)
										.map((date) => {
											const id = `shift-also-${date}`
											return (
												<div key={date} className="flex items-center gap-2">
													<Checkbox
														id={id}
														checked={alsoOn.includes(date)}
														onCheckedChange={(checked) =>
															setAlsoOn((dates) =>
																checked
																	? [...dates, date]
																	: dates.filter((value) => value !== date),
															)
														}
													/>
													<Label htmlFor={id} className="font-normal">
														{formatWallDate(i18n.locale, date, {
															weekday: 'short',
														})}
													</Label>
												</div>
											)
										})}
								</div>
							</fieldset>
						) : null}
					</fieldset>
					{error ? (
						<p role="alert" className="text-destructive text-sm">
							{error}
						</p>
					) : null}
					<DialogFooter className="gap-2 sm:justify-between">
						<div>
							{editing && canWrite && !removed ? (
								<Button
									type="button"
									variant="destructive"
									disabled={busy}
									onClick={() => void run(() => onDelete(editing))}
								>
									<Trans>Delete</Trans>
								</Button>
							) : null}
							{editing && canWrite && removed ? (
								<Button
									type="button"
									variant="outline"
									disabled={busy}
									onClick={() => void run(() => onRestore(editing))}
								>
									<Trans>Restore</Trans>
								</Button>
							) : null}
						</div>
						<div className="flex gap-2">
							<Button
								type="button"
								variant="outline"
								onClick={() => onOpenChange(false)}
							>
								{readOnly ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
							</Button>
							{!readOnly ? (
								<Button type="submit" disabled={busy}>
									<Trans>Save</Trans>
								</Button>
							) : null}
						</div>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
