import { type ReactNode } from 'react'

/**
 * The chrome shared by every dashboard block. Block contents draw their own
 * card, so the frame only names the block and makes it fill its grid cell.
 */
export function DashboardBlockFrame({
	title,
	children,
}: {
	title: string
	children: ReactNode
}) {
	return (
		<section aria-label={title} className="flex h-full min-h-0 flex-col">
			<div className="min-h-0 flex-1">{children}</div>
		</section>
	)
}
