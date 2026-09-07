import { type ReactNode } from 'react'
import { cn } from '../lib/utils'

interface PageTitleProps {
	title: ReactNode
	description?: ReactNode
	headingLevel?: 'h1' | 'h2'
	size?: 'page' | 'section'
	className?: string
}

export function PageTitle({
	title,
	description,
	headingLevel = 'h1',
	size = 'page',
	className,
}: PageTitleProps) {
	const Heading = headingLevel

	return (
		<div className={cn('flex min-w-0 flex-col gap-1', className)}>
			<Heading
				className={cn(
					'font-semibold tracking-tight text-balance',
					size === 'page' ? 'text-2xl' : 'text-xl',
				)}
			>
				{title}
			</Heading>
			{description && (
				<p className="text-muted-foreground max-w-3xl text-sm text-pretty">
					{description}
				</p>
			)}
		</div>
	)
}
