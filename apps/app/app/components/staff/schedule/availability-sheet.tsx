import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { type FormEvent, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
	SelectField,
	TextField,
	type Option,
} from '#app/components/staff/controls.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { type StaffDirectory } from '#app/hooks/use-staff-directory.ts'
import { createAvailability } from '#app/utils/staffing/schedule-api.ts'
import { describeScheduleError } from '#app/utils/staffing/schedule-errors.ts'
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
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { staffDisplayName } from '#app/utils/staffing/staff-format.ts'
import { DateRangeField, type DateRange } from './date-range-field.tsx'

function useModeLabels(): Record<DayMode, string> {
	const { _ } = useLingui()
	return {
		unset: _(t`No preference`),
		available_all: _(t`Available all day`),
		unavailable_all: _(t`Unavailable all day`),
		available_hours: _(t`Available during…`),
		unavailable_hours: _(t`Unavailable during…`),
	}
}

function minutesOf(value: string): number {
	if (value === '24:00') return 1440
	const [h = 0, m = 0] = value.split(':').map(Number)
	return h * 60 + m
}

/**
 * Record someone's availability: a weekly pattern, or one date. A manager
 * entering it is final (approved at once). A new weekly pattern can replace the
 * person's earlier one, so days left on "No preference" go back to open.
 */
export function AvailabilitySheet({
	open,
	onClose,
	client,
	directory,
	locale,
	onSaved,
}: {
	open: boolean
	onClose: () => void
	client: StaffClient
	directory: StaffDirectory
	locale: string
	onSaved: () => void
}) {
	return (
		<Sheet open={open} onOpenChange={(next) => !next && onClose()}>
			<SheetContent className="sm:max-w-md">
				{open ? (
					<Body
						client={client}
						directory={directory}
						locale={locale}
						onClose={onClose}
						onSaved={onSaved}
					/>
				) : null}
			</SheetContent>
		</Sheet>
	)
}

