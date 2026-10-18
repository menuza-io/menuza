import { cn } from '@repo/ui'
import { FieldLabel } from '@repo/ui/field'
import { Switch } from '@repo/ui/switch'
import { type ReactNode, useId } from 'react'

/**
 * `SwitchField` (components/staff/switch-field.tsx) with a `data-testid` on the
 * switch itself, which the reservations tests and e2e flows target.
 */
export function SwitchRow({
	label,
	description,
	checked,
	onCheckedChange,
	disabled,
	className,
	testId,
}: {
	label: ReactNode
	description?: ReactNode
	checked: boolean
	onCheckedChange: (checked: boolean) => void
	disabled?: boolean
	className?: string
	testId?: string
}) {
	const id = useId()
	return (
		<div
			className={cn(
				'flex min-h-11 items-start justify-between gap-4 py-1',
				className,
			)}
		>
			<div className="flex min-w-0 flex-col gap-0.5">
				<FieldLabel
					id={`${id}-label`}
					htmlFor={id}
					className="text-sm font-medium"
				>
					{label}
				</FieldLabel>
				{description ? (
					<p
						id={`${id}-description`}
						className="text-muted-foreground text-sm text-pretty"
					>
						{description}
					</p>
				) : null}
			</div>
			<Switch
				id={id}
				checked={checked}
				onCheckedChange={(next) => onCheckedChange(Boolean(next))}
				disabled={disabled}
				aria-labelledby={`${id}-label`}
				aria-describedby={description ? `${id}-description` : undefined}
				className="mt-0.5"
				data-testid={testId}
			/>
		</div>
	)
}
