import { Icon } from '@repo/ui/icon'
import { type ReactNode } from 'react'

/** The bar above a dashboard grid that names the open dashboard. */
export function DashboardHeader({
	name,
	actions,
}: {
	name: ReactNode
	actions?: ReactNode
}) {
	return (
		<div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
			<div className="flex min-w-0 items-center gap-2 text-sm font-medium">
				<Icon
					name="layout-grid"
					className="text-muted-foreground size-4 shrink-0"
				/>
				<span className="truncate">{name}</span>
			</div>
			{actions}
		</div>
	)
}