function Body({
	client,
	directory,
	locale,
	onClose,
	onSaved,
}: Omit<Parameters<typeof AvailabilitySheet>[0], 'open'>) {
	const { _ } = useLingui()
	const modeLabels = useModeLabels()
	const action = useStaffAction(describeScheduleError)
	const [tab, setTab] = useState<'weekly' | 'date'>('weekly')
	const [staffId, setStaffId] = useState('')
	const [days, setDays] = useState<DayDraft[]>(emptyDays)
	const [replace, setReplace] = useState(true)
	const [date, setDate] = useState<DateRange>({ from: null, to: null })
	const [dateKind, setDateKind] = useState<'available' | 'unavailable'>(
		'unavailable',
	)
	const [allDay, setAllDay] = useState(true)
	const [startTime, setStartTime] = useState('09:00')
	const [endTime, setEndTime] = useState('17:00')
	const [note, setNote] = useState('')
	const [errors, setErrors] = useState<
		Partial<Record<'person' | 'days' | 'date' | 'time', string>>
	>({})

	const peopleOptions: Option[] = useMemo(
		() =>
			(directory.people ?? [])
				.filter((person) => person.status !== 'terminated')
				.map((person) => ({
					value: person.id,
					label: staffDisplayName(person, locale),
				}))
				.sort((a, b) => a.label.localeCompare(b.label, locale)),
		[directory.people, locale],
	)
	const startOptions: Option[] = useMemo(
		() =>
			timeSteps().map((value) => ({
				value,
				label: formatMinute(minutesOf(value), locale),
			})),
		[locale],
	)
	const endOptions: Option[] = useMemo(
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

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const found: typeof errors = {}
		if (!staffId) found.person = _(t`Choose who this is for.`)
		let rows
		if (tab === 'weekly') {
			rows = weeklyRows(days)
			if (rows.length === 0) found.days = _(t`Set at least one day.`)
			else if (invalidDays(days).length > 0)
				found.days = _(t`Each set of hours has to end after it starts.`)
		} else {
			if (!date.from) found.date = _(t`Choose a date.`)
			if (!allDay && minutesOf(endTime) <= minutesOf(startTime))
				found.time = _(t`The end has to be after the start.`)
			rows = date.from
				? [
						{
							kind: 'one_off' as const,
							date: date.from,
							availability: dateKind,
							allDay,
							...(allDay ? {} : { startTime, endTime }),
							note: note.trim() === '' ? null : note.trim(),
						},
					]
				: []
		}
		setErrors(found)
		if (Object.keys(found).length > 0) return
		const result = await action.run(() =>
			createAvailability(client, {
				staffId,
				rows,
				replaceWeekly: tab === 'weekly' && replace,
				submission: 'manager_entered',
			}),
		)
		if (!result.ok) return
		toast.success(_(t`Availability saved.`))
		onSaved()
		onClose()
	}

	return (
		<SheetForm
			title={_(t`Add availability`)}
			description={_(t`Recorded by you, so it is approved right away.`)}
			onSubmit={submit}
			footer={
				<>
					<Button type="button" variant="ghost" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button type="submit" disabled={action.pending}>
						{action.pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
					</Button>
				</>
			}
		>
			{action.error ? (
				<Alert variant="destructive">
					<AlertDescription>{action.error}</AlertDescription>
				</Alert>
			) : null}
			<SelectField
				label={<Trans>Who</Trans>}
				value={staffId}
				options={peopleOptions}
				onValueChange={setStaffId}
				placeholder={directory.people ? _(t`Choose a person`) : _(t`Loading…`)}
				error={errors.person}
			/>
			<Tabs
				value={tab}
				onValueChange={(next) => setTab(next as 'weekly' | 'date')}
			>
				<TabsList>
					<TabsTrigger value="weekly">
						<Trans>Every week</Trans>
					</TabsTrigger>
					<TabsTrigger value="date">
						<Trans>One date</Trans>
					</TabsTrigger>
				</TabsList>
				<TabsContent value="weekly" className="mt-4 flex flex-col gap-4">
					{days.map((day) => {
						const name = weekdayName(day.weekday, locale)
						const timed =
							day.mode === 'available_hours' || day.mode === 'unavailable_hours'
						return (
							<div key={day.weekday} className="flex flex-col gap-2">
								<SelectField
									label={name}
									value={day.mode}
									options={DAY_MODES.map((value) => ({
										value,
										label: modeLabels[value],
									}))}
									onValueChange={(mode) =>
										setDay(day.weekday, { mode: mode as DayMode })
									}
								/>
								{timed ? (
									<div className="grid grid-cols-2 gap-3">
										<SelectField
											label={_(t`${name} from`)}
											value={day.startTime}
											options={startOptions}
											onValueChange={(startTime) =>
												setDay(day.weekday, { startTime })
											}
										/>
										<SelectField
											label={_(t`${name} until`)}
											value={day.endTime}
											options={endOptions}
											onValueChange={(endTime) =>
												setDay(day.weekday, { endTime })
											}
										/>
									</div>
								) : null}
							</div>
						)
					})}
					{errors.days ? (
						<Alert variant="destructive">
							<AlertDescription>{errors.days}</AlertDescription>
						</Alert>
					) : null}
					<SwitchField
						label={<Trans>Replace their weekly pattern</Trans>}
						description={
							<Trans>Days left on "No preference" go back to open.</Trans>
						}
						checked={replace}
						onCheckedChange={setReplace}
					/>
				</TabsContent>
				<TabsContent value="date" className="mt-4 flex flex-col gap-4">
					<DateRangeField
						label={<Trans>Date</Trans>}
						range={false}
						value={date}
						onChange={setDate}
						locale={locale}
						error={errors.date}
					/>
					<SelectField
						label={<Trans>On that date</Trans>}
						value={dateKind}
						options={[
							{ value: 'unavailable', label: _(t`Unavailable`) },
							{ value: 'available', label: _(t`Available`) },
						]}
						onValueChange={(value) => setDateKind(value as typeof dateKind)}
					/>
					<SwitchField
						label={<Trans>All day</Trans>}
						checked={allDay}
						onCheckedChange={setAllDay}
					/>
					{!allDay ? (
						<div className="grid grid-cols-2 gap-3">
							<SelectField
								label={<Trans>From</Trans>}
								value={startTime}
								options={startOptions}
								onValueChange={setStartTime}
							/>
							<SelectField
								label={<Trans>Until</Trans>}
								value={endTime}
								options={endOptions}
								onValueChange={setEndTime}
								error={errors.time}
							/>
						</div>
					) : null}
					<TextField
						label={<Trans>Note</Trans>}
						optional
						value={note}
						maxLength={500}
						onChange={(event) => setNote(event.target.value)}
					/>
				</TabsContent>
			</Tabs>
		</SheetForm>
	)
}
