import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { FieldLegend, FieldSet } from '@repo/ui/field'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { Skeleton } from '@repo/ui/skeleton'
import { type FormEvent, useEffect, useState } from 'react'
import { SelectField, TextAreaField } from '#app/components/staff/controls.tsx'
import { useMyScheduleData } from '#app/hooks/use-my-schedule-data.ts'
import {
	type MyScheduleApi,
	type MyShift,
} from '#app/utils/my-schedule/my-schedule-api.ts'
import {
	formatDay,
	formatRange,
} from '#app/utils/my-schedule/my-schedule-format.ts'
import { describeMyScheduleError } from '#app/utils/my-schedule/my-schedule-messages.ts'

type Kind = 'drop' | 'cover' | 'swap'

/**
 * Asking for a change to one upcoming shift: give it away, ask a named teammate
 * to cover it, or swap it for one of theirs. It files a request; the shift stays
 * the person's until a manager approves. Teammates appear as a first name and a
 * last initial. A swap needs the scope to let the team see the schedule (it
 * shows the other shift's day and hours), so without that it is simply not
 * offered.
 */
export function ShiftChangeSheet({
	api,
	shift,
	locale,
	onClose,
	onDone,
}: {
	api: MyScheduleApi
	shift: MyShift | null
	locale: string
	onClose: () => void
	onDone: () => void
}) {
	const { _ } = useLingui()
	const open = shift !== null
	const [kind, setKind] = useState<Kind>('drop')
	const [target, setTarget] = useState('')
	const [targetShift, setTargetShift] = useState('')
	const [note, setNote] = useState('')
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const people = useMyScheduleData(
		shift ? () => api.teammates(shift.id) : null,
		shift?.id ?? '',
	)

	useEffect(() => {
		if (!shift) return
		setKind('drop')
		setTarget('')
		setTargetShift('')
		setNote('')
		setError(null)
	}, [shift])

	const data = people.data
	const needsPerson = kind !== 'drop'
	const theirShifts = (data?.swapCandidates ?? []).filter(
		(candidate) => candidate.staffId === target,
	)
	const ready =
		kind === 'drop' ||
		(kind === 'cover' && target !== '') ||
		(kind === 'swap' && target !== '' && targetShift !== '')

	async function submit(event: FormEvent) {
		event.preventDefault()
		if (!shift || !ready || pending) return
		setPending(true)
		setError(null)
		try {
			await api.requestShiftChange({
				kind,
				shiftId: shift.id,
				...(needsPerson ? { targetStaffId: target } : {}),
				...(kind === 'swap' ? { targetShiftId: targetShift } : {}),
				note: note.trim() === '' ? null : note.trim(),
			})
			onDone()
		} catch (failure) {
			setError(describeMyScheduleError(failure, _))
		} finally {
			setPending(false)
		}
	}

	const teammateOptions = (data?.teammates ?? []).map((person) => ({
		value: person.id,
		label: person.name,
	}))

	return (
		<Sheet open={open} onOpenChange={(next) => !next && onClose()}>
			<SheetContent
				side="bottom"
				className="max-h-[92dvh] sm:mx-auto sm:max-w-lg"
			>
				<SheetHeader className="pe-12 rtl:ps-12 rtl:pe-4">
					<SheetTitle>
						<Trans>Ask for a change</Trans>
					</SheetTitle>
					<SheetDescription>
						{shift ? (
							<>
								{formatDay(shift.localDate, locale)} ·{' '}
								<bdi>
									{formatRange(
										shift.startsAt,
										shift.endsAt,
										shift.timeZone,
										locale,
									)}
								</bdi>
							</>
						) : null}
					</SheetDescription>
				</SheetHeader>
				<form
					onSubmit={(event) => void submit(event)}
					noValidate
					className="flex min-h-0 flex-1 flex-col"
				>
					<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
						{people.loading ? (
							<Skeleton aria-hidden="true" className="h-24 w-full" />
						) : (
							<FieldSet>
								<FieldLegend variant="label">
									<Trans>What do you need?</Trans>
								</FieldLegend>
								<RadioGroup
									value={kind}
									onValueChange={(next) => {
										setKind(next as Kind)
										setTargetShift('')
									}}
									aria-label={_(t`What do you need?`)}
								>
									<Label className="min-h-11 w-full">
										<RadioGroupItem value="drop" />
										<span>
											<Trans>I cannot work it</Trans>
										</span>
									</Label>
									<Label className="min-h-11 w-full">
										<RadioGroupItem
											value="cover"
											disabled={(data?.teammates.length ?? 0) === 0}
										/>
										<span>
											<Trans>Ask a teammate to cover it</Trans>
										</span>
									</Label>
									{data?.canSwap ? (
										<Label className="min-h-11 w-full">
											<RadioGroupItem value="swap" />
											<span>
												<Trans>Swap it for one of theirs</Trans>
											</span>
										</Label>
									) : null}
								</RadioGroup>
							</FieldSet>
						)}

						{needsPerson ? (
							<SelectField
								label={_(t`Teammate`)}
								options={teammateOptions}
								placeholder={_(t`Choose a teammate`)}
								value={target}
								onValueChange={(next) => {
									setTarget(next)
									setTargetShift('')
								}}
							/>
						) : null}

						{kind === 'swap' && target !== '' ? (
							theirShifts.length === 0 ? (
								<p className="text-muted-foreground text-sm">
									<Trans>
										They have no upcoming shifts you could swap for.
									</Trans>
								</p>
							) : (
								<SelectField
									label={_(t`Their shift`)}
									options={theirShifts.map((candidate) => ({
										value: candidate.id,
										label: `${formatDay(candidate.localDate, locale)} · ${formatRange(
											candidate.startsAt,
											candidate.endsAt,
											candidate.timeZone,
											locale,
										)}`,
									}))}
									placeholder={_(t`Choose a shift`)}
									value={targetShift}
									onValueChange={setTargetShift}
								/>
							)
						) : null}

						<TextAreaField
							label={_(t`Note for your manager`)}
							optional
							maxLength={500}
							value={note}
							onChange={(event) => setNote(event.target.value)}
						/>
						<p className="text-muted-foreground text-sm">
							<Trans>
								A manager decides. The shift stays yours until they approve it.
							</Trans>
						</p>
						{people.error && !data ? (
							<Alert>
								<AlertDescription>
									{describeMyScheduleError(people.error, _)}
								</AlertDescription>
							</Alert>
						) : null}
						{error ? (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
					</div>
					<SheetFooter className="border-t sm:flex-row sm:justify-end">
						<Button
							type="button"
							variant="ghost"
							className="h-11"
							onClick={onClose}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							className="h-11"
							disabled={!ready || pending || people.loading}
						>
							{pending ? <Trans>Sending…</Trans> : <Trans>Send request</Trans>}
						</Button>
					</SheetFooter>
				</form>
			</SheetContent>
		</Sheet>
	)
}
