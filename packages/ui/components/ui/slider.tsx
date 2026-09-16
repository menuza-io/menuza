'use client'

import { Slider as SliderPrimitive } from '@base-ui/react/slider'
import * as React from 'react'

import { cn } from '../../lib/utils'

function Slider<Value extends number | readonly number[] = number>({
	className,
	defaultValue,
	value,
	min = 0,
	max = 100,
	variant = 'default',
	'aria-label': ariaLabel,
	...props
}: SliderPrimitive.Root.Props<Value> & {
	variant?: 'default' | 'pill'
	'aria-label'?: string
}) {
	const _values = React.useMemo(() => {
		if (Array.isArray(value)) return value
		if (typeof value === 'number') return [value]
		if (Array.isArray(defaultValue)) return defaultValue
		if (typeof defaultValue === 'number') return [defaultValue]
		return [min]
	}, [value, defaultValue, min])

	return (
		<SliderPrimitive.Root
			className={cn(
				'data-horizontal:w-full data-vertical:h-full',
				variant === 'pill' && 'touch-none',
			)}
			data-slot="slider"
			data-variant={variant}
			defaultValue={defaultValue}
			value={value}
			min={min}
			max={max}
			thumbAlignment={variant === 'pill' ? 'center' : 'edge'}
			aria-label={ariaLabel}
			{...props}
		>
			<SliderPrimitive.Control
				className={cn(
					'relative flex w-full touch-none items-center select-none data-disabled:opacity-50',
					variant === 'pill'
						? 'h-8 cursor-pointer'
						: 'data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col',
					className,
				)}
			>
				<SliderPrimitive.Track
					data-slot="slider-track"
					data-variant={variant}
					className={cn(
						'relative select-none',
						variant === 'pill'
							? 'border-border/80 bg-muted/60 flex h-8 w-full items-center overflow-hidden rounded-full border'
							: 'bg-muted relative overflow-hidden rounded-full data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1',
					)}
				>
					<SliderPrimitive.Indicator
						data-slot="slider-range"
						data-variant={variant}
						className={cn(
							'select-none',
							variant === 'pill'
								? 'bg-background dark:bg-muted relative flex h-full items-center justify-end overflow-hidden rounded-r-full shadow-xs'
								: 'bg-primary data-horizontal:h-full data-vertical:w-full',
						)}
					>
						{variant === 'pill' && (
							<span
								aria-hidden="true"
								className="bg-muted-foreground/40 pointer-events-none absolute top-1/2 right-3.5 h-3.5 w-0.5 -translate-y-1/2 rounded-full select-none"
							/>
						)}
					</SliderPrimitive.Indicator>
				</SliderPrimitive.Track>
				{Array.from({ length: _values.length }, (_, index) => (
					<SliderPrimitive.Thumb
						data-slot="slider-thumb"
						data-variant={variant}
						key={index}
						index={_values.length > 1 ? index : undefined}
						aria-label={
							_values.length > 1 && ariaLabel
								? `${ariaLabel} ${index + 1}`
								: ariaLabel
						}
						className={cn(
							variant === 'pill'
								? 'focus-visible:ring-ring size-8 cursor-pointer rounded-full opacity-0 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50'
								: 'border-ring ring-ring/50 relative block size-3 shrink-0 rounded-full border bg-white transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-[3px] focus-visible:ring-[3px] focus-visible:outline-hidden active:ring-[3px] disabled:pointer-events-none disabled:opacity-50',
						)}
					/>
				))}
			</SliderPrimitive.Control>
		</SliderPrimitive.Root>
	)
}

export { Slider }
