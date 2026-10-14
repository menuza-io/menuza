import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import {
	SelectField,
	TextAreaField,
	TextField,
} from '#app/components/staff/controls.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import {
	type MyScheduleApi,
	type TimeOffBody,
} from '#app/utils/my-schedule/my-schedule-api.ts'
import { intlLocale } from '#app/utils/my-schedule/my-schedule-format.ts'
import { describeMyScheduleError } from '#app/utils/my-schedule/my-schedule-messages.ts'
import { formatMinute } from '#app/utils/staffing/schedule-requests.ts'
import { timeSteps } from '#app/utils/staffing/schedule-view.ts'

function minutesOf(value: string): number {
	if (value === '24:00') return 1440
	const [h = 0, m = 0] = value.split(':').map(Number)
	return h * 60 + m
}

/**
 * Asking for time off: when, whether it is the whole day, why (optional). It is
 * a request; nothing changes on the schedule until a manager approves it.
 */
export function TimeOffSheet({
	open,
	api,
	today,
	locale,
	onClose,
	onDone,
}: {
	open: boolean
	api: MyScheduleApi
	today: string
	locale: string
	onClose: () => void
	onDone: () => void
}) {
	const { _ } = useLingui()
	const [category, setCategory] = useState<TimeOffBody['category']>('unpaid')
	const [startDate, setStartDate] = useState(today)
	const [endDate, setEndDate] = useState(today)
	const [allDay, setAllDay] = useState(true)
	const [startTime, setStartTime] = useState('09:00')
	const [endTime, setEndTime] = useState('17:00')
	const [note, setNote] = useState('')
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [problems, setProblems] = useState<{ dates?: string; time?: string }>(
		{},
	)

	useEffect(() => {
		if (!open) return
		setCategory('unpaid')
		setStartDate(today)
		setEndDate(today)
		setAllDay(true)
		setStartTime('09:00')
		setEndTime('17:00')
		setNote('')
		setError(null)
		setProblems({})
	}, [open, today])

	const startOptions = useMemo(
		() =>
			timeSteps().map((value) => ({
				value,
				label: formatMinute(minutesOf(value), intlLocale(locale)),
			})),
		[locale],
	)
	const endOptions = useMemo(
		() => [
			...startOptions.slice(1),
			{ value: '24:00', label: _(t`End of day`) },
		],
		[startOptions, _],
	)

	async function submit(event: FormEvent) {
		event.preventDefault()
		if (pending) return
		const next: typeof problems = {}
		if (!startDate || !endDate || endDate < startDate) {
			next.dates = _(t`The last day cannot be before the first day.`)
		}
		const sameDay = startDate === endDate
		if (!allDay) {
			if (!sameDay) next.time = _(t`Part of a day is for one date only.`)
			else if (minutesOf(endTime) <= minutesOf(startTime)) {
				next.time = _(t`The end has to be after the start.`)
			}
		}
		setProblems(next)
		if (Object.keys(next).length > 0) return
		setPending(true)
		setError(null)
		try {
			await api.requestTimeOff({
				category,
				startDate,
				endDate,
				allDay,
				...(allDay ? {} : { startTime, endTime }),
				note: note.trim() === '' ? null : note.trim(),
			})
			onDone()
		} catch (failure) {
			setError(describeMyScheduleError(failure, _))
		} finally {
			setPending(false)
		}
	}

	return (
		<Sheet open={open} onOpenChange={(next) => !next && onClose()}>
			<SheetContent
				side="bottom"
				className="max-h-[92dvh] sm:mx-auto sm:max-w-lg"
			>
				<SheetHeader className="pe-12 rtl:ps-12 rtl:pe-4">
					<SheetTitle>
						<Trans>Request time off</Trans>
					</SheetTitle>
					<SheetDescription>
						<Trans>A manager will approve or decline it.</Trans>
					</SheetDescription>
				</SheetHeader>
				<form
					onSubmit={(event) => void submit(event)}
					noValidate
					className="flex min-h-0 flex-1 flex-col"
				>
					<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
						<SelectField
							label={_(t`Type`)}
							options={[
								{ value: 'unpaid', label: _(t`Unpaid time off`) },
								{ value: 'pto', label: _(t`Paid time off`) },
								{ value: 'sick', label: _(t`Sick`) },
							]}
							value={category}
							onValueChange={(next) =>
								setCategory(next as TimeOffBody['category'])
							}
						/>
						<div className="grid grid-cols-2 gap-3">
							<TextField
								label={_(t`First day`)}
								type="date"
								value={startDate}
								min={today}
								onChange={(event) => {
									setStartDate(event.target.value)
									if (endDate < event.target.value)
										setEndDate(event.target.value)
								}}
							/>
							<TextField
								label={_(t`Last day`)}
								type="date"
								value={endDate}
								min={startDate || today}
								error={problems.dates}
								onChange={(event) => setEndDate(event.target.value)}
							/>
						</div>
						<SwitchField
							label={_(t`All day`)}
							checked={allDay}
							onCheckedChange={setAllDay}
						/>
						{!allDay ? (
							<div className="grid grid-cols-2 gap-3">
								<SelectField
									label={_(t`From`)}
									options={startOptions}
									value={startTime}
									onValueChange={setStartTime}
								/>
								<SelectField
									label={_(t`Until`)}
									options={endOptions}
									value={endTime}
									error={problems.time}
									onValueChange={setEndTime}
								/>
							</div>
						) : null}
						<TextAreaField
							label={_(t`Note for your manager`)}
							optional
							maxLength={500}
							value={note}
							onChange={(event) => setNote(event.target.value)}
						/>
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
						<Button type="submit" className="h-11" disabled={pending}>
							{pending ? <Trans>Sending…</Trans> : <Trans>Send request</Trans>}
						</Button>
					</SheetFooter>
				</form>
			</SheetContent>
		</Sheet>
	)
}
