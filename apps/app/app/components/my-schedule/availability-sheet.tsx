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
import { SelectField } from '#app/components/staff/controls.tsx'
import { type MyScheduleApi } from '#app/utils/my-schedule/my-schedule-api.ts'
import { intlLocale } from '#app/utils/my-schedule/my-schedule-format.ts'
import { describeMyScheduleError } from '#app/utils/my-schedule/my-schedule-messages.ts'
import {
	DAY_MODES,
	emptyDays,
	formatMinute,
	invalidDays,
	weekdayName,
	weeklyRows,
	type DayDraft,
	type DayMode,
} from '#app/utils/staffing/schedule-requests.ts'
import { timeSteps } from '#app/utils/staffing/schedule-view.ts'

function minutesOf(value: string): number {
	if (value === '24:00') return 1440
	const [h = 0, m = 0] = value.split(':').map(Number)
	return h * 60 + m
}

/**
 * Sending the usual week: for each day, free all day, busy all day, or free or
 * busy during some hours. Days left as "No preference" are not sent. It replaces
 * the earlier weekly pattern only once a manager approves it.
 */
export function AvailabilitySheet({
	open,
	api,
	locale,
	onClose,
	onDone,
}: {
	open: boolean
	api: MyScheduleApi
	locale: string
	onClose: () => void
	onDone: () => void
}) {
	const { _ } = useLingui()
	const [days, setDays] = useState<DayDraft[]>(emptyDays)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [bad, setBad] = useState<number[]>([])

	useEffect(() => {
		if (!open) return
		setDays(emptyDays())
		setError(null)
		setBad([])
	}, [open])

	const modeLabels: Record<DayMode, string> = {
		unset: _(t`No preference`),
		available_all: _(t`Available all day`),
		unavailable_all: _(t`Unavailable all day`),
		available_hours: _(t`Available during…`),
		unavailable_hours: _(t`Unavailable during…`),
	}
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
	const setDay = (weekday: number, patch: Partial<DayDraft>) =>
		setDays((current) =>
			current.map((day) =>
				day.weekday === weekday ? { ...day, ...patch } : day,
			),
		)

	async function submit(event: FormEvent) {
		event.preventDefault()
		if (pending) return
		const invalid = invalidDays(days)
		setBad(invalid)
		if (invalid.length > 0) return
		const rows = weeklyRows(days)
		if (rows.length === 0) {
			setError(_(t`Choose something for at least one day.`))
			return
		}
		setPending(true)
		setError(null)
		try {
			await api.submitAvailability({ rows, replaceWeekly: true })
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
						<Trans>Update my availability</Trans>
					</SheetTitle>
					<SheetDescription>
						<Trans>
							Tell your manager when you can usually work. It changes your
							schedule only after they approve it.
						</Trans>
					</SheetDescription>
				</SheetHeader>
				<form
					onSubmit={(event) => void submit(event)}
					noValidate
					className="flex min-h-0 flex-1 flex-col"
				>
					<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
						{days.map((day) => {
							const timed =
								day.mode === 'available_hours' ||
								day.mode === 'unavailable_hours'
							return (
								<div key={day.weekday} className="flex flex-col gap-2">
									<SelectField
										label={weekdayName(day.weekday, intlLocale(locale))}
										options={DAY_MODES.map((mode) => ({
											value: mode,
											label: modeLabels[mode],
										}))}
										value={day.mode}
										onValueChange={(next) =>
											setDay(day.weekday, { mode: next as DayMode })
										}
									/>
									{timed ? (
										<div className="grid grid-cols-2 gap-3">
											<SelectField
												label={_(t`From`)}
												options={startOptions}
												value={day.startTime}
												onValueChange={(next) =>
													setDay(day.weekday, { startTime: next })
												}
											/>
											<SelectField
												label={_(t`Until`)}
												options={endOptions}
												value={day.endTime}
												error={
													bad.includes(day.weekday)
														? _(t`The end has to be after the start.`)
														: null
												}
												onValueChange={(next) =>
													setDay(day.weekday, { endTime: next })
												}
											/>
										</div>
									) : null}
								</div>
							)
						})}
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
							{pending ? <Trans>Sending…</Trans> : <Trans>Send</Trans>}
						</Button>
					</SheetFooter>
				</form>
			</SheetContent>
		</Sheet>
	)
}
