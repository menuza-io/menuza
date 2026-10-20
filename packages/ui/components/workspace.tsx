import { type ReactNode } from 'react'
import { Link } from 'react-router'

import { cn } from '../lib/utils'

/** Standard app page width and vertical rhythm (Gr8r-style workspace canvas). */
export function WorkspacePage({
	className,
	children,
}: {
	className?: string
	children: ReactNode
}) {
	return (
		<div
			data-workspace-page
			className={cn(
				'mx-auto flex w-full max-w-[72.5rem] flex-col gap-6 py-5 md:px-6 md:pt-7 md:pb-16',
				className,
			)}
		>
			{children}
		</div>
	)
}

/** The hour (0-23) of `date` in `timeZone`, so server and browser agree. */
export function getWorkspaceHour(date: Date, timeZone?: string): number {
	const hour = new Intl.DateTimeFormat('en-US', {
		hour: 'numeric',
		hourCycle: 'h23',
		timeZone,
	}).format(date)
	return Number(hour) % 24
}

export function getWorkspaceGreeting(
	hour: number,
): 'morning' | 'afternoon' | 'evening' {
	if (hour < 12) return 'morning'
	if (hour < 17) return 'afternoon'
	return 'evening'
}

/**
 * Pass the request locale and the client-hint time zone: defaults that differ
 * between server and browser cause a hydration mismatch.
 */
export function formatWorkspaceDate(
	date: Date,
	{ locale, timeZone }: { locale: string; timeZone?: string },
): string {
	return date.toLocaleDateString(locale, {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		timeZone,
	})
}

export function WorkspaceHero({
	title,
	meta,
	actions,
	className,
}: {
	title: ReactNode
	meta?: ReactNode
	actions?: ReactNode
	className?: string
}) {
	return (
		<header
			className={cn(
				'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between',
				className,
			)}
		>
			<div className="flex min-w-0 flex-col gap-1">
				<h1 className="text-[1.4375rem] leading-[1.2] font-semibold tracking-[-0.022em] text-balance">
					{title}
				</h1>
				{meta ? (
					<p className="text-muted-foreground text-sm leading-snug">{meta}</p>
				) : null}
			</div>
			{actions ? (
				<div className="flex shrink-0 flex-wrap items-center gap-1.5">
					{actions}
				</div>
			) : null}
		</header>
	)
}

export function WorkspaceMetricGrid({
	className,
	children,
}: {
	className?: string
	children: ReactNode
}) {
	return (
		<div
			className={cn(
				'bg-border grid gap-px overflow-hidden rounded-xl border sm:grid-cols-2 xl:grid-cols-4',
				className,
			)}
		>
			{children}
		</div>
	)
}

export function WorkspaceMetric({
	label,
	value,
	hint,
	tone = 'default',
	className,
}: {
	label: ReactNode
	value: ReactNode
	hint?: ReactNode
	tone?: 'default' | 'primary' | 'warning' | 'danger'
	className?: string
}) {
	const valueTone =
		tone === 'primary'
			? 'text-primary'
			: tone === 'warning'
				? 'text-warning'
				: tone === 'danger'
					? 'text-destructive'
					: 'text-foreground'

	const hintTone =
		tone === 'danger'
			? 'text-destructive'
			: tone === 'warning'
				? 'text-warning'
				: 'text-muted-foreground'

	return (
		<div
			className={cn(
				'bg-card flex min-w-0 flex-col gap-1.5 px-4 py-3.5',
				className,
			)}
		>
			<div className="text-foreground/75 text-[13px] leading-tight">
				{label}
			</div>
			<div
				className={cn(
					'text-[1.375rem] leading-[1.1] font-semibold tracking-[-0.02em] tabular-nums',
					valueTone,
				)}
			>
				{value}
			</div>
			{hint ? (
				<div className={cn('text-xs leading-snug', hintTone)}>{hint}</div>
			) : null}
		</div>
	)
}

/** Optional section chrome — flat on the workspace canvas (no extra card). */
export function WorkspacePanel({
	title,
	description,
	action,
	children,
	className,
	contentClassName,
}: {
	title?: ReactNode
	description?: ReactNode
	action?: ReactNode
	children: ReactNode
	className?: string
	contentClassName?: string
}) {
	return (
		<section className={cn('min-w-0', className)}>
			{title || description || action ? (
				<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
					<div className="min-w-0">
						{title ? (
							<h2 className="text-[0.90625rem] font-semibold tracking-[-0.01em]">
								{title}
							</h2>
						) : null}
						{description ? (
							<p className="text-muted-foreground mt-0.5 text-sm">
								{description}
							</p>
						) : null}
					</div>
					{action ? (
						<div className="flex shrink-0 items-center gap-2">{action}</div>
					) : null}
				</div>
			) : null}
			<div className={cn('min-w-0', contentClassName)}>{children}</div>
		</section>
	)
}

export type WorkspaceTab = {
	label: ReactNode
	href: string
	isActive: boolean
}

export function WorkspaceTabBar({
	tabs,
	label = 'Section',
	className,
}: {
	tabs: WorkspaceTab[]
	/** Accessible name for the tab navigation. */
	label?: string
	className?: string
}) {
	return (
		<WorkspaceTabDivider className={className}>
			<nav
				className="-mx-4 [scrollbar-width:none] overflow-x-auto md:-mx-1 [&::-webkit-scrollbar]:hidden"
				aria-label={label}
			>
				<div className="flex min-w-max gap-0.5 px-4 md:px-1">
					{tabs.map((tab) => (
						<Link
							key={tab.href}
							to={tab.href}
							aria-current={tab.isActive ? 'page' : undefined}
							className={cn(
								'relative flex h-9 items-center px-2.5 text-[13px] font-medium transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full',
								tab.isActive
									? 'text-foreground after:bg-foreground'
									: 'text-muted-foreground hover:text-foreground after:bg-transparent',
							)}
						>
							{tab.label}
						</Link>
					))}
				</div>
			</nav>
		</WorkspaceTabDivider>
	)
}

/**
 * Bottom divider for a row of section tabs. It spans the whole main column
 * (edge to edge), not just the centered page width: `cqw` is the
 * `@container/main` content width and the added rem covers that container's
 * horizontal padding (2rem on mobile, 1.5rem from md). Wrap stock `TabsList variant="line"` in it to match
 * `WorkspaceTabBar`.
 */
export function WorkspaceTabDivider({
	className,
	children,
}: {
	className?: string
	children: ReactNode
}) {
	return (
		<div
			className={cn(
				'before:bg-border relative before:absolute before:bottom-0 before:left-1/2 before:h-px before:w-[calc(100cqw+2rem)] before:-translate-x-1/2 md:before:w-[calc(100cqw+1.5rem)]',
				className,
			)}
		>
			{children}
		</div>
	)
}

export function WorkspaceToolbar({
	className,
	children,
}: {
	className?: string
	children: ReactNode
}) {
	return (
		<div
			className={cn(
				'flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between',
				className,
			)}
		>
			{children}
		</div>
	)
}

/** Elevated surface for settings sections and nested forms. */
export function WorkspaceSurface({
	className,
	children,
}: {
	className?: string
	children: ReactNode
}) {
	return (
		<div
			className={cn(
				'bg-card shadow-card overflow-hidden rounded-xl border',
				className,
			)}
		>
			{children}
		</div>
	)
}
