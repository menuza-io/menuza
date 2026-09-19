import { Trans } from '@lingui/macro'
import { cn } from '@repo/ui'
import { Link, useLocation } from 'react-router'

const resources = [
	{ segment: '', label: () => <Trans>Home</Trans>, exact: true },
	{ segment: 'menus', label: () => <Trans>Menus</Trans> },
	{ segment: 'categories', label: () => <Trans>Categories</Trans> },
	{ segment: 'items', label: () => <Trans>Items</Trans> },
	{
		segment: 'modifier-groups',
		label: () => <Trans>Modifier sets</Trans>,
	},
] as const

export function MenuSidebarNav({ orgSlug }: { orgSlug: string }) {
	const location = useLocation()
	const base = `/${orgSlug}/menu`

	return (
		<>
			<nav
				aria-label="Menu sections"
				className="flex w-full flex-wrap gap-1 border-b pb-2 md:hidden"
			>
				{resources.map((entry) => {
					const href = entry.segment ? `${base}/${entry.segment}` : base
					const active =
						'exact' in entry && entry.exact
							? location.pathname === base || location.pathname === `${base}/`
							: location.pathname.startsWith(href)
					return (
						<Link
							key={`m-${entry.segment}`}
							to={href}
							className={cn(
								'rounded-md px-2.5 py-1.5 text-sm transition-colors',
								active
									? 'bg-muted text-foreground font-medium'
									: 'text-muted-foreground hover:bg-muted/60',
							)}
						>
							{entry.label()}
						</Link>
					)
				})}
			</nav>
			<nav
				aria-label="Menu sections"
				className="hidden w-52 shrink-0 flex-col gap-0.5 border-r pr-3 md:flex"
			>
				<p className="text-muted-foreground px-2.5 pt-1 pb-1 text-[11px] font-medium tracking-wide uppercase">
					<Trans>Menu</Trans>
				</p>
				{resources.map((entry) => {
					const href = entry.segment ? `${base}/${entry.segment}` : base
					const active =
						'exact' in entry && entry.exact
							? location.pathname === base || location.pathname === `${base}/`
							: location.pathname.startsWith(href)
					return (
						<Link
							key={entry.segment}
							to={href}
							className={cn(
								'rounded-md px-2.5 py-1.5 text-sm transition-colors',
								active
									? 'bg-muted text-foreground font-medium'
									: 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
							)}
						>
							{entry.label()}
						</Link>
					)
				})}
			</nav>
		</>
	)
}
