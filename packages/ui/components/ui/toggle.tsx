import { Toggle as TogglePrimitive } from '@base-ui/react/toggle'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/utils'

const toggleVariants = cva(
	"hover:text-foreground aria-pressed:bg-muted focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive data-[state=on]:bg-muted group/toggle hover:bg-muted inline-flex items-center justify-center gap-1 rounded-lg text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default: 'bg-transparent',
				outline: 'border-input hover:bg-muted border bg-transparent',
				// Segmented control: use inside `ToggleGroup variant="segmented"`.
				// The group's sliding indicator draws the pressed pill; the item paints
				// its own only until the indicator is measured (sliding-indicator.tsx).
				segmented:
					'text-muted-foreground hover:text-foreground aria-pressed:text-foreground group-not-has-[>[data-slot=sliding-indicator]:not([hidden])]/toggle-group:aria-pressed:bg-card group-not-has-[>[data-slot=sliding-indicator]:not([hidden])]/toggle-group:aria-pressed:shadow-raised dark:group-not-has-[>[data-slot=sliding-indicator]:not([hidden])]/toggle-group:aria-pressed:bg-muted rounded-sm bg-transparent px-2.5 text-xs hover:bg-transparent aria-pressed:bg-transparent',
			},
			size: {
				default: 'h-8 min-w-8 px-2',
				sm: 'h-7 min-w-7 rounded-[min(var(--radius-md),12px)] px-1.5 text-[0.8rem]',
				lg: 'h-9 min-w-9 px-2.5',
			},
		},
		// Sizes set their own padding and radius; a segment keeps its own.
		compoundVariants: [
			{ variant: 'segmented', className: 'rounded-sm px-2.5' },
		],
		defaultVariants: {
			variant: 'default',
			size: 'default',
		},
	},
)

function Toggle({
	className,
	variant = 'default',
	size = 'default',
	...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
	return (
		<TogglePrimitive
			data-slot="toggle"
			className={cn(toggleVariants({ variant, size, className }))}
			{...props}
		/>
	)
}

export { Toggle, toggleVariants }
