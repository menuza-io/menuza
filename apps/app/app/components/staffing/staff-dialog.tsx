import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
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
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useState } from 'react'
import {
	type Position,
	type Staff,
	type StaffingLocation,
} from '#app/utils/staffing/client.ts'

export type StaffFormValue = {
	firstName: string
	lastName: string
	email: string
	phone: string
	hiredOn: string
	note: string
	assignments: { locationId: string; positionId: string; isPrimary: boolean }[]
}

function initialValue(
	staff: Staff | null,
	locations: StaffingLocation[],
): StaffFormValue {
	if (staff) {
		return {
			firstName: staff.firstName,
			lastName: staff.lastName,
			email: staff.email ?? '',
			phone: staff.phone ?? '',
			hiredOn: staff.hiredOn ?? '',
			note: staff.note,
			assignments: staff.assignments,
		}
	}
	return {
		firstName: '',
		lastName: '',
		email: '',
		phone: '',
		hiredOn: '',
		note: '',
		assignments:
			locations.length === 1
				? [{ locationId: locations[0]!.id, positionId: '', isPrimary: true }]
				: [],
	}
}

const selectClass =
	'border-input bg-background h-9 w-full rounded-md border px-2 text-sm'

export function StaffDialog({
	open,
	onOpenChange,
	staff,
	positions,
	locations,
	canWrite,
	onSave,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	staff: Staff | null
	positions: Position[]
	locations: StaffingLocation[]
	canWrite: boolean
	onSave: (value: StaffFormValue) => Promise<string | null>
}) {
	const { _ } = useLingui()
	const [value, setValue] = useState(() => initialValue(staff, locations))
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		if (open) {
			setValue(initialValue(staff, locations))
			setError(null)
		}
	}, [open, staff, locations])

	const activePositions = positions.filter(
		(position) =>
			!position.archived ||
			value.assignments.some((item) => item.positionId === position.id),
	)
	const assignableLocations = locations.filter(
		(location) =>
			location.isActive ||
			value.assignments.some((item) => item.locationId === location.id),
	)
	const set = <K extends keyof StaffFormValue>(
		key: K,
		next: StaffFormValue[K],
	) => setValue((current) => ({ ...current, [key]: next }))
	const setAssignment = (
		index: number,
		patch: Partial<StaffFormValue['assignments'][number]>,
	) =>
		set(
			'assignments',
			value.assignments.map((item, itemIndex) => {
				if (itemIndex === index) return { ...item, ...patch }
				// One primary position per location.
				if (
					patch.isPrimary &&
					item.locationId === value.assignments[index]?.locationId
				) {
					return { ...item, isPrimary: false }
				}
				return item
			}),
		)

	const incomplete = value.assignments.some(
		(item) => !item.locationId || !item.positionId,
	)
	const submit = async (event: React.FormEvent) => {
		event.preventDefault()
		if (!canWrite || busy) return
		setBusy(true)
		const message = await onSave(value)
		setBusy(false)
		if (message) setError(message)
		else onOpenChange(false)
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
				<form onSubmit={submit} className="space-y-5">
					<DialogHeader>
						<DialogTitle>
							{staff ? (
								<Trans>Edit team member</Trans>
							) : (
								<Trans>Add team member</Trans>
							)}
						</DialogTitle>
						<DialogDescription>
							<Trans>
								Team members do not need a login and are not billed as seats.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					<fieldset disabled={!canWrite} className="space-y-5">
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-2">
								<Label htmlFor="staff-first-name">
									<Trans>First name</Trans>
								</Label>
								<Input
									id="staff-first-name"
									required
									maxLength={80}
									autoComplete="off"
									value={value.firstName}
									onChange={(event) => set('firstName', event.target.value)}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="staff-last-name">
									<Trans>Last name</Trans>
								</Label>
								<Input
									id="staff-last-name"
									maxLength={80}
									autoComplete="off"
									value={value.lastName}
									onChange={(event) => set('lastName', event.target.value)}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="staff-email">
									<Trans>Email</Trans>
								</Label>
								<Input
									id="staff-email"
									type="email"
									maxLength={254}
									autoComplete="off"
									value={value.email}
									onChange={(event) => set('email', event.target.value)}
								/>
								<p className="text-muted-foreground text-xs">
									<Trans>Used to send published schedules.</Trans>
								</p>
							</div>
							<div className="space-y-2">
								<Label htmlFor="staff-phone">
									<Trans>Phone</Trans>
								</Label>
								<Input
									id="staff-phone"
									type="tel"
									maxLength={32}
									autoComplete="off"
									value={value.phone}
									onChange={(event) => set('phone', event.target.value)}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="staff-hired-on">
									<Trans>Hire date</Trans>
								</Label>
								<Input
									id="staff-hired-on"
									type="date"
									value={value.hiredOn}
									onChange={(event) => set('hiredOn', event.target.value)}
								/>
							</div>
						</div>

						<div className="space-y-3">
							<div className="flex items-center justify-between gap-3">
								<div>
									<p className="text-sm font-medium">
										<Trans>Locations and positions</Trans>
									</p>
									<p className="text-muted-foreground text-xs">
										<Trans>
											The primary position is preselected on the schedule and
											time clock.
										</Trans>
									</p>
								</div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={!locations.length || !activePositions.length}
									onClick={() =>
										set('assignments', [
											...value.assignments,
											{
												locationId:
													assignableLocations.length === 1
														? assignableLocations[0]!.id
														: '',
												positionId: '',
												isPrimary: false,
											},
										])
									}
								>
									<Icon name="plus" className="size-4" />
									<Trans>Add position</Trans>
								</Button>
							</div>
							{!activePositions.length ? (
								<p className="text-muted-foreground text-sm">
									<Trans>Create a position first under Positions.</Trans>
								</p>
							) : null}
							{value.assignments.map((assignment, index) => (
								<div
									key={index}
									className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end"
								>
									<div className="space-y-1">
										<Label htmlFor={`assignment-location-${index}`}>
											<Trans>Location</Trans>
										</Label>
										<select
											id={`assignment-location-${index}`}
											className={selectClass}
											required
											value={assignment.locationId}
											onChange={(event) =>
												setAssignment(index, { locationId: event.target.value })
											}
										>
											<option value="">{_(msg`Choose a location`)}</option>
											{assignableLocations.map((location) => (
												<option key={location.id} value={location.id}>
													{location.name}
												</option>
											))}
										</select>
									</div>
									<div className="space-y-1">
										<Label htmlFor={`assignment-position-${index}`}>
											<Trans>Position</Trans>
										</Label>
										<select
											id={`assignment-position-${index}`}
											className={selectClass}
											required
											value={assignment.positionId}
											onChange={(event) =>
												setAssignment(index, { positionId: event.target.value })
											}
										>
											<option value="">{_(msg`Choose a position`)}</option>
											{activePositions.map((position) => (
												<option key={position.id} value={position.id}>
													{position.name}
												</option>
											))}
										</select>
									</div>
									<label className="flex h-9 items-center gap-2 text-sm">
										<input
											type="radio"
											name={`primary-${assignment.locationId || index}`}
											checked={assignment.isPrimary}
											onChange={() => setAssignment(index, { isPrimary: true })}
										/>
										<Trans>Primary</Trans>
									</label>
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										aria-label={_(msg`Remove position`)}
										onClick={() =>
											set(
												'assignments',
												value.assignments.filter(
													(_item, itemIndex) => itemIndex !== index,
												),
											)
										}
									>
										<Icon name="trash-2" className="size-4" />
									</Button>
								</div>
							))}
						</div>

						<div className="space-y-2">
							<Label htmlFor="staff-note">
								<Trans>Manager note</Trans>
							</Label>
							<Textarea
								id="staff-note"
								maxLength={2000}
								rows={3}
								value={value.note}
								onChange={(event) => set('note', event.target.value)}
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Visible to managers only. Do not store tax IDs, bank details,
									or health information.
								</Trans>
							</p>
						</div>
					</fieldset>
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
						{canWrite ? (
							<Button type="submit" disabled={busy || incomplete}>
								{busy ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
							</Button>
						) : null}
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
