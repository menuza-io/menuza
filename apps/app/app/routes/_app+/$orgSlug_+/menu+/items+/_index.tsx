import { parseWithZod } from '@conform-to/zod'
import { Trans } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
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
import {
	type ActionFunctionArgs,
	Form,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { z } from 'zod'

import { menuCatalogUnavailableMessage } from '#app/utils/menu-catalog-messages.ts'
import {
	listCategoriesForLocation,
	listItemsForLocation,
	setMenuItemActive,
} from '#app/utils/menu-catalog.server.ts'
import {
	loadMenuOperatorContext,
	loadMenuOperatorContextFromArgs,
} from '#app/utils/menu-loader.server.ts'
import { MENU_WRITE_PERMISSION } from '#app/utils/menu-permissions.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

import { MenuCatalogGate } from '../components/menu-catalog-gate.tsx'
import {
	MenuClickableTableRow,
	stopRowClick,
} from '../components/menu-clickable-table-row.tsx'
import {
	MenuListHeader,
	MenuTableShell,
} from '../components/menu-list-header.tsx'
import { MenuReorderList } from '../components/menu-reorder-list.tsx'
import { useMenuListSearch } from '../components/use-menu-list-search.ts'

const ItemActionSchema = z.object({
	intent: z.enum(['toggle-active']),
	itemId: z.string().min(1),
})

export async function loader(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	const ctx = await loadMenuOperatorContextFromArgs(args)
	if (!ctx.catalogReady || !ctx.menuLocationId) {
		return { ...ctx, items: [], categories: [], categoryNameById: {} }
	}
	const [items, categories] = await Promise.all([
		listItemsForLocation(ctx.organization.id, ctx.menuLocationId),
		listCategoriesForLocation(ctx.organization.id, ctx.menuLocationId),
	])
	const categoryNameById: Record<string, string> = Object.fromEntries(
		categories.map((c) => [c.id, c.name]),
	)
	return {
		...ctx,
		items,
		categories,
		categoryNameById,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		hasProvisionedDb: true,
		dataRegion: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		MENU_WRITE_PERMISSION,
	)
	const ctx = await loadMenuOperatorContext(request, params.orgSlug)
	if (!ctx.catalogReady || !ctx.menuLocationId) {
		const msg = menuCatalogUnavailableMessage(organization)
		return redirectWithToast(`/${organization.slug}/menu/items`, {
			type: 'error',
			title: msg.title,
			description: msg.description,
		})
	}

	const formData = await request.formData()
	const submission = parseWithZod(formData, { schema: ItemActionSchema })
	if (submission.status !== 'success') return submission.reply()

	const items = await listItemsForLocation(organization.id, ctx.menuLocationId)
	const item = items.find((i) => i.id === submission.value.itemId)
	if (!item) {
		return redirectWithToast(`/${organization.slug}/menu/items`, {
			type: 'error',
			title: 'Item not found',
			description: '',
		})
	}

	await setMenuItemActive(
		organization.id,
		ctx.menuLocationId,
		item.id,
		!item.active,
	)
	return redirectWithToast(`/${organization.slug}/menu/items`, {
		type: 'success',
		title: item.active ? 'Item marked unavailable' : 'Item available again',
		description: '',
	})
}

export default function MenuItemsListPage() {
	const {
		organization,
		items,
		categories,
		categoryNameById,
		catalogReady,
		canEditMenu,
		operatorContext,
	} = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state !== 'idle'
	const { query, setQuery } = useMenuListSearch()
	const [availabilityFilter, setAvailabilityFilter] = useState<
		'all' | 'available' | 'unavailable'
	>('all')

	const filteredItems = useMemo(() => {
		const needle = query.toLowerCase()
		return items.filter((item) => {
			const categoryName = categoryNameById[item.categoryId] ?? ''
			const haystack = `${item.name} ${categoryName}`.toLowerCase()
			if (needle && !haystack.includes(needle)) return false
			if (availabilityFilter === 'available' && !item.active) return false
			if (availabilityFilter === 'unavailable' && item.active) return false
			return true
		})
	}, [items, categoryNameById, query, availabilityFilter])

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

	const itemsBase = `/${organization.slug}/menu/items`
	const scopeSubtitle =
		operatorContext === 'branch' ? (
			<Trans>Location scope</Trans>
		) : (
			<Trans>Brand scope — default location</Trans>
		)

	return (
		<div className="flex flex-col gap-6">
			<MenuListHeader
				title={<Trans>Items</Trans>}
				subtitle={scopeSubtitle}
				searchQuery={query}
				onSearchChange={setQuery}
				searchPlaceholder="Search items"
				createHref={`${itemsBase}/new`}
				createLabel={<Trans>Create item</Trans>}
				canCreate={canEditMenu}
				availabilityFilter={availabilityFilter}
				onAvailabilityFilterChange={setAvailabilityFilter}
			/>

			{categories.length > 0 && items.length > 0 ? (
				<section className="space-y-6">
					<h3 className="text-sm font-medium">
						<Trans>Item order within category</Trans>
					</h3>
					{categories.map((category) => {
						const categoryItems = items
							.filter((item) => item.categoryId === category.id)
							.sort((a, b) => a.sortOrder - b.sortOrder)
						if (!categoryItems.length) return null
						return (
							<div key={category.id} className="space-y-2">
								<p className="text-muted-foreground text-sm font-medium">
									{category.name}
								</p>
								<MenuReorderList
									rows={categoryItems.map((item) => ({
										id: item.id,
										label: item.name,
									}))}
									reorderAction={`/${organization.slug}/menu/reorder`}
									reorderIntent="reorder-items"
									extraFields={{ categoryId: category.id }}
									disabled={!canEditMenu || isSubmitting}
								/>
							</div>
						)
					})}
				</section>
			) : null}

			<MenuTableShell>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>
								<Trans>Name</Trans>
							</TableHead>
							<TableHead className="hidden lg:table-cell">
								<Trans>Category</Trans>
							</TableHead>
							<TableHead>
								<Trans>Price</Trans>
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
						{filteredItems.length === 0 ? (
							<TableRow>
								<TableCell colSpan={canEditMenu ? 5 : 4}>
									<p className="text-muted-foreground px-4 py-12 text-center text-sm">
										{query ? (
											<Trans>
												Nothing matches your search. Try another term or clear
												filters.
											</Trans>
										) : (
											<Trans>
												No items yet. Add a category, then create your first
												item.
											</Trans>
										)}
									</p>
								</TableCell>
							</TableRow>
						) : (
							filteredItems.map((item) => (
								<MenuClickableTableRow
									key={item.id}
									to={`${itemsBase}/${item.id}`}
								>
									<TableCell className="font-medium">{item.name}</TableCell>
									<TableCell className="text-muted-foreground hidden lg:table-cell">
										{categoryNameById[item.categoryId] ?? '—'}
									</TableCell>
									<TableCell className="tabular-nums">
										${(item.priceCents / 100).toFixed(2)}
									</TableCell>
									<TableCell>
										{item.active ? (
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
												<input type="hidden" name="itemId" value={item.id} />
												<Button
													type="submit"
													variant="outline"
													size="sm"
													disabled={isSubmitting}
												>
													{item.active ? (
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
