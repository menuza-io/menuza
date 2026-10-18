import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { type ReactNode, useId } from 'react'

/**
 * Small pieces shared by the booking sheet, the detail sheet and the walk-in
 * dialog, so the three read the same: a real section heading, a checkbox row
 * with a 44px touch target and a party-size stepper.
 */

export function SectionHeading({
	children,
	description,
	action,
	className,
	id,
}: {
	children: ReactNode
	description?: ReactNode
	action?: ReactNode
	className?: string
	id?: string
}) {
	return (
		<div className={cn('flex items-start justify-between gap-3', className)}>
			<div className="flex min-w-0 flex-col gap-0.5">
				<h3 id={id} className="text-sm leading-5 font-medium">
					{children}
				</h3>
				{description ? (
					<p className="text-muted-foreground text-xs text-pretty">
						{description}
					</p>
				) : null}
			</div>
			{action}
		</div>
	)
}

/** A section on the sheet canvas: heading, then its content, no card chrome. */
export function SheetSection({
	title,
	description,
	action,
	children,
	className,
	testId,
}: {
	title: ReactNode
	description?: ReactNode
	action?: ReactNode
	children: ReactNode
	className?: string
	testId?: string
}) {
	const headingId = useId()
	return (
		<section
			aria-labelledby={headingId}
			data-testid={testId}
			className={cn('flex flex-col gap-3', className)}
		>
			<SectionHeading id={headingId} description={description} action={action}>
				{title}
			</SectionHeading>
			{children}
		</section>
	)
}

/** One explicit yes/no choice: checkbox, label and an optional plain explanation. */
export function CheckRow({
	label,
	description,
	checked,
	onCheckedChange,
	testId,
	disabled,
}: {
	label: ReactNode
	description?: ReactNode
	checked: boolean
	onCheckedChange: (checked: boolean) => void
	testId?: string
	disabled?: boolean
}) {
	const id = useId()
	return (
		<div className="flex min-h-11 items-start gap-3 py-1.5">
			<Checkbox
				id={id}
				checked={checked}
				disabled={disabled}
				onCheckedChange={(next) => onCheckedChange(Boolean(next))}
				data-testid={testId}
				className="mt-0.5"
			/>
			<div className="flex min-w-0 flex-col gap-0.5">
				<FieldLabel htmlFor={id} className="text-sm font-medium">
					{label}
				</FieldLabel>
				{description ? (
					<p className="text-muted-foreground text-xs text-pretty">
						{description}
					</p>
				) : null}
			</div>
		</div>
	)
}

/** Party size with 44px minus and plus targets and a typed number in between. */
export function PartyStepper({
	value,
	onChange,
	min = 1,
	max = 40,
	decreaseLabel,
	increaseLabel,
	inputLabel,
	inputTestId,
	inputId,
}: {
	value: number
	onChange: (value: number) => void
	min?: number
	max?: number
	decreaseLabel: string
	increaseLabel: string
	inputLabel: string
	inputTestId?: string
	inputId?: string
}) {
	return (
		<div className="flex items-center gap-1.5">
			<Button
				type="button"
				variant="outline"
				size="icon"
				className="size-11 md:size-8"
				aria-label={decreaseLabel}
				disabled={value <= min}
				onClick={() => onChange(Math.max(min, value - 1))}
			>
				<Icon name="minus" />
			</Button>
			<Input
				id={inputId}
				type="number"
				inputMode="numeric"
				min={min}
				max={max}
				value={value}
				aria-label={inputLabel}
				data-testid={inputTestId}
				onChange={(event) =>
					onChange(
						Math.min(max, Math.max(min, Number(event.target.value) || min)),
					)
				}
				className="h-11 w-16 text-center tabular-nums md:h-8"
			/>
			<Button
				type="button"
				variant="outline"
				size="icon"
				className="size-11 md:size-8"
				aria-label={increaseLabel}
				disabled={value >= max}
				onClick={() => onChange(Math.min(max, value + 1))}
			>
				<Icon name="plus" />
			</Button>
		</div>
	)
}
