import { Trans } from '@lingui/macro'
import { PageHeader } from '@repo/ui/page-header'
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
			<PageHeader
				title={<Trans>Menu</Trans>}
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
				actions={<MenuScopeBadge operatorContext={operatorContext} />}
			/>
			<MenuNavTabs orgSlug={organization.slug} />
			<div className="min-w-0 pb-8">
				<Outlet />
			</div>
		</div>
	)
}
