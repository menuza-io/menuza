import { type ReactNode } from 'react'

/**
 * The bar above a dashboard grid: what the open dashboard is (the dashboard
 * switcher) on one side, what can be done with it on the other.
 */
export function DashboardHeader({
	title,
	actions,
}: {
	title: ReactNode
	actions?: ReactNode
}) {
	return (
		<div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
			<div className="flex min-w-0 items-center">{title}</div>
			<div className="flex flex-wrap items-center justify-end gap-2">
				{actions}
			</div>
		</div>
	)
}
