import { Trans } from '@lingui/macro'
import { PageTitle } from '@repo/ui/page-title'
import { Outlet, useLoaderData } from 'react-router'

import { loadMenuOperatorContextFromArgs } from '#app/utils/menu-loader.server.ts'

import { MenuNavTabs } from './components/menu-nav-tabs.tsx'
import { MenuScopeBadge } from './components/menu-scope-badge.tsx'

export async function loader(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	return loadMenuOperatorContextFromArgs(args)
}

export default function MenuLayout() {
	const { organization, operatorContext } = useLoaderData<typeof loader>()

	return (
		<div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 py-8 md:px-6 lg:px-8">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<PageTitle
					title="Menu"
					description="Categories, items, and modifier groups for your storefront."
				/>
				<MenuScopeBadge operatorContext={operatorContext} />
			</div>
			<p className="text-muted-foreground text-sm">
				{operatorContext === 'branch' ? (
					<Trans>
						Editing the menu for the selected branch. Switch location in the
						header to change scope.
					</Trans>
				) : (
					<Trans>
						Editing the brand default catalog (default location). Per-branch
						overrides ship in a later phase.
					</Trans>
				)}
			</p>
			<MenuNavTabs orgSlug={organization.slug} />
			<Outlet />
		</div>
	)
}
