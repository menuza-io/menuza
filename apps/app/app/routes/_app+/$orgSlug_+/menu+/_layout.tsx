import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { PageTitle } from '@repo/ui/page-title'
import { Link, Outlet, useLocation, useParams } from 'react-router'

export default function MenuLayout() {
	const { _ } = useLingui()
	const location = useLocation()
	const params = useParams()
	const orgSlug = params.orgSlug

	const tabs = [
		{
			label: _(t`Overview`),
			href: `/${orgSlug}/menu`,
			isActive:
				location.pathname === `/${orgSlug}/menu` ||
				location.pathname === `/${orgSlug}/menu/`,
		},
		{
			label: _(t`Menus`),
			href: `/${orgSlug}/menu/menus`,
			isActive:
				location.pathname === `/${orgSlug}/menu/menus` ||
				location.pathname === `/${orgSlug}/menu/menus/`,
		},
		{
			label: _(t`Categories`),
			href: `/${orgSlug}/menu/categories`,
			isActive:
				location.pathname === `/${orgSlug}/menu/categories` ||
				location.pathname === `/${orgSlug}/menu/categories/`,
		},
		{
			label: _(t`Items`),
			href: `/${orgSlug}/menu/items`,
			isActive:
				location.pathname === `/${orgSlug}/menu/items` ||
				location.pathname === `/${orgSlug}/menu/items/`,
		},
		{
			label: _(t`Modifier Groups`),
			href: `/${orgSlug}/menu/modifiers`,
			isActive:
				location.pathname === `/${orgSlug}/menu/modifiers` ||
				location.pathname === `/${orgSlug}/menu/modifiers/`,
		},
		{
			label: _(t`Options`),
			href: `/${orgSlug}/menu/options`,
			isActive:
				location.pathname === `/${orgSlug}/menu/options` ||
				location.pathname === `/${orgSlug}/menu/options/`,
		},
	]

	// Create and Edit views render full-page Shopify-style chrome
	const isEditOrCreate =
		/\/menu\/(menus|categories|items|modifiers|options)\/(new|[^/]+)$/.test(
			location.pathname,
		)

	if (isEditOrCreate) {
		return <Outlet />
	}

	return (
		<div className="mx-auto w-full max-w-6xl py-8 md:px-6 lg:px-8">
			<div className="mb-8 md:mb-10">
				<PageTitle
					title={_(t`Menu`)}
					description={_(
						t`Manage your menus, categories, items, and modifier groups.`,
					)}
				/>
			</div>

			<nav className="border-border mb-6 [scrollbar-width:none] overflow-x-auto border-b [&::-webkit-scrollbar]:hidden">
				<div className="-mb-px flex min-w-max gap-4">
					{tabs.map((tab) => (
						<Link
							key={tab.href}
							to={tab.href}
							className={cn(
								'border-b-2 px-1 pb-3 text-sm font-medium transition-colors',
								tab.isActive
									? 'border-primary text-foreground'
									: 'text-muted-foreground hover:text-foreground border-transparent',
							)}
						>
							{tab.label}
						</Link>
					))}
				</div>
			</nav>

			<Outlet />
		</div>
	)
}
