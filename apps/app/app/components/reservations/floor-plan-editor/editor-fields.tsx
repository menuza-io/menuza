import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import { Field, FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { type ReactNode } from 'react'

/** Compact numeric input used by the floor-plan inspector (geometry fields). */
export function NumberField({
	label,
	value,
	onValueChange,
	min,
	max,
	step,
	disabled,
	testId,
	id,
	className,
}: {
	label: ReactNode
	value: number
	onValueChange: (value: number) => void
	min: number
	max: number
	step?: number
	disabled?: boolean
	testId?: string
	id: string
	className?: string
}) {
	return (
		<Field className={className}>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Input
				id={id}
				type="number"
				min={min}
				max={max}
				step={step}
				disabled={disabled}
				value={value}
				onChange={(e) => onValueChange(Number(e.target.value))}
				data-testid={testId}
			/>
		</Field>
	)
}

/** Quarter-turn presets (and an optional free value) for rotation. */
export function RotationPresets({
	value,
	presets,
	disabled,
	onPick,
	children,
}: {
	value: number
	presets: readonly number[]
	disabled?: boolean
	onPick: (degrees: number) => void
	children?: ReactNode
}) {
	return (
		<Field>
			<FieldLabel>
				<Trans>Rotation (degrees)</Trans>
			</FieldLabel>
			<div className="flex flex-wrap items-center gap-1.5">
				{presets.map((deg) => (
					<Button
						key={deg}
						type="button"
						size="sm"
						variant={value === deg ? 'secondary' : 'outline'}
						aria-pressed={value === deg}
						disabled={disabled}
						onClick={() => onPick(deg)}
					>
						{deg}°
					</Button>
				))}
				{children}
			</div>
		</Field>
	)
}
