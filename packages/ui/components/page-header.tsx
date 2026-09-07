import { type ReactNode } from 'react'
import { cn } from '../lib/utils'
import { PageTitle } from './page-title'

interface PageHeaderProps {
	title: ReactNode
	description?: ReactNode
	actions?: ReactNode
	headingLevel?: 'h1' | 'h2'
	size?: 'page' | 'section'
	className?: string
}

/**
 * Consistent heading and action layout for app pages and nested sections.
 * Actions move below the title on narrow screens to preserve readable wrapping.
 */
export function PageHeader({
	title,
	description,
	actions,
	headingLevel = 'h1',
	size = 'page',
	className,
}: PageHeaderProps) {
	return (
		<div
			className={cn(
				'flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between',
				className,
			)}
		>
			<PageTitle
				title={title}
				description={description}
				headingLevel={headingLevel}
				size={size}
			/>
			{actions ? (
				<div className="flex shrink-0 flex-wrap items-center gap-2">
					{actions}
				</div>
			) : null}
		</div>
	)
}
