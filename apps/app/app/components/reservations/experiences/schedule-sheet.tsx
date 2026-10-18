import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { parseHhmm } from '@repo/reservations'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Field, FieldError, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { type FormEvent, useState } from 'react'
import {
	type Option,
	SelectField,
	TextField,
} from '#app/components/staff/controls.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import {
	type ExperienceContext,
	type ExperienceScheduleDto,
	type ScheduleBody,
} from '#app/utils/reservations/experiences-api.ts'
import {
	emptyScheduleForm,
	formatSeatingMin,
	MASK_WEEKDAYS,
	type ScheduleFormErrors,
	type ScheduleFormField,
	type ScheduleFormValues,
	scheduleFormToBody,
	scheduleToForm,
} from '#app/utils/reservations/experiences-view.ts'

const ANY_SERVICE = '__any__'

/**
 * Add or edit one schedule of an experience: the dates it runs, the days, the
 * seating times (specific times or an interval) and the limits. The form is a
 * local draft; nothing is saved until Save, and a failed save leaves it as
 * typed. Seating times are kitchen-local times of day.
 */
export function ScheduleSheet({
	open,
	onClose,
	schedule,
	today,
	usesTables,
	context,
	onSave,
}: {
	open: boolean
	onClose: () => void
	schedule: ExperienceScheduleDto | null
	today: string
	usesTables: boolean
	context: ExperienceContext
	/** Resolves to sentences to show when the save failed, or null when it worked. */
	onSave: (body: ScheduleBody) => Promise<string[] | null>
}) {
	return (
		<Sheet open={open} onOpenChange={(next) => !next && onClose()}>
			<SheetContent className="sm:max-w-lg" data-testid="schedule-sheet">
				{open ? (
					<Body
						schedule={schedule}
						today={today}
						usesTables={usesTables}
						context={context}
						onClose={onClose}
						onSave={onSave}
					/>
				) : null}
			</SheetContent>
		</Sheet>
	)
}

