import { parseWithZod } from '@conform-to/zod'
import { Trans } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
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
	Link,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { z } from 'zod'

import {
	createMenuCategory,
	deleteMenuCategory,
	listCategoriesForLocation,
	menuCategorySchema,
	setMenuCategoryActive,
	updateMenuCategory,
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
import { MenuEditorSheet } from '../components/menu-editor-sheet.tsx'
import {
	MenuListHeader,
	MenuTableShell,
} from '../components/menu-list-header.tsx'
import { MenuReorderList } from '../components/menu-reorder-list.tsx'
import { useMenuListSearch } from '../components/use-menu-list-search.ts'

const CategoryActionSchema = z.object({
	intent: z.enum(['create', 'update', 'delete', 'toggle-active']),
	categoryId: z.string().optional(),
	name: z.string().optional(),
	active: z.coerce.boolean().optional(),
})

export async function loader(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	const ctx = await loadMenuOperatorContextFromArgs(args)
	const categories =
		ctx.catalogReady && ctx.menuLocationId
			? await listCategoriesForLocation(ctx.organization.id, ctx.menuLocationId)
			: []
	return { ...ctx, categories }
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
		return redirectWithToast(`/${organization.slug}/menu/categories`, {
			type: 'error',
			title: msg.title,
			description: msg.description,
		})
	}

	const formData = await request.formData()
	const submission = parseWithZod(formData, { schema: CategoryActionSchema })
	if (submission.status !== 'success') return submission.reply()

	const { menuLocationId } = ctx
	const base = `/${organization.slug}/menu/categories`

	switch (submission.value.intent) {
		case 'create': {
			await createMenuCategory(
				organization.id,
				menuLocationId,
				menuCategorySchema.parse({ name: submission.value.name }),
			)
			return redirectWithToast(base, {
				type: 'success',
				title: 'Category added',
				description: '',
			})
		}
		case 'update': {
			await updateMenuCategory(
				organization.id,
				menuLocationId,
				submission.value.categoryId!,
				menuCategorySchema.parse({ name: submission.value.name }),
			)
			return redirectWithToast(base, {
				type: 'success',
				title: 'Category updated',
				description: '',
			})
		}
		case 'delete': {
			await deleteMenuCategory(
				organization.id,
				menuLocationId,
				submission.value.categoryId!,
			)
			return redirectWithToast(base, {
				type: 'success',
				title: 'Category deleted',
				description: '',
			})
		}
		case 'toggle-active': {
			const all = await listCategoriesForLocation(
				organization.id,
				menuLocationId,
			)
			const category = all.find((c) => c.id === submission.value.categoryId)
			if (!category) break
			await setMenuCategoryActive(
				organization.id,
				menuLocationId,
				category.id,
				!category.active,
			)
			return redirectWithToast(base, {
				type: 'success',
				title: 'Category updated',
				description: '',
			})
		}
	}
}

