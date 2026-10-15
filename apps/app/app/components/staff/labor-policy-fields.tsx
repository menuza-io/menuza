import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type LaborPolicyFields } from '@repo/staffing'
import { cn } from '@repo/ui'
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import {
	bpToMultiplierText as bpLabel,
	hoursTextToMinutes as hoursLabelToMinutes,
	minutesToHoursText as minutesToHoursLabel,
	multiplierTextToBp as labelToBp,
} from '#app/utils/staffing/labor-policy-form.ts'

type ThresholdRule = NonNullable<LaborPolicyFields['weeklyOvertime']>

/**
 * Small, single-purpose inputs for the labor rules screen. Each keeps what the
 * person is typing as text (so "1." and "" are allowed mid-edit) and only
 * reports a value when the text is a valid number; the screen's validation
 * explains anything that does not fit together.
 */

/** A number the person types, shown with a unit after it ("min", "hours"). */
export function UnitField({
	label,
	hint,
	error,
	value,
	onValueChange,
	toText,
	fromText,
	unit,
	inputMode = 'decimal',
	className,
	id,
}: {
	label: ReactNode
	hint?: ReactNode
	error?: string | null
	value: number
	onValueChange: (next: number) => void
	toText: (value: number) => string
	fromText: (text: string) => number | null
	unit: ReactNode
	inputMode?: 'decimal' | 'numeric'
	className?: string
	id?: string
}) {
	const generated = useId()
	const fieldId = id ?? generated
	const [text, setText] = useState(() => toText(value))
	const [invalid, setInvalid] = useState(false)

	// Follow outside changes (a preset, a discard) without fighting the typist.
	useEffect(() => {
		setText((current) => {
			const parsed = fromText(current)
			return parsed === value ? current : toText(value)
		})
		setInvalid(false)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [value])

	const describedBy =
		[hint ? `${fieldId}-hint` : null, error ? `${fieldId}-error` : null]
			.filter(Boolean)
			.join(' ') || undefined
	const showError = error ?? null
	return (
		<Field
			className={cn('w-auto', className)}
			data-invalid={showError || invalid ? true : undefined}
		>
			<FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
			<div className="flex items-center gap-2">
				<Input
					id={fieldId}
					inputMode={inputMode}
					dir="ltr"
					value={text}
					aria-invalid={showError || invalid ? true : undefined}
					aria-describedby={describedBy}
					className="h-11 max-w-28 text-end tabular-nums md:h-8"
					onChange={(event) => {
						const next = event.target.value
						setText(next)
						const parsed = fromText(next)
						setInvalid(parsed === null)
						if (parsed !== null) onValueChange(parsed)
					}}
					onBlur={() => {
						if (fromText(text) === null) {
							setText(toText(value))
							setInvalid(false)
						}
					}}
				/>
				<span className="text-muted-foreground text-sm">{unit}</span>
			</div>
			{hint ? (
				<FieldDescription id={`${fieldId}-hint`}>{hint}</FieldDescription>
			) : null}
			{showError ? (
				<FieldError id={`${fieldId}-error`}>{showError}</FieldError>
			) : invalid ? (
				<FieldError id={`${fieldId}-error`}>
					<Trans>Enter a number.</Trans>
				</FieldError>
			) : null}
		</Field>
	)
}

/**
 * A number typed inside a sentence ("take [30] minutes off"). Same text-first
 * behaviour as `UnitField`, without a visible label: the sentence reads as the
 * label, and `label` names it for screen readers.
 */
export function InlineNumber({
	label,
	value,
	onValueChange,
	toText,
	fromText,
	inputMode = 'decimal',
	error,
	disabled,
}: {
	label: string
	value: number
	onValueChange: (next: number) => void
	toText: (value: number) => string
	fromText: (text: string) => number | null
	inputMode?: 'decimal' | 'numeric'
	error?: string | null
	disabled?: boolean
}) {
	const [text, setText] = useState(() => toText(value))
	const [invalid, setInvalid] = useState(false)
	useEffect(() => {
		setText((current) => {
			const parsed = fromText(current)
			return parsed === value ? current : toText(value)
		})
		setInvalid(false)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [value])
	return (
		<Input
			aria-label={label}
			inputMode={inputMode}
			dir="ltr"
			value={text}
			disabled={disabled}
			aria-invalid={error || invalid ? true : undefined}
			className="w-24 text-center tabular-nums"
			onChange={(event) => {
				const next = event.target.value
				setText(next)
				const parsed = fromText(next)
				setInvalid(parsed === null)
				if (parsed !== null) onValueChange(parsed)
			}}
			onBlur={() => {
				if (fromText(text) === null) {
					setText(toText(value))
					setInvalid(false)
				}
			}}
		/>
	)
}

/** Whole minutes. */
export function MinutesField(
	props: Omit<
		Parameters<typeof UnitField>[0],
		'toText' | 'fromText' | 'unit' | 'inputMode'
	> & { min?: number; max?: number },
) {
	const { min = 0, max = 24 * 60, ...rest } = props
	return (
		<UnitField
			{...rest}
			inputMode="numeric"
			toText={(minutes) => String(minutes)}
			fromText={(text) => {
				if (!/^\d{1,5}$/.test(text.trim())) return null
				const minutes = Number(text)
				return minutes >= min && minutes <= max ? minutes : null
			}}
			unit={<Trans>minutes</Trans>}
		/>
	)
}

/** A setting that can be off: a switch, and the details only when it is on. */
export function OptionalSetting({
	label,
	description,
	enabled,
	onEnabledChange,
	children,
	error,
}: {
	label: ReactNode
	description?: ReactNode
	enabled: boolean
	onEnabledChange: (enabled: boolean) => void
	children?: ReactNode
	error?: string | null
}) {
	return (
		<div className="flex flex-col gap-2">
			<SwitchField
				label={label}
				description={description}
				checked={enabled}
				onCheckedChange={onEnabledChange}
			/>
			{enabled && children ? (
				<div className="ps-0 sm:ps-4">{children}</div>
			) : null}
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
		</div>
	)
}

export function ThresholdFields({
	rule,
	onChange,
	thresholdLabel,
	multiplierLabel,
	thresholdError,
	idPrefix,
}: {
	rule: ThresholdRule
	onChange: (rule: ThresholdRule) => void
	thresholdLabel: ReactNode
	multiplierLabel: ReactNode
	thresholdError?: string | null
	idPrefix: string
}) {
	return (
		<div className="flex flex-wrap items-start gap-x-6 gap-y-3">
			<UnitField
				id={`${idPrefix}-threshold`}
				label={thresholdLabel}
				value={rule.thresholdMinutes}
				onValueChange={(thresholdMinutes) =>
					onChange({ ...rule, thresholdMinutes })
				}
				toText={minutesToHoursLabel}
				fromText={hoursLabelToMinutes}
				unit={<Trans>hours</Trans>}
				error={thresholdError}
			/>
			<UnitField
				id={`${idPrefix}-multiplier`}
				label={multiplierLabel}
				value={rule.multiplierBp}
				onValueChange={(multiplierBp) => onChange({ ...rule, multiplierBp })}
				toText={bpLabel}
				fromText={labelToBp}
				unit={<span aria-hidden="true">×</span>}
				hint={<Trans>1.5 means time and a half.</Trans>}
			/>
		</div>
	)
}

/** A labelled group of related settings inside one section. */
export function SettingGroup({
	title,
	children,
}: {
	title?: ReactNode
	children: ReactNode
}) {
	return (
		<div className="flex flex-col gap-4">
			{title ? <h3 className="text-sm font-medium">{title}</h3> : null}
			{children}
		</div>
	)
}

/** Week days named in the viewer's language, Sunday first (value 0). */
export function useWeekdayOptions() {
	const { i18n } = useLingui()
	const formatter = new Intl.DateTimeFormat(i18n.locale, {
		weekday: 'long',
		timeZone: 'UTC',
	})
	// 2026-01-04 is a Sunday; offset it per day.
	return Array.from({ length: 7 }, (_, day) => ({
		value: String(day),
		label: formatter.format(new Date(Date.UTC(2026, 0, 4 + day, 12))),
	}))
}

export function useRoundingOptions() {
	const { _ } = useLingui()
	return [
		{ value: 'none', label: _(t`Exact time (no rounding)`) },
		{ value: 'nearest', label: _(t`To the nearest`) },
		{ value: 'up', label: _(t`Up`) },
		{ value: 'down', label: _(t`Down`) },
	]
}