function Body({
	schedule,
	today,
	usesTables,
	context,
	onClose,
	onSave,
}: Omit<Parameters<typeof ScheduleSheet>[0], 'open'>) {
	const { t, i18n } = useLingui()
	const [form, setForm] = useState<ScheduleFormValues>(() =>
		schedule ? scheduleToForm(schedule) : emptyScheduleForm(today),
	)
	const [errors, setErrors] = useState<ScheduleFormErrors>({})
	const [banner, setBanner] = useState<string[]>([])
	const [pending, setPending] = useState(false)
	const [newTime, setNewTime] = useState('19:00')

	const set = <K extends keyof ScheduleFormValues>(
		key: K,
		value: ScheduleFormValues[K],
	) => setForm((current) => ({ ...current, [key]: value }))

	const message = (field: ScheduleFormField) =>
		errors[field] ? i18n._(errors[field]!) : null

	const modeOptions: Option[] = [
		{ value: 'times', label: t`Specific times` },
		{ value: 'interval', label: t`Every few minutes` },
	]
	const serviceOptions: Option[] = [
		{ value: ANY_SERVICE, label: t`Any service` },
		...context.services.map((service) => ({
			value: service.id,
			label: service.name,
		})),
	]

	function addTime() {
		try {
			parseHhmm(newTime)
		} catch {
			setErrors((current) => ({
				...current,
				times: msg`Enter times like 19:00.`,
			}))
			return
		}
		setErrors((current) => ({ ...current, times: undefined }))
		set('times', [...new Set([...form.times, newTime])].sort())
	}

	function toggleDay(bit: number, checked: boolean) {
		const days = [...form.days]
		days[bit] = checked
		set('days', days)
	}

	function toggleArea(id: string, checked: boolean) {
		set(
			'areaIds',
			checked
				? [...form.areaIds, id]
				: form.areaIds.filter((area) => area !== id),
		)
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const parsed = scheduleFormToBody(form, { usesTables })
		if (!parsed.ok) {
			setErrors(parsed.errors)
			setBanner([])
			return
		}
		setErrors({})
		setBanner([])
		setPending(true)
		try {
			const failed = await onSave(parsed.body)
			if (failed) setBanner(failed)
		} finally {
			setPending(false)
		}
	}

	return (
		<SheetForm
			title={schedule ? t`Edit schedule` : t`Add schedule`}
			description={t`The dates, days and seating times this experience runs.`}
			onSubmit={submit}
			footer={
				<>
					<Button type="button" variant="ghost" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button type="submit" disabled={pending} data-testid="schedule-save">
						{pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
					</Button>
				</>
			}
		>
			{banner.length > 0 ? (
				<Alert variant="destructive" data-testid="schedule-error">
					<AlertDescription>{banner.join(' ')}</AlertDescription>
				</Alert>
			) : null}

			<div className="grid gap-4 sm:grid-cols-2">
				<TextField
					label={<Trans>First date</Trans>}
					type="date"
					value={form.fromDate}
					onChange={(event) => set('fromDate', event.target.value)}
					error={message('fromDate')}
					data-testid="schedule-from"
				/>
				<TextField
					label={<Trans>Last date</Trans>}
					type="date"
					value={form.toDate}
					onChange={(event) => set('toDate', event.target.value)}
					error={message('toDate')}
					data-testid="schedule-to"
				/>
			</div>

			<Field data-invalid={errors.days ? true : undefined}>
				<FieldLabel>
					<Trans>Days</Trans>
				</FieldLabel>
				<div className="flex flex-wrap gap-x-4 gap-y-2">
					{MASK_WEEKDAYS.map((day) => {
						const id = `schedule-day-${day.code}`
						return (
							<div
								key={day.code}
								className="flex min-h-11 items-center gap-2 md:min-h-8"
							>
								<Checkbox
									id={id}
									checked={form.days[day.bit] ?? false}
									onCheckedChange={(value) =>
										toggleDay(day.bit, value === true)
									}
									data-testid={id}
								/>
								<FieldLabel htmlFor={id} className="font-normal">
									{i18n._(day.short)}
								</FieldLabel>
							</div>
						)
					})}
				</div>
				{errors.days ? <FieldError>{message('days')}</FieldError> : null}
			</Field>

			<SelectField
				label={<Trans>Seating times</Trans>}
				value={form.mode}
				options={modeOptions}
				onValueChange={(value) => set('mode', value as 'times' | 'interval')}
				id="schedule-mode"
			/>
			{form.mode === 'times' ? (
				<Field data-invalid={errors.times ? true : undefined}>
					<div className="flex items-end gap-2">
						<div className="flex flex-1 flex-col gap-1.5">
							<FieldLabel htmlFor="schedule-new-time">
								<Trans>Add a time</Trans>
							</FieldLabel>
							<Input
								id="schedule-new-time"
								type="time"
								value={newTime}
								onChange={(event) => setNewTime(event.target.value)}
								data-testid="schedule-new-time"
								className="h-11 md:h-8"
							/>
						</div>
						<Button
							type="button"
							variant="outline"
							onClick={addTime}
							className="h-11 md:h-8"
							data-testid="schedule-add-time"
						>
							<Icon name="plus" />
							<Trans>Add</Trans>
						</Button>
					</div>
					<ul className="flex flex-wrap gap-2" data-testid="schedule-times">
						{form.times.map((time) => {
							const label = formatSeatingMin(parseHhmm(time), i18n.locale)
							return (
								<li
									key={time}
									className="bg-muted text-foreground flex items-center gap-1 rounded-md ps-2 text-sm"
								>
									<span className="tabular-nums" dir="ltr">
										{label}
									</span>
									<Button
										type="button"
										size="icon-xs"
										variant="ghost"
										aria-label={t`Remove ${label}`}
										onClick={() =>
											set(
												'times',
												form.times.filter((existing) => existing !== time),
											)
										}
									>
										<Icon name="x" />
									</Button>
								</li>
							)
						})}
					</ul>
					{errors.times ? <FieldError>{message('times')}</FieldError> : null}
				</Field>
			) : (
				<div className="grid gap-4 sm:grid-cols-3">
					<TextField
						label={<Trans>First seating</Trans>}
						type="time"
						value={form.start}
						onChange={(event) => set('start', event.target.value)}
						error={message('start')}
						data-testid="schedule-start"
					/>
					<TextField
						label={<Trans>Last seating</Trans>}
						type="time"
						value={form.end}
						onChange={(event) => set('end', event.target.value)}
						error={message('end')}
						data-testid="schedule-end"
					/>
					<TextField
						label={<Trans>Minutes apart</Trans>}
						inputMode="numeric"
						value={form.interval}
						onChange={(event) => set('interval', event.target.value)}
						error={message('interval')}
						data-testid="schedule-interval"
					/>
				</div>
			)}

			<TextField
				label={<Trans>Table time (minutes)</Trans>}
				hint={<Trans>How long a party keeps its table.</Trans>}
				inputMode="numeric"
				value={form.turnMin}
				onChange={(event) => set('turnMin', event.target.value)}
				error={message('turnMin')}
				data-testid="schedule-turn"
			/>
			<div className="grid gap-4 sm:grid-cols-2">
				<TextField
					label={<Trans>Guests per seating</Trans>}
					optional
					inputMode="numeric"
					value={form.capSeating}
					onChange={(event) => set('capSeating', event.target.value)}
					error={message('capSeating')}
					data-testid="schedule-cap-seating"
				/>
				<TextField
					label={<Trans>Guests per day</Trans>}
					optional
					inputMode="numeric"
					value={form.capDay}
					onChange={(event) => set('capDay', event.target.value)}
					error={message('capDay')}
					data-testid="schedule-cap-day"
				/>
			</div>

			{context.areas.length > 0 ? (
				<Field>
					<FieldLabel>
						<Trans>Only seat guests in</Trans>
					</FieldLabel>
					<p className="text-muted-foreground text-sm">
						<Trans>Leave all unchecked to use every area.</Trans>
					</p>
					<div className="flex flex-col gap-1">
						{context.areas.map((area) => {
							const id = `schedule-area-${area.id}`
							return (
								<div
									key={area.id}
									className="flex min-h-11 items-center gap-2 md:min-h-8"
								>
									<Checkbox
										id={id}
										checked={form.areaIds.includes(area.id)}
										onCheckedChange={(value) =>
											toggleArea(area.id, value === true)
										}
									/>
									<FieldLabel htmlFor={id} className="font-normal">
										{area.name}
									</FieldLabel>
								</div>
							)
						})}
					</div>
				</Field>
			) : null}
			{context.services.length > 0 ? (
				<SelectField
					label={<Trans>Only during service</Trans>}
					value={form.serviceId || ANY_SERVICE}
					options={serviceOptions}
					onValueChange={(value) =>
						set('serviceId', value === ANY_SERVICE ? '' : value)
					}
					id="schedule-service"
				/>
			) : null}
		</SheetForm>
	)
}