export default function MenuCategoriesPage() {
	const {
		organization,
		categories,
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
	const [createOpen, setCreateOpen] = useState(false)

	const filteredCategories = useMemo(() => {
		const needle = query.toLowerCase()
		return categories.filter((category) => {
			if (needle && !category.name.toLowerCase().includes(needle)) return false
			if (availabilityFilter === 'available' && !category.active) return false
			if (availabilityFilter === 'unavailable' && category.active) return false
			return true
		})
	}, [categories, query, availabilityFilter])

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

	const scopeSubtitle =
		operatorContext === 'branch' ? (
			<Trans>Location scope</Trans>
		) : (
			<Trans>Brand scope — default location</Trans>
		)

	return (
		<div className="flex flex-col gap-6">
			<MenuListHeader
				title={<Trans>Categories</Trans>}
				subtitle={scopeSubtitle}
				searchQuery={query}
				onSearchChange={setQuery}
				searchPlaceholder="Search categories"
				createLabel={<Trans>Create category</Trans>}
				canCreate={canEditMenu}
				createOnClick={() => setCreateOpen(true)}
				availabilityFilter={availabilityFilter}
				onAvailabilityFilterChange={setAvailabilityFilter}
			/>

			{categories.length > 0 ? (
				<section className="space-y-2">
					<h3 className="text-sm font-medium">
						<Trans>Category order</Trans>
					</h3>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Drag to set display order (applies to your default menu and new
							menus).
						</Trans>
					</p>
					<MenuReorderList
						rows={categories.map((c) => ({ id: c.id, label: c.name }))}
						reorderAction={`/${organization.slug}/menu/reorder`}
						reorderIntent="reorder-categories"
						disabled={!canEditMenu || isSubmitting}
					/>
				</section>
			) : null}

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
								<TableHead className="text-end">
									<Trans>Actions</Trans>
								</TableHead>
							) : null}
						</TableRow>
					</TableHeader>
					<TableBody>
						{filteredCategories.length === 0 ? (
							<TableRow>
								<TableCell colSpan={canEditMenu ? 3 : 2}>
									<p className="text-muted-foreground px-4 py-12 text-center text-sm">
										{query ? (
											<Trans>
												Nothing matches your search. Try another term or clear
												filters.
											</Trans>
										) : (
											<Trans>No categories yet.</Trans>
										)}
									</p>
								</TableCell>
							</TableRow>
						) : (
							filteredCategories.map((category) => (
								<TableRow key={category.id}>
									<TableCell className="font-medium">{category.name}</TableCell>
									<TableCell>
										{category.active ? (
											<Badge variant="secondary">
												<Trans>Visible</Trans>
											</Badge>
										) : (
											<Badge variant="outline">
												<Trans>Hidden</Trans>
											</Badge>
										)}
									</TableCell>
									{canEditMenu ? (
										<TableCell className="text-end">
											<div className="flex flex-wrap justify-end gap-2">
												<Form method="post" className="inline">
													<input
														type="hidden"
														name="intent"
														value="toggle-active"
													/>
													<input
														type="hidden"
														name="categoryId"
														value={category.id}
													/>
													<Button
														type="submit"
														variant="outline"
														size="sm"
														disabled={isSubmitting}
													>
														{category.active ? (
															<Trans>Hide</Trans>
														) : (
															<Trans>Show</Trans>
														)}
													</Button>
												</Form>
												<Form method="post" className="inline">
													<input type="hidden" name="intent" value="delete" />
													<input
														type="hidden"
														name="categoryId"
														value={category.id}
													/>
													<Button
														type="submit"
														variant="ghost"
														size="sm"
														disabled={isSubmitting}
													>
														<Trans>Delete</Trans>
													</Button>
												</Form>
											</div>
										</TableCell>
									) : null}
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</MenuTableShell>

			<MenuEditorSheet
				open={createOpen}
				title={<Trans>Create category</Trans>}
				operatorContext={operatorContext}
				onClose={() => setCreateOpen(false)}
				footer={
					<div className="flex justify-end gap-2 border-t px-4 py-3">
						<Button
							variant="outline"
							type="button"
							onClick={() => setCreateOpen(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							form="create-category-form"
							disabled={isSubmitting}
						>
							<Trans>Save</Trans>
						</Button>
					</div>
				}
			>
				<Form method="post" id="create-category-form" className="space-y-4">
					<input type="hidden" name="intent" value="create" />
					<div className="space-y-1">
						<Label htmlFor="new-category-name">
							<Trans>Display name</Trans>
						</Label>
						<Input id="new-category-name" name="name" required />
					</div>
				</Form>
			</MenuEditorSheet>

			<p className="text-muted-foreground text-sm">
				<Trans>
					<Link to={`/${organization.slug}/menu/items`}>Manage items</Link> in
					each category.
				</Trans>
			</p>
		</div>
	)
}
