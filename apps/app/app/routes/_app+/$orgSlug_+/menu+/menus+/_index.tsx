import { Trans } from '@lingui/macro'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useMemo, useState } from 'react'
import { Form, useLoaderData, useNavigation } from 'react-router'

import { listMenusForLocation } from '#app/utils/menu-catalog.server.ts'
import { menuCatalogUnavailableMessage } from '#app/utils/menu-catalog-messages.ts'
import { loadMenuOperatorContextFromArgs } from '#app/utils/menu-loader.server.ts'
import { MENU_WRITE_PERMISSION } from '#app/utils/menu-permissions.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

import {
	MenuClickableTableRow,
	stopRowClick,
} from '../components/menu-clickable-table-row.tsx'
import { MenuCatalogGate } from '../components/menu-catalog-gate.tsx'
import {
	MenuListHeader,
	MenuTableShell,
} from '../components/menu-list-header.tsx'
import { useMenuListSearch } from '../components/use-menu-list-search.ts'

export async function loader(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	const ctx = await loadMenuOperatorContextFromArgs(args)
	const { organization, menuLocationId, catalogReady } = ctx
	if (!catalogReady || !menuLocationId) {
		return { ...ctx, menus: [] as const }
	}
	const menuList = await listMenusForLocation(organization.id, menuLocationId)
	return { ...ctx, menus: menuList }
}

export async function action(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	const ctx = await loadMenuOperatorContextFromArgs(args)
	const { organization, menuLocationId, catalogReady } = ctx
	if (!catalogReady || !menuLocationId) {
		return new Response('Catalog not ready', { status: 400 })
	}
	await requireUserWithOrganizationPermission(
		args.request,
		organization.id,
		MENU_WRITE_PERMISSION,
	)
	const formData = await args.request.formData()
	const intent = formData.get('intent')
	const menuId = formData.get('menuId')?.toString()
	if (!menuId) return new Response('Missing menuId', { status: 400 })

	const { setMenuActive, deleteMenu } =
		await import('#app/utils/menu-catalog.server.ts')

	if (intent === 'toggle-active') {
		const active = formData.get('active') === 'true'
		await setMenuActive(organization.id, menuLocationId, menuId, active)
		return { ok: true }
	}
	if (intent === 'delete') {
		await deleteMenu(organization.id, menuLocationId, menuId)
		return { ok: true }
	}
	return new Response('Unknown intent', { status: 400 })
}

export default function MenusListRoute() {
	const { organization, menus, catalogReady, canEditMenu, operatorContext } =
		useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state !== 'idle'
	const { query, setQuery } = useMenuListSearch()
	const [availabilityFilter, setAvailabilityFilter] = useState<
		'all' | 'available' | 'unavailable'
	>('all')

	const filteredMenus = useMemo(() => {
		const needle = query.toLowerCase()
		return menus.filter((menu) => {
			if (needle && !menu.name.toLowerCase().includes(needle)) return false
			if (availabilityFilter === 'available' && !menu.active) return false
			if (availabilityFilter === 'unavailable' && menu.active) return false
			return true
		})
	}, [menus, query, availabilityFilter])

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

	const base = `/${organization.slug}/menu/menus`
	const scopeSubtitle =
		operatorContext === 'branch' ? (
			<Trans>Location scope</Trans>
		) : (
			<Trans>Brand scope — default location</Trans>
		)

	return (
		<div className="p-0 lg:p-0">
			<MenuListHeader
				title={<Trans>Menus</Trans>}
				subtitle={scopeSubtitle}
				searchQuery={query}
				onSearchChange={setQuery}
				searchPlaceholder="Search menus"
				createHref={`${base}/new`}
				createLabel={<Trans>Create menu</Trans>}
				canCreate={canEditMenu}
				availabilityFilter={availabilityFilter}
				onAvailabilityFilterChange={setAvailabilityFilter}
			/>

			<MenuTableShell>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>
								<Trans>Name</Trans>
							</TableHead>
							<TableHead>
								<Trans>Availability</Trans>
							</TableHead>
							{canEditMenu ? (
								<TableHead className="w-28 text-end">
									<span className="sr-only">
										<Trans>Actions</Trans>
									</span>
								</TableHead>
							) : null}
						</TableRow>
					</TableHeader>
					<TableBody>
						{filteredMenus.length === 0 ? (
							<TableRow>
								<TableCell colSpan={canEditMenu ? 3 : 2}>
									<p className="text-muted-foreground px-4 py-12 text-center text-sm">
										{query ? (
											<Trans>
												Nothing matches your search. Try another term or clear
												filters.
											</Trans>
										) : (
											<Trans>No menus yet.</Trans>
										)}
									</p>
								</TableCell>
							</TableRow>
						) : (
							filteredMenus.map((menu) => (
								<MenuClickableTableRow key={menu.id} to={`${base}/${menu.id}`}>
									<TableCell className="font-medium">{menu.name}</TableCell>
									<TableCell>
										{menu.active ? (
											<Badge variant="secondary">
												<Trans>Available</Trans>
											</Badge>
										) : (
											<Badge variant="outline">
												<Trans>Unavailable</Trans>
											</Badge>
										)}
									</TableCell>
									{canEditMenu ? (
										<TableCell className="text-end" onClick={stopRowClick}>
											<Form method="post" className="inline">
												<input
													type="hidden"
													name="intent"
													value="toggle-active"
												/>
												<input type="hidden" name="menuId" value={menu.id} />
												<input
													type="hidden"
													name="active"
													value={menu.active ? 'false' : 'true'}
												/>
												<Button
													type="submit"
													variant="outline"
													size="sm"
													disabled={isSubmitting}
												>
													{menu.active ? (
														<Trans>86</Trans>
													) : (
														<Trans>Restock</Trans>
													)}
												</Button>
											</Form>
										</TableCell>
									) : null}
								</MenuClickableTableRow>
							))
						)}
					</TableBody>
				</Table>
			</MenuTableShell>
		</div>
	)
}
