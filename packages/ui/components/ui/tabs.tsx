'use client'

import { Tabs as TabsPrimitive } from '@base-ui/react/tabs'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/utils'
import { slidingIndicatorVariants } from './sliding-indicator'

function Tabs({
	className,
	orientation = 'horizontal',
	...props
}: TabsPrimitive.Root.Props) {
	return (
		<TabsPrimitive.Root
			data-slot="tabs"
			data-orientation={orientation}
			className={cn(
				'group/tabs flex gap-2 data-[orientation=horizontal]:flex-col',
				className,
			)}
			{...props}
		/>
	)
}

const tabsListVariants = cva(
	'group/tabs-list text-muted-foreground relative isolate inline-flex w-fit items-center justify-center gap-0.5 rounded-md p-0.5 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none data-[variant=line]:p-0',
	{
		variants: {
			variant: {
				default: 'bg-accent',
				line: 'gap-0.5 bg-transparent',
			},
		},
		defaultVariants: {
			variant: 'default',
		},
	},
)

function TabsList({
	className,
	variant = 'default',
	children,
	...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
	return (
		<TabsPrimitive.List
			data-slot="tabs-list"
			data-variant={variant}
			className={cn(tabsListVariants({ variant }), className)}
			{...props}
		>
			{children}
			{/* Base UI measures the active tab into --active-tab-* and keeps the
			    indicator hidden until then; see sliding-indicator.tsx. */}
			<TabsPrimitive.Indicator
				data-slot="sliding-indicator"
				className={slidingIndicatorVariants({
					variant: variant === 'line' ? 'line' : 'pill',
				})}
			/>
		</TabsPrimitive.List>
	)
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
	return (
		<TabsPrimitive.Tab
			data-slot="tabs-trigger"
			className={cn(
				"focus-visible:border-ring focus-visible:ring-ring focus-visible:outline-ring text-muted-foreground hover:text-foreground relative inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-sm border border-transparent px-2.5 text-xs font-medium whitespace-nowrap transition-[color,background-color,box-shadow] duration-150 group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start group-data-[variant=line]/tabs-list:px-2.5 group-data-[variant=line]/tabs-list:text-[13px] focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				'data-active:text-foreground',
				// While the indicator is hidden (not measured yet) the active tab
				// paints its own pill or underline; see sliding-indicator.tsx.
				'group-data-[variant=default]/tabs-list:group-not-has-[>[data-slot=sliding-indicator]:not([hidden])]/tabs-list:data-active:bg-card group-data-[variant=default]/tabs-list:group-not-has-[>[data-slot=sliding-indicator]:not([hidden])]/tabs-list:data-active:shadow-raised dark:group-data-[variant=default]/tabs-list:group-not-has-[>[data-slot=sliding-indicator]:not([hidden])]/tabs-list:data-active:bg-muted',
				'after:bg-foreground after:absolute after:rounded-full after:opacity-0 group-data-[orientation=horizontal]/tabs:after:inset-x-2 group-data-[orientation=horizontal]/tabs:after:bottom-0 group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:group-not-has-[>[data-slot=sliding-indicator]:not([hidden])]/tabs-list:data-active:after:opacity-100',
				className,
			)}
			{...props}
		/>
	)
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
	return (
		<TabsPrimitive.Panel
			data-slot="tabs-content"
			className={cn(
				// Base UI marks a panel with data-starting-style only when it opens
				// after a tab change, so the first render does not animate. The
				// outgoing panel stays mounted until its transitions finish; hide it
				// at once so two panels never stack during a quick switch.
				'ease-out-quint flex-1 text-sm transition-[opacity,translate] duration-200 outline-none data-ending-style:hidden data-starting-style:translate-y-1 data-starting-style:opacity-0 motion-reduce:data-starting-style:translate-y-0',
				className,
			)}
			{...props}
		/>
	)
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
