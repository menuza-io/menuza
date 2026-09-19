import { parseWithZod } from '@conform-to/zod'
import { Trans, t } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Textarea } from '@repo/ui/textarea'
import { Form, Link, useLoaderData, useNavigation } from 'react-router'
import { z } from 'zod'

import { menuCatalogUnavailableMessage } from '#app/utils/menu-catalog-messages.ts'
import {
	deleteMenuCategory,
	listCategoriesForLocation,
	listItemsForLocation,
	menuCategorySchema,
	updateMenuCategory,
} from '#app/utils/menu-catalog.server.ts'
import { loadMenuOperatorContextFromArgs } from '#app/utils/menu-loader.server.ts'
import { MENU_WRITE_PERMISSION } from '#app/utils/menu-permissions.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

import { MenuCatalogGate } from '../components/menu-catalog-gate.tsx'
import { MenuReorderList } from '../components/menu-reorder-list.tsx'

const CategoryDetailActionSchema = z.object({
	intent: z.enum(['save-category', 'delete-category']),
	name: z.string().optional(),
	description: z.string().optional(),
	imageUrl: z.string().optional(),
})

export async function loader(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	const ctx = await loadMenuOperatorContextFromArgs(args)
	if (!ctx.catalogReady || !ctx.menuLocationId) {
		return { ...ctx, category: null, items: [], categories: [] }
	}
	const [categories, items] = await Promise.all([
		listCategoriesForLocation(ctx.organization.id, ctx.menuLocationId),
		listItemsForLocation(
			ctx.organization.id,
			ctx.menuLocationId,
			args.params.categoryId,
		),
	])
	return {
		...ctx,
		category:
			categories.find((category) => category.id === args.params.categoryId) ??
			null,
		categories,
		items,
	}
}

export async function action(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	const { request, params } = args
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
	const ctx = await loadMenuOperatorContextFromArgs(args)
	if (!ctx.catalogReady || !ctx.menuLocationId) {
		const msg = menuCatalogUnavailableMessage(organization)
		return redirectWithToast(
			`/${organization.slug}/menu/categories/${params.categoryId}`,
			{ type: 'error', title: msg.title, description: msg.description },
		)
	}

	const formData = await request.formData()
	const submission = parseWithZod(formData, {
		schema: CategoryDetailActionSchema,
	})
	if (submission.status !== 'success') return submission.reply()

	const detailUrl = `/${organization.slug}/menu/categories/${params.categoryId}`
	if (submission.value.intent === 'delete-category') {
		await deleteMenuCategory(
			organization.id,
			ctx.menuLocationId,
			params.categoryId!,
		)
		return redirectWithToast(`/${organization.slug}/menu/categories`, {
			type: 'success',
			title: t`Category deleted`,
			description: '',
		})
	}

	await updateMenuCategory(
		organization.id,
		ctx.menuLocationId,
		params.categoryId!,
		menuCategorySchema.parse({
			name: submission.value.name,
			description: submission.value.description || null,
			imageUrl: submission.value.imageUrl || null,
			upsellCategoryIds: formData
				.getAll('upsellCategoryIds')
				.map((value) => value.toString()),
			active: formData.has('active'),
		}),
	)
	return redirectWithToast(detailUrl, {
		type: 'success',
		title: t`Category saved`,
		description: '',
	})
}

export default function CategoryDetailPage() {
	const {
		organization,
		category,
		items,
		categories,
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

	if (!category) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>Category not found.</Trans>
			</p>
		)
	}

	const otherCategories = categories.filter(
		(candidate) => candidate.id !== category.id,
	)
	const upsellCategoryIds = new Set(category.upsellCategoryIds ?? [])
	const base = `/${organization.slug}/menu`

	return (
		<div className="flex flex-col gap-8">
			<AnnotatedLayout>
				<AnnotatedSection
					title={<Trans>Category details</Trans>}
					description={
						<Trans>
							Control the category name, description, availability, and
							merchandising.
						</Trans>
					}
				>
					{canEditMenu ? (
						<Form method="post" className="flex max-w-2xl flex-col gap-5">
							<input type="hidden" name="intent" value="save-category" />
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="space-y-1 sm:col-span-2">
									<Label htmlFor="category-name">
										<Trans>Display name</Trans>
									</Label>
									<Input
										id="category-name"
										name="name"
										defaultValue={category.name}
										required
									/>
								</div>
								<div className="space-y-1 sm:col-span-2">
									<Label htmlFor="category-description">
										<Trans>Description</Trans>
									</Label>
									<Textarea
										id="category-description"
										name="description"
										defaultValue={category.description ?? ''}
										rows={4}
										maxLength={500}
									/>
								</div>
								<div className="space-y-1 sm:col-span-2">
									<Label htmlFor="category-image">
										<Trans>Image URL</Trans>
									</Label>
									<Input
										id="category-image"
										name="imageUrl"
										type="url"
										defaultValue={category.imageUrl ?? ''}
										placeholder="https://..."
									/>
								</div>
							</div>
							<label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
								<input
									type="checkbox"
									name="active"
									defaultChecked={category.active}
								/>
								<Trans>Available to guests</Trans>
							</label>
							<div className="space-y-2">
								<div>
									<p className="text-sm font-medium">
										<Trans>Upsell categories</Trans>
									</p>
									<p className="text-muted-foreground text-xs">
										<Trans>
											Shown after a guest adds an item from this category.
										</Trans>
									</p>
								</div>
								<div className="grid gap-2 sm:grid-cols-2">
									{otherCategories.map((candidate) => (
										<label
											key={candidate.id}
											className="flex items-center gap-2 text-sm"
										>
											<input
												type="checkbox"
												name="upsellCategoryIds"
												value={candidate.id}
												defaultChecked={upsellCategoryIds.has(candidate.id)}
											/>
											{candidate.name}
										</label>
									))}
								</div>
							</div>
							<div className="flex flex-wrap gap-2">
								<Button type="submit" disabled={isSubmitting}>
									<Trans>Save category</Trans>
								</Button>
								<Button
									variant="outline"
									render={<Link to={`${base}/categories`} />}
								>
									<Trans>Back to categories</Trans>
								</Button>
							</div>
						</Form>
					) : (
						<dl className="text-sm">
							<dt className="font-medium">{category.name}</dt>
							<dd className="text-muted-foreground mt-1">
								{category.description ?? <Trans>No description</Trans>}
							</dd>
						</dl>
					)}
				</AnnotatedSection>

				<AnnotatedSection
					title={<Trans>Items</Trans>}
					description={
						<Trans>Items in this category, in the order guests see them.</Trans>
					}
				>
					{items.length ? (
						<MenuReorderList
							rows={items.map((item) => ({ id: item.id, label: item.name }))}
							reorderAction={`/${organization.slug}/menu/reorder`}
							reorderIntent="reorder-items"
							extraFields={{ categoryId: category.id }}
							disabled={!canEditMenu || isSubmitting}
						/>
					) : (
						<p className="text-muted-foreground text-sm">
							<Trans>No items in this category yet.</Trans>
						</p>
					)}
					{canEditMenu ? (
						<Button
							className="mt-4"
							variant="outline"
							render={<Link to={`${base}/items/new`} />}
						>
							<Trans>Add item</Trans>
						</Button>
					) : null}
				</AnnotatedSection>
			</AnnotatedLayout>

			{canEditMenu ? (
				<Form method="post">
					<input type="hidden" name="intent" value="delete-category" />
					<Button type="submit" variant="destructive" disabled={isSubmitting}>
						<Trans>Delete category</Trans>
					</Button>
				</Form>
			) : null}
		</div>
	)
}
