/* eslint-disable shadcn/no-arbitrary-values -- sizes mirror the stock TabsTrigger so these read as the same control */
import { cn } from '@repo/ui'
import { tabsListVariants } from '@repo/ui/tabs'
import { NavLink } from 'react-router'

export type SectionTab = { to: string; label: string; end?: boolean }

/**
 * Route-backed tab row for the Staff sections. It wears the same pill styling
 * as the stock `TabsList`, so these pages read like the rest of the app.
 */
export function SectionTabs({
	tabs,
	label,
	className,
}: {
	tabs: readonly SectionTab[]
	label: string
	className?: string
}) {
	return (
		<nav
			aria-label={label}
			className={cn('max-w-full overflow-x-auto print:hidden', className)}
		>
			<div className={cn(tabsListVariants(), 'justify-start')}>
				{tabs.map((tab) => (
					<NavLink
						key={tab.to}
						to={tab.to}
						end={tab.end}
						className={({ isActive }) =>
							cn(
								'focus-visible:ring-ring/50 inline-flex h-[calc(100%-1px)] items-center justify-center rounded-md border border-transparent px-3 py-1 text-[0.9375rem] font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-[3px]',
								isActive
									? 'bg-background text-foreground dark:border-input dark:bg-input/30 shadow-sm'
									: 'text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground',
							)
						}
					>
						{tab.label}
					</NavLink>
				))}
			</div>
		</nav>
	)
}
