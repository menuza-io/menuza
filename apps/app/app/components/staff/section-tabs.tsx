import { cn } from '@repo/ui'
import { WorkspaceTabBar } from '@repo/ui/workspace'
import { matchPath, useLocation } from 'react-router'

export type SectionTab = { to: string; label: string; end?: boolean }

/**
 * Route-backed tab row for the Staff sections. It is the shared workspace tab
 * bar, so Staff sections read like every other sectioned page (e.g. Website).
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
	const { pathname } = useLocation()
	return (
		<WorkspaceTabBar
			label={label}
			className={cn('print:hidden', className)}
			tabs={tabs.map((tab) => ({
				label: tab.label,
				href: tab.to,
				isActive:
					matchPath({ path: tab.to, end: tab.end ?? false }, pathname) !== null,
			}))}
		/>
	)
}
