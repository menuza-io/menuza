import { type ReactNode } from 'react'

/**
 * The bar above a dashboard grid: what the open dashboard is (the dashboard
 * switcher) on one side, what can be done with it on the other.
 */
export function DashboardHeader({
	title,
	actions,
}: {
	title?: ReactNode
	actions?: ReactNode
}) {
	if (!title && !actions) return null

	return (
		<div
			className={
				title
					? 'mb-3 flex min-h-9 flex-wrap items-center justify-between gap-2'
					: 'mb-3 flex min-h-9 flex-wrap items-center justify-end gap-2'
			}
		>
			{title ? <div className="flex min-w-0 items-center">{title}</div> : null}
			{actions ? (
				<div className="flex flex-wrap items-center justify-end gap-1.5">
					{actions}
				</div>
			) : null}
		</div>
	)
}
