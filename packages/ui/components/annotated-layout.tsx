import { type ReactNode } from 'react'
import { cn } from '../lib/utils'

interface AnnotatedLayoutProps {
	children: ReactNode
	className?: string
}

/**
 * Vertical stack of settings sections with deliberate section rhythm.
 * Use generous gap between peer sections; put danger/destructive blocks last.
 */
export function AnnotatedLayout({ children, className }: AnnotatedLayoutProps) {
	return (
		<div className={cn('flex flex-col gap-8 md:gap-10', className)}>
			{children}
		</div>
	)
}

interface AnnotatedSectionProps {
	className?: string
	children: ReactNode
	/** Optional left-rail title (Shopify-style annotated settings). */
	title?: ReactNode
	/** Optional left-rail description. */
	description?: ReactNode
	/** Custom annotation node; wins over title/description when provided. */
	annotation?: ReactNode
}

/**
 * One settings section.
 * - With annotation/title: label rail + control surface (1/3 + 2/3 at lg).
 * - Content-only: full-width — for cards that already carry their own headers.
 */
export function AnnotatedSection({
	className,
	children,
	title,
	description,
	annotation,
}: AnnotatedSectionProps) {
	const side =
		annotation ??
		(title || description ? (
			<div className="flex flex-col gap-1">
				{title ? <h2 className="text-base tracking-tight">{title}</h2> : null}
				{description ? (
					<p className="text-muted-foreground text-sm text-pretty">
						{description}
					</p>
				) : null}
			</div>
		) : null)

	if (side) {
		return (
			<section
				className={cn(
					'grid grid-cols-1 items-start gap-x-8 gap-y-4 lg:grid-cols-3',
					className,
				)}
			>
				<div className="min-w-0 lg:sticky lg:top-6 lg:pr-2">{side}</div>
				<div className="min-w-0 lg:col-span-2">{children}</div>
			</section>
		)
	}

	return <section className={cn('min-w-0', className)}>{children}</section>
}
