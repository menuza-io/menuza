import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Field,
	FieldError,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useId } from 'react'
import {
	TextAreaField,
	TextField,
	type Option,
} from '#app/components/staff/controls.tsx'
import { formatDuration } from '#app/utils/staffing/timeclock-format.ts'
import {
	breakErrorKey,
	emptyBreak,
	resolveCardTimes,
	type BreakForm,
	type CardForm,
	type FormErrors,
} from '#app/utils/staffing/timesheet-form.ts'
import { dayOffset } from '#app/utils/staffing/timesheet-view.ts'

type Props = {
	form: CardForm
	onChange: (patch: Partial<CardForm>) => void
	errors: FormErrors
	timeZone: string
	disabled?: boolean
	moneyVisible: boolean
	/** Offered when the person holds several positions at the scope. */
	positionOptions: readonly Option[] | null
}

/**
 * Date, times, breaks, tips and note of one time card. Times are typed in the
 * scope's own time zone and the form says which one. A night shift is just
 * an end that is earlier than the start; the form says it ends the next day so
 * nobody has to guess.
 */
export function CardFields({
	form,
	onChange,
	errors,
	timeZone,
	disabled,
	moneyVisible,
	positionOptions,
}: Props) {
	const { _ } = useLingui()
	const times = resolveCardTimes(form, timeZone)
	const duration =
		times && times.clockOutAt !== null
			? formatDuration((times.clockOutAt - times.clockInAt) / 60_000, {
					hour: _(t`h`),
					minute: _(t`m`),
				})
			: null
	const nextDay =
		times && times.clockOutAt !== null
			? dayOffset(times.clockInAt, times.clockOutAt, timeZone) > 0
			: false

	function updateBreak(key: string, patch: Partial<BreakForm>) {
		onChange({
			breaks: form.breaks.map((item) =>
				item.key === key ? { ...item, ...patch } : item,
			),
		})
	}

	return (
		<div className="flex flex-col gap-5">
			{positionOptions && positionOptions.length > 1 ? (
				<PositionSelect
					options={positionOptions}
					value={form.positionId}
					onChange={(positionId) => onChange({ positionId })}
					error={errors.positionId}
					disabled={disabled}
				/>
			) : null}

			<FieldSet disabled={disabled}>
				<FieldLegend className="sr-only">
					<Trans>Shift</Trans>
				</FieldLegend>
				<TextField
					label={<Trans>Date</Trans>}
					type="date"
					dir="ltr"
					value={form.date}
					onChange={(event) => onChange({ date: event.target.value })}
					error={errors.date}
				/>
				<div className="grid grid-cols-2 gap-3">
					<TextField
						label={<Trans>Clock in</Trans>}
						type="time"
						step={60}
						dir="ltr"
						value={form.start}
						onChange={(event) => onChange({ start: event.target.value })}
						error={errors.start}
					/>
					<TextField
						label={<Trans>Clock out</Trans>}
						type="time"
						step={60}
						dir="ltr"
						value={form.end}
						onChange={(event) => onChange({ end: event.target.value })}
						error={errors.end}
					/>
				</div>
				<p className="text-muted-foreground text-xs" aria-live="polite">
					{duration ? (
						<>
							<Trans>Shift length {duration}.</Trans>{' '}
							{nextDay ? <Trans>Ends the next day.</Trans> : null}{' '}
						</>
					) : null}
					<Trans>Times are in the workplace's time zone, {timeZone}.</Trans>
				</p>
			</FieldSet>

			<FieldSet disabled={disabled}>
				<FieldLegend variant="label" className="mb-1">
					<Trans>Breaks</Trans>
				</FieldLegend>
				{form.breaks.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No breaks recorded.</Trans>
					</p>
				) : (
					<ul className="flex flex-col gap-3">
						{form.breaks.map((item, index) => (
							<BreakRow
								key={item.key}
								item={item}
								index={index}
								error={errors[breakErrorKey(item.key)]}
								disabled={disabled}
								onChange={(patch) => updateBreak(item.key, patch)}
								onRemove={() =>
									onChange({
										breaks: form.breaks.filter(
											(candidate) => candidate.key !== item.key,
										),
									})
								}
							/>
						))}
					</ul>
				)}
				<div>
					<Button
						type="button"
						variant="outline"
						disabled={disabled}
						onClick={() => onChange({ breaks: [...form.breaks, emptyBreak()] })}
					>
						<Icon name="plus" />
						<Trans>Add a break</Trans>
					</Button>
				</div>
			</FieldSet>

			{moneyVisible ? (
				<FieldSet disabled={disabled}>
					<FieldLegend variant="label" className="mb-1">
						<Trans>Tips</Trans>
					</FieldLegend>
					<div className="grid grid-cols-2 gap-3">
						<TextField
							label={<Trans>Cash tips</Trans>}
							inputMode="decimal"
							dir="ltr"
							placeholder="0.00"
							value={form.cashTips}
							onChange={(event) => onChange({ cashTips: event.target.value })}
							error={errors.cashTips}
						/>
						<TextField
							label={<Trans>Credit tips</Trans>}
							inputMode="decimal"
							dir="ltr"
							placeholder="0.00"
							value={form.creditTips}
							onChange={(event) => onChange({ creditTips: event.target.value })}
							error={errors.creditTips}
						/>
					</div>
				</FieldSet>
			) : null}

			<TextAreaField
				label={<Trans>Note</Trans>}
				optional
				value={form.note}
				onChange={(event) => onChange({ note: event.target.value })}
				error={errors.note}
				rows={2}
				maxLength={1000}
				disabled={disabled}
			/>
		</div>
	)
}

