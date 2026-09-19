import { Trans } from '@lingui/macro'
import { Link, useLoaderData } from 'react-router'

import { listModifierGroupsForLocation } from '#app/utils/menu-catalog.server.ts'
import {
	loadMenuOperatorContextFromArgs,
	menuCatalogUnavailableMessage,
} from '#app/utils/menu-loader.server.ts'

import { MenuCatalogGate } from '../components/menu-catalog-gate.tsx'

export async function loader(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	const ctx = await loadMenuOperatorContextFromArgs(args)
	const groups =
		ctx.catalogReady && ctx.menuLocationId
			? await listModifierGroupsForLocation(
					ctx.organization.id,
					ctx.menuLocationId,
				)
			: []
	return { ...ctx, groups }
}

export default function ModifierGroupsListPage() {
	const { organization, groups, catalogReady } = useLoaderData<typeof loader>()

	if (!catalogReady) {
		const msg = menuCatalogUnavailableMessage(organization)
		return (
			<MenuCatalogGate
				title={msg.title}
				description={msg.description}
				websiteHref={`/${organization.slug}/website`}
			/>
		)
	}

	return (
		<div className="flex flex-col gap-4">
			<p className="text-muted-foreground text-sm">
				<Trans>
					Modifier groups are attached to items. Create a group from an item
					detail page, then add options here.
				</Trans>
			</p>
			{groups.length === 0 ? (
				<p className="text-muted-foreground py-8 text-center text-sm">
					<Trans>No modifier groups yet.</Trans>
				</p>
			) : (
				<ul className="divide-y rounded-lg border">
					{groups.map((group) => (
						<li
							key={group.id}
							className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
						>
							<div>
								<Link
									to={`/${organization.slug}/menu/modifier-groups/${group.id}`}
									className="font-medium hover:underline"
								>
									{group.name}
								</Link>
								<p className="text-muted-foreground text-sm">
									<Trans>On item:</Trans> {group.itemName}
								</p>
							</div>
							<span className="text-muted-foreground text-sm">
								{group.options.length} <Trans>options</Trans>
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}
