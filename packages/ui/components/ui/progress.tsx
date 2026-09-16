'use client'

import { Progress as ProgressPrimitive } from '@base-ui/react/progress'

import { cn } from '../../lib/utils'

function Progress({
	className,
	children,
	value,
	variant = 'default',
	...props
}: ProgressPrimitive.Root.Props & {
	variant?: 'default' | 'pill'
}) {
	return (
		<ProgressPrimitive.Root
			value={value}
			data-slot="progress"
			data-variant={variant}
			className={cn('flex flex-wrap gap-3', className)}
			{...props}
		>
			{children}
			<ProgressTrack variant={variant}>
				<ProgressIndicator variant={variant} />
			</ProgressTrack>
		</ProgressPrimitive.Root>
	)
}

function ProgressTrack({
	className,
	variant = 'default',
	...props
}: ProgressPrimitive.Track.Props & {
	variant?: 'default' | 'pill'
}) {
	return (
		<ProgressPrimitive.Track
			className={cn(
				'relative flex items-center',
				variant === 'pill'
					? 'border-border/80 bg-muted/60 h-8 w-full overflow-hidden rounded-full border select-none'
					: 'bg-muted h-1 w-full overflow-x-hidden rounded-full',
				className,
			)}
			data-slot="progress-track"
			data-variant={variant}
			{...props}
		/>
	)
}

function ProgressIndicator({
	className,
	variant = 'default',
	children,
	...props
}: ProgressPrimitive.Indicator.Props & {
	variant?: 'default' | 'pill'
}) {
	return (
		<ProgressPrimitive.Indicator
			data-slot="progress-indicator"
			data-variant={variant}
			className={cn(
				'transition-[width] duration-300 ease-out motion-reduce:transition-none',
				variant === 'pill'
					? 'bg-background dark:bg-muted relative flex h-full items-center justify-end overflow-hidden rounded-r-full shadow-xs'
					: 'bg-primary h-full duration-500',
				className,
			)}
			{...props}
		>
			{children ??
				(variant === 'pill' ? (
					<span
						aria-hidden="true"
						className="bg-muted-foreground/40 pointer-events-none absolute top-1/2 right-3.5 h-3.5 w-0.5 -translate-y-1/2 rounded-full select-none"
					/>
				) : null)}
		</ProgressPrimitive.Indicator>
	)
}

function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
	return (
		<ProgressPrimitive.Label
			className={cn('text-sm font-medium', className)}
			data-slot="progress-label"
			{...props}
		/>
	)
}

function ProgressValue({ className, ...props }: ProgressPrimitive.Value.Props) {
	return (
		<ProgressPrimitive.Value
			className={cn(
				'text-muted-foreground ml-auto text-sm tabular-nums',
				className,
			)}
			data-slot="progress-value"
			{...props}
		/>
	)
}

export {
	Progress,
	ProgressTrack,
	ProgressIndicator,
	ProgressLabel,
	ProgressValue,
}
