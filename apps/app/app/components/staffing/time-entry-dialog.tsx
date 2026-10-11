import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { localTimeOf } from '@repo/staffing'
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
import { useEffect, useState } from 'react'
import {
	staffName,
	type TimeEntry,
	type Timesheet,
} from '#app/utils/staffing/client.ts'

const selectClass =
	'border-input bg-background h-9 w-full rounded-md border px-2 text-sm'

export type TimeEntryDraft = {
	staffId: string
	positionId: string | null
	localDate: string
	clockIn: string
	clockOut: string | null
	unpaidBreakMinutes: number
	note: string
	reason: string
}

export type TimeEntryTarget =
	{ kind: 'create'; localDate: string } | { kind: 'edit'; entry: TimeEntry }

function initialDraft(
	target: TimeEntryTarget,
	sheet: Timesheet,
): TimeEntryDraft {
	if (target.kind === 'edit') {
		const { entry } = target
		return {
			staffId: entry.staffId,
			positionId: entry.positionId,
			localDate: entry.localDate,
			clockIn: localTimeOf(new Date(entry.clockInAt), entry.timeZone),
			clockOut: entry.clockOutAt
				? localTimeOf(new Date(entry.clockOutAt), entry.timeZone)
				: null,
			unpaidBreakMinutes: entry.unpaidBreakMinutes,
			note: entry.note,
			reason: '',
		}
	}
	const first = sheet.staff.find(
		(member) => member.status === 'active' && member.assignedHere,
	)
	return {
		staffId: first?.id ?? '',
		positionId: first?.positionIds[0] ?? null,
		localDate: target.localDate,
		clockIn: '09:00',
		clockOut: '17:00',
		unpaidBreakMinutes: 0,
		note: '',
		reason: '',
	}
}

export function TimeEntryDialog({
	target,
	onOpenChange,
	sheet,
	onSave,
	onDelete,
}: {
	target: TimeEntryTarget | null
	onOpenChange: (open: boolean) => void
	sheet: Timesheet
	onSave: (draft: TimeEntryDraft) => Promise<string | null>
	onDelete: (entry: TimeEntry, reason: string) => Promise<string | null>
}) {
	const { _ } = useLingui()
	const [draft, setDraft] = useState<TimeEntryDraft | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		if (target) {
			setDraft(initialDraft(target, sheet))
			setError(null)
		}
	}, [target, sheet])

	if (!target || !draft) return null
	const editing = target.kind === 'edit' ? target.entry : null
	const person = sheet.staff.find((member) => member.id === draft.staffId)
	const people = sheet.staff.filter(
		(member) => member.assignedHere || member.id === draft.staffId,
	)
	const positionIds = new Set(person?.positionIds ?? [])
	const positions = sheet.positions.filter(
		(position) =>
			(positionIds.has(position.id) && !position.archived) ||
			position.id === draft.positionId,
	)
	const overnight = draft.clockOut !== null && draft.clockOut <= draft.clockIn
	const update = (patch: Partial<TimeEntryDraft>) =>
		setDraft((current) => (current ? { ...current, ...patch } : current))
	const needsReason = Boolean(editing)

	const run = async (work: () => Promise<string | null>) => {
		setBusy(true)
		const message = await work()
		setBusy(false)
		if (message) setError(message)
		else onOpenChange(false)
	}

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault()
						void run(() => onSave(draft))
					}}
				>
					<DialogHeader>
						<DialogTitle>
							{editing ? (
								<Trans>Edit time card</Trans>
							) : (
								<Trans>Add time card</Trans>
							)}
						</DialogTitle>
						<DialogDescription>
							<Trans>
								Times are the location’s local time. Every change is kept in the
								card’s history.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="entry-staff">
								<Trans>Person</Trans>
							</Label>
							<select
								id="entry-staff"
								className={selectClass}
								value={draft.staffId}
								disabled={Boolean(editing)}
								required
								onChange={(event) => {
									const next = sheet.staff.find(
										(member) => member.id === event.target.value,
									)
									update({
										staffId: event.target.value,
										positionId: next?.positionIds[0] ?? null,
									})
								}}
							>
								{people.map((member) => (
									<option key={member.id} value={member.id}>
										{staffName(member)}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="entry-position">
								<Trans>Position</Trans>
							</Label>
							<select
								id="entry-position"
								className={selectClass}
								value={draft.positionId ?? ''}
								onChange={(event) =>
									update({ positionId: event.target.value || null })
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
						<div className="space-y-2">
							<Label htmlFor="entry-date">
								<Trans>Date</Trans>
							</Label>
							<Input
								id="entry-date"
								type="date"
								required
								value={draft.localDate}
								onChange={(event) => update({ localDate: event.target.value })}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="entry-break">
								<Trans>Unpaid break (minutes)</Trans>
							</Label>
							<Input
								id="entry-break"
								type="number"
								min={0}
								max={480}
								disabled={draft.clockOut === null}
								value={draft.unpaidBreakMinutes}
								onChange={(event) =>
									update({
										unpaidBreakMinutes: Math.max(
											0,
											Math.min(480, Number(event.target.value) || 0),
										),
									})
								}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="entry-in">
								<Trans>Clock in</Trans>
							</Label>
							<Input
								id="entry-in"
								type="time"
								required
								value={draft.clockIn}
								onChange={(event) => update({ clockIn: event.target.value })}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="entry-out">
								<Trans>Clock out</Trans>
							</Label>
							<Input
								id="entry-out"
								type="time"
								required={draft.clockOut !== null}
								disabled={draft.clockOut === null}
								value={draft.clockOut ?? ''}
								onChange={(event) => update({ clockOut: event.target.value })}
							/>
							{overnight ? (
								<p className="text-muted-foreground text-xs">
									<Trans>Ends the next day.</Trans>
								</p>
							) : null}
						</div>
					</div>
					<div className="flex items-center gap-2">
						<Checkbox
							id="entry-open"
							checked={draft.clockOut === null}
							onCheckedChange={(checked) =>
								update(
									checked === true
										? { clockOut: null, unpaidBreakMinutes: 0 }
										: { clockOut: '17:00' },
								)
							}
						/>
						<Label htmlFor="entry-open">
							<Trans>Still clocked in</Trans>
						</Label>
					</div>
					<div className="space-y-2">
						<Label htmlFor="entry-note">
							<Trans>Note</Trans>
						</Label>
						<Input
							id="entry-note"
							maxLength={500}
							value={draft.note}
							onChange={(event) => update({ note: event.target.value })}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="entry-reason">
							{needsReason ? (
								<Trans>Reason for the change</Trans>
							) : (
								<Trans>Reason (optional)</Trans>
							)}
						</Label>
						<Input
							id="entry-reason"
							maxLength={500}
							required={needsReason}
							placeholder={_(msg`For example: forgot to clock out`)}
							value={draft.reason}
							onChange={(event) => update({ reason: event.target.value })}
						/>
					</div>
					{error ? (
						<p role="alert" className="text-destructive text-sm">
							{error}
						</p>
					) : null}
					<DialogFooter className="gap-2">
						{editing ? (
							<Button
								type="button"
								variant="destructive"
								disabled={busy || !draft.reason.trim()}
								onClick={() =>
									void run(() => onDelete(editing, draft.reason.trim()))
								}
							>
								<Trans>Delete card</Trans>
							</Button>
						) : null}
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							disabled={
								busy || !draft.staffId || (needsReason && !draft.reason.trim())
							}
						>
							<Trans>Save</Trans>
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
