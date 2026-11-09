'use client'

import * as React from 'react'

import {
	formatQuantityText,
	MAX_TYPED_QUANTITY,
	parseQuantityText,
	stepQuantity,
} from '../../lib/quantity-input'
import { cn } from '../../lib/utils'
import { Icon } from '../icon'
import { Button } from './button'
import { Input } from './input'

const QUICK_FRACTIONS = [
	{ value: 0.25, text: '¼' },
	{ value: 0.5, text: '½' },
	{ value: 0.75, text: '¾' },
] as const

export type QuantityStepperProps = {
	/** The amount, or null while the field is empty or not a number. */
	value: number | null
	onValueChange: (value: number | null) => void
	/** How much − and + change the amount (default 1). */
	step?: number
	min?: number
	max?: number
	/** Show the ¼ ½ ¾ quick fractions under the field. */
	fractions?: boolean
	/** Accessible names of the two buttons (the app translates them). */
	decrementLabel: string
	incrementLabel: string
	/** Accessible name of a quick fraction button, e.g. "Add one half". */
	fractionLabel?: (fraction: string) => string
	id?: string
	name?: string
	disabled?: boolean
	invalid?: boolean
	placeholder?: string
	className?: string
	'aria-label'?: string
	'aria-labelledby'?: string
	'aria-describedby'?: string
	'data-testid'?: string
}

/**
 * A number field with − and + buttons for counting by hand: 44px touch
 * targets, and − always on the left of the number, in both text directions
 * (numbers read left to right in Arabic too). Typing accepts Arabic-Indic
 * digits, "٫" and fractions like "1½".
 */
function QuantityStepper({
	value,
	onValueChange,
	step = 1,
	min = 0,
	max = MAX_TYPED_QUANTITY,
	fractions = false,
	decrementLabel,
	incrementLabel,
	fractionLabel,
	id,
	name,
	disabled,
	invalid,
	placeholder,
	className,
	'aria-label': ariaLabel,
	'aria-labelledby': ariaLabelledBy,
	'aria-describedby': ariaDescribedBy,
	'data-testid': testId,
}: QuantityStepperProps) {
	const [text, setText] = React.useState(() => formatQuantityText(value))

	// Follow the value when the parent changes it (buttons, reset), but never
	// rewrite what the person is still typing: "2." parses to 2 and stays.
	React.useEffect(() => {
		setText((current) =>
			parseQuantityText(current) === value
				? current
				: formatQuantityText(value),
		)
	}, [value])

	const commit = (next: number | null) => {
		setText(formatQuantityText(next))
		onValueChange(next)
	}

	const whole = value === null ? 0 : Math.floor(value)
	const fraction =
		value === null ? 0 : Math.round((value - whole) * 1000) / 1000
	const typedBad = text.trim() !== '' && parseQuantityText(text) === null

	return (
		<div
			dir="ltr"
			data-slot="quantity-stepper"
			className={cn('flex w-fit max-w-full flex-col gap-2', className)}
		>
			<div className="flex items-center gap-1">
				<Button
					type="button"
					variant="outline"
					className="size-11 rounded-md"
					aria-label={decrementLabel}
					disabled={disabled || (value ?? 0) <= min}
					onClick={() => commit(stepQuantity(value, -step, { min, max }))}
					data-testid={testId ? `${testId}-decrement` : undefined}
				>
					<Icon name="minus" />
				</Button>
				<Input
					id={id}
					name={name}
					type="text"
					inputMode="decimal"
					autoComplete="off"
					dir="ltr"
					value={text}
					placeholder={placeholder}
					disabled={disabled}
					aria-label={ariaLabel}
					aria-labelledby={ariaLabelledBy}
					aria-describedby={ariaDescribedBy}
					aria-invalid={invalid || typedBad ? true : undefined}
					className="h-11 w-24 text-center tabular-nums md:text-base"
					data-testid={testId}
					onChange={(event) => {
						const typed = event.target.value
						setText(typed)
						const parsed = parseQuantityText(typed)
						onValueChange(parsed === null || parsed > max ? null : parsed)
					}}
					onBlur={() => {
						// Settle what was typed: "1½" becomes 1.5, junk is cleared.
						const parsed = parseQuantityText(text)
						setText(formatQuantityText(parsed === null ? null : parsed))
					}}
				/>
				<Button
					type="button"
					variant="outline"
					className="size-11 rounded-md"
					aria-label={incrementLabel}
					disabled={disabled || (value ?? 0) >= max}
					onClick={() => commit(stepQuantity(value, step, { min, max }))}
					data-testid={testId ? `${testId}-increment` : undefined}
				>
					<Icon name="plus" />
				</Button>
			</div>
			{fractions ? (
				<div className="flex items-center gap-1">
					{QUICK_FRACTIONS.map((quick) => (
						<Button
							key={quick.text}
							type="button"
							variant="outline"
							className="h-11 min-w-11 rounded-md px-2"
							aria-label={
								fractionLabel ? fractionLabel(quick.text) : quick.text
							}
							aria-pressed={fraction === quick.value}
							disabled={disabled || whole + quick.value > max}
							onClick={() =>
								commit(fraction === quick.value ? whole : whole + quick.value)
							}
							data-testid={
								testId ? `${testId}-fraction-${quick.text}` : undefined
							}
						>
							{quick.text}
						</Button>
					))}
				</div>
			) : null}
		</div>
	)
}

export { QuantityStepper }
