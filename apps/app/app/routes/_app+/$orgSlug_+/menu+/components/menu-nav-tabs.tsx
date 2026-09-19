import { Trans } from '@lingui/macro'
import { cn } from '@repo/ui'
import { Link, useLocation } from 'react-router'

const tabs = [
	{ segment: '', label: () => <Trans>Overview</Trans>, exact: true },
	{ segment: 'menus', label: () => <Trans>Menus</Trans> },
	{ segment: 'categories', label: () => <Trans>Categories</Trans> },
	{ segment: 'items', label: () => <Trans>Items</Trans> },
	{
		segment: 'modifier-groups',
		label: () => <Trans>Modifier groups</Trans>,
	},
] as const

export function MenuNavTabs({ orgSlug }: { orgSlug: string }) {
	const location = useLocation()
	const base = `/${orgSlug}/menu`

	return (
		<nav
			className="flex flex-wrap gap-1 border-b pb-px"
			aria-label="Menu sections"
		>
			{tabs.map((tab) => {
				const href = tab.segment ? `${base}/${tab.segment}` : base
				const active =
					'exact' in tab && tab.exact
						? location.pathname === base || location.pathname === `${base}/`
						: location.pathname.startsWith(href)
				return (
					<Link
						key={tab.segment}
						to={href}
						className={cn(
							'rounded-t-md px-3 py-2 text-sm font-medium transition-colors',
							active
								? 'border-border bg-background text-foreground border border-b-transparent'
								: 'text-muted-foreground hover:text-foreground',
						)}
					>
						{tab.label()}
					</Link>
				)
			})}
		</nav>
	)
}
