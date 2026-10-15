import { cn } from '../../lib/utils'

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
	return (
		<kbd
			data-slot="kbd"
			className={cn(
				"bg-card text-muted-foreground border-border [[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background dark:[[data-slot=tooltip-content]_&]:bg-background/10 text-2xs pointer-events-none inline-flex h-4.5 w-fit min-w-4.5 items-center justify-center gap-1 rounded-xs border border-b-[1.5px] px-1 font-mono leading-none select-none [&_svg:not([class*='size-'])]:size-3 [[data-slot=tooltip-content]_&]:border-transparent",
				className,
			)}
			{...props}
		/>
	)
}

function KbdGroup({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<kbd
			data-slot="kbd-group"
			className={cn('inline-flex items-center gap-1', className)}
			{...props}
		/>
	)
}

export { Kbd, KbdGroup }
