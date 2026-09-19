import { parseWithZod } from '@conform-to/zod'
import { Trans } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import {
	type ActionFunctionArgs,
	Form,
	Link,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { z } from 'zod'

import {
	listCategoriesForLocation,
	listItemsForLocation,
	setMenuItemActive,
} from '#app/utils/menu-catalog.server.ts'
import { menuCatalogUnavailableMessage } from '#app/utils/menu-catalog-messages.ts'
import {
	loadMenuOperatorContext,
	loadMenuOperatorContextFromArgs,
} from '#app/utils/menu-loader.server.ts'
import { MENU_WRITE_PERMISSION } from '#app/utils/menu-permissions.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

import { MenuCatalogGate } from '../components/menu-catalog-gate.tsx'
import { MenuReorderList } from '../components/menu-reorder-list.tsx'

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
	} = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state !== 'idle'

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
		<div className="flex flex-col gap-6">
			{canEditMenu ? (
				<div className="flex justify-end">
					<Button render={<Link to={`/${organization.slug}/menu/items/new`} />}>
						<Icon name="plus" className="size-4" />
						<Trans>Add item</Trans>
					</Button>
				</div>
			) : null}

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

			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>
							<Trans>Name</Trans>
						</TableHead>
						<TableHead>
							<Trans>Category</Trans>
						</TableHead>
						<TableHead>
							<Trans>Price</Trans>
						</TableHead>
						<TableHead>
							<Trans>Available</Trans>
						</TableHead>
						<TableHead className="text-end">
							<Trans>Actions</Trans>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{items.length === 0 ? (
						<TableRow>
							<TableCell colSpan={5}>
								<p className="text-muted-foreground py-6 text-center text-sm">
									<Trans>
										No items yet. Add a category, then create your first item.
									</Trans>
								</p>
							</TableCell>
						</TableRow>
					) : (
						items.map((item) => (
							<TableRow key={item.id}>
								<TableCell className="font-medium">
									<Link
										to={`/${organization.slug}/menu/items/${item.id}`}
										className="hover:underline"
									>
										{item.name}
									</Link>
								</TableCell>
								<TableCell>
									{categoryNameById[item.categoryId] ?? '—'}
								</TableCell>
								<TableCell className="tabular-nums">
									${(item.priceCents / 100).toFixed(2)}
								</TableCell>
								<TableCell>
									{item.active ? (
										<Badge variant="secondary">
											<Trans>Yes</Trans>
										</Badge>
									) : (
										<Badge variant="outline">
											<Trans>86&apos;d</Trans>
										</Badge>
									)}
								</TableCell>
								<TableCell className="text-end">
									<div className="flex flex-wrap justify-end gap-2">
										{canEditMenu ? (
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
										) : null}
										<Button
											variant="ghost"
											size="sm"
											render={
												<Link
													to={`/${organization.slug}/menu/items/${item.id}`}
												/>
											}
										>
											<Trans>Edit</Trans>
										</Button>
									</div>
								</TableCell>
							</TableRow>
						))
					)}
				</TableBody>
			</Table>
		</div>
	)
}
