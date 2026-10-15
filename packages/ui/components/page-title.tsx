import { type ReactNode } from 'react'
import { cn } from '../lib/utils'

interface PageTitleProps {
	title: ReactNode
	description?: ReactNode
	/** Short line under the title (date, scope, etc.). */
	meta?: ReactNode
	eyebrow?: ReactNode
	headingLevel?: 'h1' | 'h2'
	size?: 'page' | 'section'
	className?: string
}

export function PageTitle({
	title,
	description,
	meta,
	eyebrow,
	headingLevel = 'h1',
	size = 'page',
	className,
}: PageTitleProps) {
	const Heading = headingLevel
	const subtitle = meta ?? description

	return (
		<div className={cn('flex min-w-0 flex-col gap-1', className)}>
			{eyebrow ? (
				<p className="text-muted-foreground text-xs font-medium">{eyebrow}</p>
			) : null}
			<Heading
				className={cn(
					'font-semibold text-balance',
					size === 'page'
						? 'text-[1.4375rem] leading-[1.2] tracking-[-0.022em]'
						: 'text-[0.90625rem] leading-snug tracking-[-0.01em]',
				)}
			>
				{title}
			</Heading>
			{subtitle ? (
				<p className="text-muted-foreground max-w-3xl text-sm leading-snug text-pretty">
					{subtitle}
				</p>
			) : null}
		</div>
	)
}
