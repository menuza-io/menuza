import { parseWithZod } from '@conform-to/zod'
import { Trans, t } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import {
	parseLocalizedString,
	pickLocalized,
	serializeLocalizedString,
} from '@repo/common/site-locales'
import { redirectWithToast } from '@repo/common/toast'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useState } from 'react'
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
import {
	MenuEditorCard,
	MenuEditorSidebarCard,
	MenuLocalizedInput,
	MenuLocalizedTextarea,
	MenuResourceEditorPage,
} from '../components/menu-resource-editor.tsx'

const CategoryDetailActionSchema = z.object({
	intent: z.enum(['save-category', 'delete-category']),
	name: z.string().optional(),
	nameI18n: z.string().optional(),
	description: z.string().optional(),
	descriptionI18n: z.string().optional(),
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
			name: pickLocalized(
				submission.value.nameI18n || submission.value.name,
				ctx.localesConfig.defaultLocale,
				ctx.localesConfig.defaultLocale,
			),
			nameI18n: serializeLocalizedString(
				parseLocalizedString(
					submission.value.nameI18n || submission.value.name,
					ctx.localesConfig.defaultLocale,
				),
			),
			description:
				pickLocalized(
					submission.value.descriptionI18n || submission.value.description,
					ctx.localesConfig.defaultLocale,
					ctx.localesConfig.defaultLocale,
				) || null,
			descriptionI18n: serializeLocalizedString(
				parseLocalizedString(
					submission.value.descriptionI18n || submission.value.description,
					ctx.localesConfig.defaultLocale,
				),
			),
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
		localesConfig,
	} = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state !== 'idle'
	const [nameI18n, setNameI18n] = useState(
		category?.nameI18n ?? category?.name ?? '',
	)
	const [descriptionI18n, setDescriptionI18n] = useState(
		category?.descriptionI18n ?? category?.description ?? '',
	)

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
		<MenuResourceEditorPage
			title={<Trans>Edit category</Trans>}
			description={
				<Trans>Manage how this category appears across your storefront.</Trans>
			}
			localesConfig={localesConfig}
			backHref={`${base}/categories`}
			sidebar={
				canEditMenu ? (
					<MenuEditorSidebarCard title={<Trans>Danger zone</Trans>}>
						<Form method="post">
							<input type="hidden" name="intent" value="delete-category" />
							<Button
								type="submit"
								variant="destructive"
								disabled={isSubmitting}
							>
								<Trans>Delete category</Trans>
							</Button>
						</Form>
					</MenuEditorSidebarCard>
				) : null
			}
		>
			<Form method="post" className="space-y-6">
				<input type="hidden" name="intent" value="save-category" />
				<MenuEditorCard
					title={<Trans>Category details</Trans>}
					description={
						<Trans>
							Control the category name, description, availability, and
							merchandising.
						</Trans>
					}
				>
					{canEditMenu ? (
						<div className="space-y-5">
							<MenuLocalizedInput
								label={<Trans>Display name</Trans>}
								name="name"
								value={nameI18n}
								onChange={setNameI18n}
								required
							/>
							<MenuLocalizedTextarea
								label={<Trans>Description</Trans>}
								name="description"
								value={descriptionI18n}
								onChange={setDescriptionI18n}
								rows={4}
							/>
							<div className="space-y-1.5">
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
						</div>
					) : (
						<dl className="text-sm">
							<dt className="font-medium">{category.name}</dt>
							<dd className="text-muted-foreground mt-1">
								{category.description ?? <Trans>No description</Trans>}
							</dd>
						</dl>
					)}
				</MenuEditorCard>

				<MenuEditorCard
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
				</MenuEditorCard>
				{canEditMenu ? (
					<div className="flex justify-end">
						<Button type="submit" disabled={isSubmitting}>
							<Trans>Save category</Trans>
						</Button>
					</div>
				) : null}
			</Form>
		</MenuResourceEditorPage>
	)
}
