import { Trans } from '@lingui/macro'
import { Badge } from '@repo/ui/badge'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useMemo } from 'react'
import { useLoaderData } from 'react-router'

import { menuCatalogUnavailableMessage } from '#app/utils/menu-catalog-messages.ts'
import { listModifierGroupsForLocation } from '#app/utils/menu-catalog.server.ts'
import { loadMenuOperatorContextFromArgs } from '#app/utils/menu-loader.server.ts'

import { MenuCatalogGate } from '../components/menu-catalog-gate.tsx'
import { MenuClickableTableRow } from '../components/menu-clickable-table-row.tsx'
import {
	MenuListHeader,
	MenuTableShell,
} from '../components/menu-list-header.tsx'
import { useMenuListSearch } from '../components/use-menu-list-search.ts'

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
	const { organization, groups, catalogReady, canEditMenu, operatorContext } =
		useLoaderData<typeof loader>()
	const { query, setQuery } = useMenuListSearch()

	const filteredGroups = useMemo(() => {
		const needle = query.toLowerCase()
		return groups.filter((group) => {
			const attached = group.attachedItems.map((i) => i.name).join(' ')
			const haystack = `${group.name} ${attached}`.toLowerCase()
			return !needle || haystack.includes(needle)
		})
	}, [groups, query])

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

	const base = `/${organization.slug}/menu/modifier-groups`
	const scopeSubtitle =
		operatorContext === 'branch' ? (
			<Trans>Location scope</Trans>
		) : (
			<Trans>Brand scope — default location</Trans>
		)

	return (
		<div className="flex flex-col gap-4">
			<MenuListHeader
				title={<Trans>Modifier sets</Trans>}
				subtitle={scopeSubtitle}
				searchQuery={query}
				onSearchChange={setQuery}
				searchPlaceholder="Search modifier sets"
				createHref={`${base}/new`}
				createLabel={<Trans>Create modifier set</Trans>}
				canCreate={canEditMenu}
			/>
			<p className="text-muted-foreground text-sm">
				<Trans>
					Reusable option groups. Define choices here, then attach sets to
					items.
				</Trans>
			</p>
			<MenuTableShell>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>
								<Trans>Name</Trans>
							</TableHead>
							<TableHead className="hidden lg:table-cell">
								<Trans>Used on items</Trans>
							</TableHead>
							<TableHead className="hidden sm:table-cell">
								<Trans>Options</Trans>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{filteredGroups.length === 0 ? (
							<TableRow>
								<TableCell colSpan={3}>
									<p className="text-muted-foreground px-4 py-12 text-center text-sm">
										{query ? (
											<Trans>No modifier sets match your search.</Trans>
										) : (
											<Trans>No modifier sets yet.</Trans>
										)}
									</p>
								</TableCell>
							</TableRow>
						) : (
							filteredGroups.map((group) => (
								<MenuClickableTableRow
									key={group.id}
									to={`${base}/${group.id}`}
								>
									<TableCell className="font-medium">{group.name}</TableCell>
									<TableCell className="text-muted-foreground hidden lg:table-cell">
										{group.attachedItems.length
											? group.attachedItems.map((i) => i.name).join(', ')
											: '—'}
									</TableCell>
									<TableCell className="hidden sm:table-cell">
										<Badge variant="secondary">{group.options.length}</Badge>
									</TableCell>
								</MenuClickableTableRow>
							))
						)}
					</TableBody>
				</Table>
			</MenuTableShell>
		</div>
	)
}
