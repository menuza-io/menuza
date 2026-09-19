import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Link, useLoaderData } from 'react-router'

import { menuCatalogUnavailableMessage } from '#app/utils/menu-catalog-messages.ts'
import { getMenuOverviewStats } from '#app/utils/menu-catalog.server.ts'
import { loadMenuOperatorContextFromArgs } from '#app/utils/menu-loader.server.ts'

import { MenuCatalogGate } from './components/menu-catalog-gate.tsx'

export async function loader(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	const ctx = await loadMenuOperatorContextFromArgs(args)
	const { organization, menuLocationId, catalogReady } = ctx
	if (!catalogReady || !menuLocationId) {
		return { ...ctx, stats: null }
	}
	const stats = await getMenuOverviewStats(organization.id, menuLocationId)
	return { ...ctx, stats }
}

export default function MenuOverviewRoute() {
	const { organization, catalogReady, stats } = useLoaderData<typeof loader>()

	if (!catalogReady || !stats) {
		const msg = menuCatalogUnavailableMessage(organization)
		return (
			<MenuCatalogGate
				title={msg.title}
				description={msg.description}
				websiteHref={`/${organization.slug}/website`}
			/>
		)
	}

	const base = `/${organization.slug}/menu`
	const activeMenuName = stats.activeMenuName

	return (
		<div className="flex flex-col gap-8">
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Menus</Trans>
						</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="text-2xl font-semibold">{stats.menuCount}</p>
					</CardContent>
				</Card>
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Categories</Trans>
						</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="text-2xl font-semibold">{stats.categoryCount}</p>
					</CardContent>
				</Card>
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Items</Trans>
						</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="text-2xl font-semibold">{stats.itemCount}</p>
					</CardContent>
				</Card>
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Modifier sets</Trans>
						</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="text-2xl font-semibold">{stats.modifierSetCount}</p>
					</CardContent>
				</Card>
			</div>

			<p className="text-muted-foreground text-sm">
				<Trans>
					Active menu: {activeMenuName}. Build categories and items, attach them
					to menus, and set modifier groups diners choose at checkout.
				</Trans>
			</p>

			<div className="flex flex-wrap gap-2">
				<Button render={<Link to={`${base}/menus`} />}>
					<Trans>Manage menus</Trans>
				</Button>
				<Button variant="outline" render={<Link to={`${base}/categories`} />}>
					<Trans>Categories</Trans>
				</Button>
				<Button variant="outline" render={<Link to={`${base}/items/new`} />}>
					<Trans>Add item</Trans>
				</Button>
				<Button
					variant="outline"
					render={<Link to={`${base}/modifier-groups/new`} />}
				>
					<Trans>New modifier group</Trans>
				</Button>
			</div>
		</div>
	)
}
