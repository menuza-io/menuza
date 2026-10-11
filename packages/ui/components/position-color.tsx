import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/utils'

/**
 * Categorical colors for staff positions. Keys match `POSITION_COLOR_KEYS`
 * in `@repo/staffing`; stored data holds the key, never a color value.
 */
export const positionSwatchVariants = cva(
	'inline-block shrink-0 rounded-full',
	{
		variants: {
			color: {
				gray: 'bg-gray-500',
				red: 'bg-red-500',
				orange: 'bg-orange-500',
				yellow: 'bg-yellow-500',
				green: 'bg-green-600',
				teal: 'bg-teal-500',
				blue: 'bg-blue-500',
				purple: 'bg-purple-500',
				pink: 'bg-pink-500',
			},
			size: { sm: 'size-2', md: 'size-3' },
		},
		defaultVariants: { color: 'gray', size: 'sm' },
	},
)

/** Tinted surface for a shift block; the border carries the hue for contrast. */
export const positionSurfaceVariants = cva(
	'text-foreground bg-muted/60 border-s-4',
	{
		variants: {
			color: {
				gray: 'border-s-gray-500',
				red: 'border-s-red-500',
				orange: 'border-s-orange-500',
				yellow: 'border-s-yellow-500',
				green: 'border-s-green-600',
				teal: 'border-s-teal-500',
				blue: 'border-s-blue-500',
				purple: 'border-s-purple-500',
				pink: 'border-s-pink-500',
			},
		},
		defaultVariants: { color: 'gray' },
	},
)

export type PositionColor = NonNullable<
	VariantProps<typeof positionSwatchVariants>['color']
>

const KNOWN = new Set<string>([
	'gray',
	'red',
	'orange',
	'yellow',
	'green',
	'teal',
	'blue',
	'purple',
	'pink',
])

export function toPositionColor(
	value: string | null | undefined,
): PositionColor {
	return value && KNOWN.has(value) ? (value as PositionColor) : 'gray'
}

export function PositionSwatch({
	color,
	size,
	className,
}: {
	color: string | null | undefined
	size?: 'sm' | 'md'
	className?: string
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				positionSwatchVariants({ color: toPositionColor(color), size }),
				className,
			)}
		/>
	)
}
