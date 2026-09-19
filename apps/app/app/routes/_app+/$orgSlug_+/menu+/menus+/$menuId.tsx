import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Form,
	Link,
	useLoaderData,
	useNavigation,
	useParams,
} from 'react-router'

import {
	getMenu,
	linkCategoryToMenu,
	listCategoriesForLocation,
	menuSchema,
	unlinkCategoryFromMenu,
	updateMenu,
} from '#app/utils/menu-catalog.server.ts'
import { menuCatalogUnavailableMessage } from '#app/utils/menu-catalog-messages.ts'
import { loadMenuOperatorContextFromArgs } from '#app/utils/menu-loader.server.ts'
import { MENU_WRITE_PERMISSION } from '#app/utils/menu-permissions.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

import { MenuCatalogGate } from '../components/menu-catalog-gate.tsx'
import { MenuReorderList } from '../components/menu-reorder-list.tsx'

export async function loader(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	const ctx = await loadMenuOperatorContextFromArgs(args)
	const { organization, menuLocationId, catalogReady } = ctx
	const menuId = args.params.menuId!
	if (!catalogReady || !menuLocationId) {
		return { ...ctx, menu: null, allCategories: [] as const }
	}
	const [menu, allCategories] = await Promise.all([
		getMenu(organization.id, menuLocationId, menuId),
		listCategoriesForLocation(organization.id, menuLocationId),
	])
	return { ...ctx, menu, allCategories }
}

export async function action(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	const ctx = await loadMenuOperatorContextFromArgs(args)
	const { organization, menuLocationId, catalogReady } = ctx
	const menuId = args.params.menuId!
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

	if (intent === 'save-menu') {
		const name = formData.get('name')?.toString().trim()
		if (!name) return new Response('Name required', { status: 400 })
		await updateMenu(
			organization.id,
			menuLocationId,
			menuId,
			menuSchema.parse({ name }),
		)
		return { ok: true }
	}
	if (intent === 'add-category') {
		const categoryId = formData.get('categoryId')?.toString()
		if (!categoryId) return new Response('categoryId required', { status: 400 })
		await linkCategoryToMenu(
			organization.id,
			menuLocationId,
			menuId,
			categoryId,
		)
		return { ok: true }
	}
	if (intent === 'remove-category') {
		const categoryId = formData.get('categoryId')?.toString()
		if (!categoryId) return new Response('categoryId required', { status: 400 })
		await unlinkCategoryFromMenu(
			organization.id,
			menuLocationId,
			menuId,
			categoryId,
		)
		return { ok: true }
	}
	return new Response('Unknown intent', { status: 400 })
}

export default function MenuDetailRoute() {
	const { organization, menu, allCategories, catalogReady, canEditMenu } =
		useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state !== 'idle'
	const { menuId: routeMenuId } = useParams()

	if (!catalogReady || !menu) {
		const msg = menuCatalogUnavailableMessage(organization)
		return (
			<MenuCatalogGate
				title={msg.title}
				description={msg.description}
				websiteHref={`/${organization.slug}/website`}
			/>
		)
	}

	const linkedIds = new Set(menu.categories.map((c) => c.id))
	const availableToAdd = allCategories.filter((c) => !linkedIds.has(c.id))
	const reorderAction = `/${organization.slug}/menu/reorder`

	return (
		<div className="flex max-w-2xl flex-col gap-8">
			{canEditMenu ? (
				<Form method="post" className="flex flex-col gap-4">
					<input type="hidden" name="intent" value="save-menu" />
					<div className="space-y-1">
						<Label htmlFor="menu-name">
							<Trans>Menu name</Trans>
						</Label>
						<Input
							id="menu-name"
							name="name"
							defaultValue={menu.name}
							required
						/>
					</div>
					<Button type="submit" disabled={isSubmitting}>
						<Trans>Save menu</Trans>
					</Button>
				</Form>
			) : (
				<h2 className="text-lg font-semibold">{menu.name}</h2>
			)}

			<section className="space-y-3">
				<h3 className="text-sm font-medium">
					<Trans>Categories on this menu</Trans>
				</h3>
				<p className="text-muted-foreground text-sm">
					<Trans>
						Drag to set the order diners see on this menu. Categories are shared
						across menus; this only changes order and membership for “
						{menu.name}”.
					</Trans>
				</p>
				{menu.categories.length ? (
					<MenuReorderList
						rows={menu.categories.map((c) => ({ id: c.id, label: c.name }))}
						reorderAction={reorderAction}
						reorderIntent="reorder-menu-categories"
						extraFields={{ menuId: routeMenuId! }}
						disabled={!canEditMenu || isSubmitting}
					/>
				) : (
					<p className="text-muted-foreground text-sm">
						<Trans>No categories on this menu yet.</Trans>
					</p>
				)}
				{canEditMenu && availableToAdd.length ? (
					<Form method="post" className="flex flex-wrap items-end gap-2">
						<input type="hidden" name="intent" value="add-category" />
						<div className="min-w-[12rem] flex-1 space-y-1">
							<Label>
								<Trans>Add category</Trans>
							</Label>
							<select
								name="categoryId"
								required
								className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
							>
								<option value="">
									<Trans>Select category</Trans>
								</option>
								{availableToAdd.map((c) => (
									<option key={c.id} value={c.id}>
										{c.name}
									</option>
								))}
							</select>
						</div>
						<Button type="submit" disabled={isSubmitting}>
							<Trans>Add</Trans>
						</Button>
					</Form>
				) : null}
				{canEditMenu
					? menu.categories.map((category) => (
							<Form key={category.id} method="post" className="inline">
								<input type="hidden" name="intent" value="remove-category" />
								<input type="hidden" name="categoryId" value={category.id} />
								<Button
									type="submit"
									variant="ghost"
									size="sm"
									disabled={isSubmitting}
								>
									<Trans>Remove {category.name}</Trans>
								</Button>
							</Form>
						))
					: null}
			</section>

			<Button variant="outline" render={<Link to=".." />}>
				<Trans>Back to menus</Trans>
			</Button>
		</div>
	)
}
