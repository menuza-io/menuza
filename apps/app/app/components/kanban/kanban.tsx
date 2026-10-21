import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Icon } from '@repo/ui/icon'
import { useId, type ReactNode } from 'react'

/**
 * The shared look of a board column and its cards, taken from the Hiring
 * applicants board (`components/hiring/applicant-board.tsx`) so every kanban in
 * the app reads the same: a tinted column with a small title and a count
 * badge, white cards with a hairline border and `shadow-card`, `gap-2`
 * between cards, and a dashed placeholder for an empty column.
 *
 * Presentational only: no drag and drop, no data. The caller owns behavior.
 */
export function KanbanColumn({
	title,
	count,
	headerAction,
	collapsed = false,
	empty,
	footer,
	className,
	testId,
	countTestId,
	titleTestId,
	children,
}: {
	title: ReactNode
	/** Shown in a secondary badge; leave out when the title carries the count. */
	count?: number
	/** A small control at the end of the header, in place of the badge. */
	headerAction?: ReactNode
	/** Header only, no list (a slim strip). */
	collapsed?: boolean
	/** Dashed placeholder, drawn when there are no children. */
	empty?: ReactNode
	/** Below the list, e.g. a link to the full screen. */
	footer?: ReactNode
	className?: string
	testId?: string
	countTestId?: string
	titleTestId?: string
	children?: ReactNode
}) {
	const headingId = useId()
	const hasCards = Array.isArray(children)
		? children.length > 0
		: Boolean(children)
	return (
		<section
			aria-labelledby={headingId}
			className={cn(
				'bg-muted/30 flex min-w-0 flex-col gap-2 rounded-lg p-2 shadow-xs',
				className,
			)}
			data-testid={testId}
		>
			<h3
				id={headingId}
				className="flex min-h-6 items-center justify-between gap-2 px-1 pt-1 text-sm"
			>
				<span data-testid={titleTestId}>{title}</span>
				{headerAction ??
					(count === undefined ? null : (
						<Badge
							variant="secondary"
							className="tabular-nums"
							data-testid={countTestId}
						>
							{count}
						</Badge>
					))}
			</h3>
			{collapsed ? null : (
				<div role="list" className="flex min-h-24 flex-1 flex-col gap-2 p-1">
					{hasCards ? (
						children
					) : empty ? (
						<KanbanEmpty>{empty}</KanbanEmpty>
					) : null}
				</div>
			)}
			{collapsed ? null : footer}
		</section>
	)
}

export function KanbanEmpty({
	children,
	icon,
	testId,
}: {
	children: ReactNode
	icon?: 'calendar' | 'users' | 'check'
	testId?: string
}) {
	return (
		<div
			className="text-muted-foreground border-muted-foreground/30 flex flex-1 flex-col items-center justify-center gap-1.5 rounded-md border-2 border-dashed px-2 py-6 text-center text-xs"
			data-testid={testId}
		>
			{icon ? <Icon name={icon} className="size-4" /> : null}
			{children}
		</div>
	)
}

export function KanbanCard({
	className,
	children,
	testId,
	muted = false,
}: {
	className?: string
	children: ReactNode
	testId?: string
	/** A finished card sits back a little. */
	muted?: boolean
}) {
	return (
		<div role="listitem" className="min-w-0">
			<div
				className={cn(
					'bg-card shadow-card hover:border-border-strong flex min-w-0 flex-col gap-2 rounded-lg border p-3 transition-[border-color,box-shadow] duration-150 hover:shadow-xs',
					muted && 'bg-card/60',
					className,
				)}
				data-testid={testId}
			>
				{children}
			</div>
		</div>
	)
}
