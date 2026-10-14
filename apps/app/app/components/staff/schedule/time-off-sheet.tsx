import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { TIME_OFF_CATEGORIES } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { type FormEvent, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
	SelectField,
	TextAreaField,
	type Option,
} from '#app/components/staff/controls.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { type StaffDirectory } from '#app/hooks/use-staff-directory.ts'
import { createTimeOff } from '#app/utils/staffing/schedule-api.ts'
import { describeScheduleError } from '#app/utils/staffing/schedule-errors.ts'
import { formatMinute } from '#app/utils/staffing/schedule-requests.ts'
import { timeSteps } from '#app/utils/staffing/schedule-view.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { staffDisplayName } from '#app/utils/staffing/staff-format.ts'
import { DateRangeField, type DateRange } from './date-range-field.tsx'

function useCategoryLabels() {
	const { _ } = useLingui()
	return {
		pto: _(t`Paid time off`),
		sick: _(t`Sick leave`),
		unpaid: _(t`Unpaid time off`),
	} as const
}
export { useCategoryLabels }

/**
 * Record time off for someone. A manager entering it is final: it is approved
 * at once. Short notice and a long stretch show as notes after saving, not as
 * blockers.
 */
export function TimeOffSheet({
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
}: Omit<Parameters<typeof TimeOffSheet>[0], 'open'>) {
	const { _ } = useLingui()
	const categories = useCategoryLabels()
	const action = useStaffAction(describeScheduleError)
	const [staffId, setStaffId] = useState('')
	const [category, setCategory] =
		useState<(typeof TIME_OFF_CATEGORIES)[number]>('pto')
	const [dates, setDates] = useState<DateRange>({ from: null, to: null })
	const [allDay, setAllDay] = useState(true)
	const [startTime, setStartTime] = useState('12:00')
	const [endTime, setEndTime] = useState('17:00')
	const [note, setNote] = useState('')
	const [errors, setErrors] = useState<
		Partial<Record<'person' | 'dates' | 'time', string>>
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
	const timeOptions: Option[] = useMemo(
		() => [
			...timeSteps().map((value) => ({
				value,
				label: formatMinute(
					Number(value.slice(0, 2)) * 60 + Number(value.slice(3)),
					locale,
				),
			})),
			{ value: '24:00', label: _(t`End of day`) },
		],
		[locale, _],
	)

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const found: typeof errors = {}
		if (!staffId) found.person = _(t`Choose who this is for.`)
		if (!dates.from) found.dates = _(t`Choose the day or days.`)
		const from = dates.from
		const to = dates.to ?? dates.from
		if (!allDay && from && to && from !== to)
			found.dates = _(t`Part of a day covers one date.`)
		if (
			!allDay &&
			(endTime === '24:00' ? 1440 : toMinutes(endTime)) <= toMinutes(startTime)
		) {
			found.time = _(t`The end has to be after the start.`)
		}
		setErrors(found)
		if (Object.keys(found).length > 0 || !from || !to) return
		const result = await action.run(() =>
			createTimeOff(client, {
				staffId,
				category,
				startDate: from,
				endDate: to,
				allDay,
				...(allDay ? {} : { startTime, endTime }),
				note: note.trim() === '' ? null : note.trim(),
				submission: 'manager_entered',
			}),
		)
		if (!result.ok) return
		const notes = result.value.warnings.map((warning) =>
			warning.code === 'short_notice'
				? _(t`It was entered on short notice.`)
				: warning.code === 'over_daily_limit'
					? _(t`It covers more days than usual.`)
					: '',
		)
		const extra = notes.filter(Boolean).join(' ')
		if (extra) toast.warning(`${_(t`Time off recorded.`)} ${extra}`)
		else toast.success(_(t`Time off recorded.`))
		onSaved()
		onClose()
	}

	return (
		<SheetForm
			title={_(t`Add time off`)}
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
			<SelectField
				label={<Trans>Type</Trans>}
				value={category}
				options={TIME_OFF_CATEGORIES.map((value) => ({
					value,
					label: categories[value],
				}))}
				onValueChange={(value) => setCategory(value as typeof category)}
			/>
			<DateRangeField
				label={<Trans>Dates</Trans>}
				value={dates}
				onChange={setDates}
				locale={locale}
				error={errors.dates}
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
						options={timeOptions.slice(0, -1)}
						onValueChange={setStartTime}
					/>
					<SelectField
						label={<Trans>Until</Trans>}
						value={endTime}
						options={timeOptions}
						onValueChange={setEndTime}
						error={errors.time}
					/>
				</div>
			) : null}
			<TextAreaField
				label={<Trans>Note</Trans>}
				optional
				rows={3}
				value={note}
				onChange={(event) => setNote(event.target.value)}
			/>
		</SheetForm>
	)
}

function toMinutes(value: string): number {
	const [h = 0, m = 0] = value.split(':').map(Number)
	return h * 60 + m
}
