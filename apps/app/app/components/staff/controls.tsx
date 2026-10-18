import { Trans } from '@lingui/macro'
import { cn } from '@repo/ui'
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Textarea } from '@repo/ui/textarea'
import { type ComponentProps, type ReactNode, useId } from 'react'

/**
 * Form controls for the Staff module. Every control has a visible label, an
 * optional hint and an inline error wired with `aria-describedby`, and is 44px
 * tall on touch widths (the stock size from `md` up).
 */

type BaseFieldProps = {
	label: ReactNode
	hint?: ReactNode
	error?: string | null
	optional?: boolean
	className?: string
}

export function TextField({
	label,
	hint,
	error,
	optional,
	className,
	id,
	...input
}: BaseFieldProps & Omit<ComponentProps<typeof Input>, 'className'>) {
	const generated = useId()
	const fieldId = id ?? generated
	const describedBy =
		[hint ? `${fieldId}-hint` : null, error ? `${fieldId}-error` : null]
			.filter(Boolean)
			.join(' ') || undefined
	return (
		<Field className={className} data-invalid={error ? true : undefined}>
			<FieldLabel htmlFor={fieldId}>
				{label}
				{optional ? (
					<span className="text-muted-foreground font-normal">
						<Trans>(optional)</Trans>
					</span>
				) : null}
			</FieldLabel>
			<Input
				id={fieldId}
				aria-invalid={error ? true : undefined}
				aria-describedby={describedBy}

				{...input}
			/>
			{hint ? (
				<FieldDescription id={`${fieldId}-hint`}>{hint}</FieldDescription>
			) : null}
			{error ? <FieldError id={`${fieldId}-error`}>{error}</FieldError> : null}
		</Field>
	)
}

export function TextAreaField({
	label,
	hint,
	error,
	optional,
	className,
	id,
	...input
}: BaseFieldProps & Omit<ComponentProps<typeof Textarea>, 'className'>) {
	const generated = useId()
	const fieldId = id ?? generated
	const describedBy =
		[hint ? `${fieldId}-hint` : null, error ? `${fieldId}-error` : null]
			.filter(Boolean)
			.join(' ') || undefined
	return (
		<Field className={className} data-invalid={error ? true : undefined}>
			<FieldLabel htmlFor={fieldId}>
				{label}
				{optional ? (
					<span className="text-muted-foreground font-normal">
						<Trans>(optional)</Trans>
					</span>
				) : null}
			</FieldLabel>
			<Textarea
				id={fieldId}
				aria-invalid={error ? true : undefined}
				aria-describedby={describedBy}
				{...input}
			/>
			{hint ? (
				<FieldDescription id={`${fieldId}-hint`}>{hint}</FieldDescription>
			) : null}
			{error ? <FieldError id={`${fieldId}-error`}>{error}</FieldError> : null}
		</Field>
	)
}

export type Option = { value: string; label: string }

export function SelectField({
	label,
	hint,
	error,
	optional,
	className,
	options,
	value,
	onValueChange,
	placeholder,
	disabled,
	id,
	testId,
}: BaseFieldProps & {
	testId?: string
	options: readonly Option[]
	value: string
	onValueChange: (value: string) => void
	placeholder?: string
	disabled?: boolean
	id?: string
}) {
	const generated = useId()
	const fieldId = id ?? generated
	const describedBy =
		[hint ? `${fieldId}-hint` : null, error ? `${fieldId}-error` : null]
			.filter(Boolean)
			.join(' ') || undefined
	return (
		<Field className={className} data-invalid={error ? true : undefined}>
			<FieldLabel htmlFor={fieldId}>
				{label}
				{optional ? (
					<span className="text-muted-foreground font-normal">
						<Trans>(optional)</Trans>
					</span>
				) : null}
			</FieldLabel>
			<Select
				value={value}
				items={options as Option[]}
				onValueChange={(next) => next !== null && onValueChange(next)}
				disabled={disabled}
			>
				<SelectTrigger
					id={fieldId}
					data-testid={testId}
					className="h-11 w-full md:h-8"
					aria-invalid={error ? true : undefined}
					aria-describedby={describedBy}
				>
					<SelectValue placeholder={placeholder} />
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{hint ? (
				<FieldDescription id={`${fieldId}-hint`}>{hint}</FieldDescription>
			) : null}
			{error ? <FieldError id={`${fieldId}-error`}>{error}</FieldError> : null}
		</Field>
	)
}

/** A compact select for toolbars: no label above it, so it carries `aria-label`. */
export function FilterSelect({
	label,
	options,
	value,
	onValueChange,
	className,
	id,
	testId,
}: {
	label: string
	options: readonly Option[]
	value: string
	onValueChange: (value: string) => void
	className?: string
	id?: string
	testId?: string
}) {
	return (
		<Select
			value={value}
			items={options as Option[]}
			onValueChange={(next) => next !== null && onValueChange(next)}
		>
			<SelectTrigger
				id={id}
				data-testid={testId}
				aria-label={label}
				className={cn('h-11 w-full md:h-8 md:w-auto md:min-w-36', className)}
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}
