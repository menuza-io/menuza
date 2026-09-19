import { Trans } from '@lingui/macro'
import { PageTitle } from '@repo/ui/page-title'
import { Outlet, useLoaderData } from 'react-router'

import { loadMenuOperatorContextFromArgs } from '#app/utils/menu-loader.server.ts'

import { MenuScopeBadge } from './components/menu-scope-badge.tsx'
import { MenuSidebarNav } from './components/menu-sidebar-nav.tsx'

export async function loader(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	return loadMenuOperatorContextFromArgs(args)
}

export default function MenuLayout() {
	const { organization, operatorContext } = useLoaderData<typeof loader>()

	return (
		<div className="mx-auto flex h-full w-full max-w-7xl flex-col gap-4 py-6 md:px-6 lg:px-8">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<PageTitle
					title="Menu"
					description={
						operatorContext === 'branch' ? (
							<Trans>
								Location-scoped catalog. Switch location in the header to change
								scope.
							</Trans>
						) : (
							<Trans>
								Brand default catalog. Per-location overrides ship in a later
								phase.
							</Trans>
						)
					}
				/>
				<MenuScopeBadge operatorContext={operatorContext} />
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row md:gap-6">
				<MenuSidebarNav orgSlug={organization.slug} />
				<div className="min-w-0 flex-1 pb-8">
					<Outlet />
				</div>
			</div>
		</div>
	)
}
