import { useInputControl } from '@conform-to/react'
import { cn } from '@repo/ui'
import { Checkbox } from '@repo/ui/checkbox'
import { FieldLabel, FieldError, Field as UIField } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSeparator,
	InputOTPSlot,
} from '@repo/ui/input-otp'
import { Textarea } from '@repo/ui/textarea'
import { REGEXP_ONLY_DIGITS_AND_CHARS, type OTPInputProps } from 'input-otp'
import React, { useId } from 'react'

export type ListOfErrors = Array<string | null | undefined> | null | undefined

// Helper function to convert error arrays to FieldError format
export function convertErrorsToFieldFormat(errors?: ListOfErrors) {
	if (!errors) return undefined
	return errors.filter(Boolean).map((error) => ({ message: error as string }))
}

export function ErrorList({
	id,
	errors,
}: {
	errors?: ListOfErrors
	id?: string
}) {
	const errorsToRender = errors?.filter(Boolean)
	if (!errorsToRender?.length) return null
	return (
		<ul id={id} className="flex flex-col gap-1">
			{errorsToRender.map((e) => (
				<li key={e} className="text-destructive text-[10px]">
					{e}
				</li>
			))}
		</ul>
	)
}

// Legacy Field component - use Field, FieldLabel, FieldError from @repo/ui instead
export function Field({
	labelProps,
	inputProps,
	errors,
	className,
}: {
	labelProps: React.LabelHTMLAttributes<HTMLLabelElement>
	inputProps: React.InputHTMLAttributes<HTMLInputElement>
	errors?: ListOfErrors
	className?: string
}) {
	const fallbackId = useId()
	const id = inputProps.id ?? fallbackId
	const hasErrors = errors?.length ? true : undefined

	return (
		<UIField className={className} data-invalid={hasErrors}>
			<FieldLabel htmlFor={id} {...labelProps} />
			<Input id={id} aria-invalid={hasErrors} {...inputProps} />
			<FieldError errors={convertErrorsToFieldFormat(errors)} />
		</UIField>
	)
}

export function OTPField({
	labelProps,
	inputProps,
	errors,
	className,
}: {
	labelProps: React.LabelHTMLAttributes<HTMLLabelElement>
	inputProps: Partial<OTPInputProps & { render: never }>
	errors?: ListOfErrors
	className?: string
}) {
	const fallbackId = useId()
	const id = inputProps.id ?? fallbackId
	const hasErrors = errors?.length ? true : undefined

	return (
		<UIField className={cn(className, 'w-auto')} data-invalid={hasErrors}>
			<FieldLabel htmlFor={id} {...labelProps} />
			<InputOTP
				pattern={REGEXP_ONLY_DIGITS_AND_CHARS}
				maxLength={6}
				id={id}
				aria-invalid={hasErrors}
				{...inputProps}
			>
				<InputOTPGroup>
					<InputOTPSlot index={0} />
					<InputOTPSlot index={1} />
					<InputOTPSlot index={2} />
				</InputOTPGroup>
				<InputOTPSeparator />
				<InputOTPGroup>
					<InputOTPSlot index={3} />
					<InputOTPSlot index={4} />
					<InputOTPSlot index={5} />
				</InputOTPGroup>
			</InputOTP>
			<FieldError errors={convertErrorsToFieldFormat(errors)} />
		</UIField>
	)
}

export function TextareaField({
	labelProps,
	textareaProps,
	errors,
	className,
}: {
	labelProps: React.LabelHTMLAttributes<HTMLLabelElement>
	textareaProps: React.TextareaHTMLAttributes<HTMLTextAreaElement>
	errors?: ListOfErrors
	className?: string
}) {
	const fallbackId = useId()
	const id = textareaProps.id ?? textareaProps.name ?? fallbackId
	const hasErrors = errors?.length ? true : undefined

	return (
		<UIField className={className} data-invalid={hasErrors}>
			<FieldLabel htmlFor={id} {...labelProps} />
			<Textarea id={id} aria-invalid={hasErrors} {...textareaProps} />
			<FieldError errors={convertErrorsToFieldFormat(errors)} />
		</UIField>
	)
}

export function CheckboxField({
	labelProps,
	buttonProps,
	errors,
	className,
}: {
	labelProps: React.ComponentProps<'label'>
	buttonProps: React.ComponentProps<typeof Checkbox> & {
		name: string
		form: string
		value?: string
		onCheckedChange: (value: boolean) => void
	}
	errors?: ListOfErrors
	className?: string
}) {
	const { key, defaultChecked, ...checkboxProps } = buttonProps
	const fallbackId = useId()
	const checkedValue = buttonProps.value ?? 'on'
	const input = useInputControl({
		key,
		name: buttonProps.name,
		formId: buttonProps.form,
		initialValue: defaultChecked ? checkedValue : undefined,
	})
	const id = buttonProps.id ?? fallbackId
	const hasErrors = errors?.length ? true : undefined

	return (
		<UIField
			className={className}
			orientation="horizontal"
			data-invalid={hasErrors}
		>
			<Checkbox
				{...checkboxProps}
				id={id}
				aria-invalid={hasErrors}
				checked={input.value === checkedValue}
				onCheckedChange={(state) => {
					input.change(state.valueOf() ? checkedValue : '')
					buttonProps.onCheckedChange?.(state)
				}}
				onFocus={(event) => {
					input.focus()
					buttonProps.onFocus?.(event)
				}}
				onBlur={(event) => {
					input.blur()
					buttonProps.onBlur?.(event)
				}}
			/>
			<FieldLabel
				htmlFor={id}
				{...labelProps}
				className="text-muted-foreground self-center text-xs font-normal"
			/>
			<FieldError errors={convertErrorsToFieldFormat(errors)} />
		</UIField>
	)
}