function PositionSelect({
	options,
	value,
	onChange,
	error,
	disabled,
}: {
	options: readonly Option[]
	value: string
	onChange: (value: string) => void
	error?: string
	disabled?: boolean
}) {
	const { _ } = useLingui()
	const id = useId()
	return (
		<Field data-invalid={error ? true : undefined}>
			<FieldLabel htmlFor={id}>
				<Trans>Position</Trans>
			</FieldLabel>
			<Select
				value={value}
				items={options as Option[]}
				onValueChange={(next) => next !== null && onChange(next)}
				disabled={disabled}
			>
				<SelectTrigger
					id={id}
					className="h-11 w-full md:h-8"
					aria-invalid={error ? true : undefined}
				>
					<SelectValue placeholder={_(t`Choose a position`)} />
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{error ? <FieldError>{error}</FieldError> : null}
		</Field>
	)
}

function BreakRow({
	item,
	index,
	error,
	disabled,
	onChange,
	onRemove,
}: {
	item: BreakForm
	index: number
	error?: string
	disabled?: boolean
	onChange: (patch: Partial<BreakForm>) => void
	onRemove: () => void
}) {
	const { _ } = useLingui()
	const number = index + 1
	const errorId = `break-error-${item.key}`
	const kinds: Option[] = [
		{ value: 'meal', label: _(t`Meal (unpaid)`) },
		{ value: 'rest', label: _(t`Rest (paid)`) },
	]
	return (
		<li className="flex flex-col gap-1.5">
			<div className="grid grid-cols-[1fr_1fr] items-end gap-2 sm:grid-cols-[1.2fr_1fr_1fr_auto]">
				<Field className="col-span-2 sm:col-span-1">
					<FieldLabel className="sr-only sm:not-sr-only">
						<Trans>Break {number}</Trans>
					</FieldLabel>
					<Select
						value={item.kind}
						items={kinds}
						onValueChange={(next) =>
							next !== null && onChange({ kind: next as BreakForm['kind'] })
						}
						disabled={disabled}
					>
						<SelectTrigger
							className="h-11 w-full md:h-8"
							aria-label={_(t`Kind of break ${number}`)}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{kinds.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<TextField
					label={<Trans>Start</Trans>}
					type="time"
					step={60}
					dir="ltr"
					value={item.start}
					onChange={(event) => onChange({ start: event.target.value })}
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? `${errorId}` : undefined}
				/>
				<TextField
					label={<Trans>End</Trans>}
					type="time"
					step={60}
					dir="ltr"
					value={item.end}
					onChange={(event) => onChange({ end: event.target.value })}
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? `${errorId}` : undefined}
				/>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-11 justify-self-end md:size-9"
					disabled={disabled}
					aria-label={_(t`Remove break ${number}`)}
					onClick={onRemove}
				>
					<Icon name="trash-2" />
				</Button>
			</div>
			{error ? <FieldError id={errorId}>{error}</FieldError> : null}
		</li>
	)
}
