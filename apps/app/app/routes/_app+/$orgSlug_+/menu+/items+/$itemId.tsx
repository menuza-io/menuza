import { parseWithZod } from '@conform-to/zod'
import { Trans } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Textarea } from '@repo/ui/textarea'
import { useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Form,
	Link,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { z } from 'zod'

import { menuCatalogUnavailableMessage } from '#app/utils/menu-catalog-messages.ts'
import {
	attachModifierSetToItem,
	createModifierGroup,
	deleteMenuItem,
	detachModifierSetFromItem,
	getMenuItem,
	listCategoriesForLocation,
	listModifierSetsForLocation,
	menuItemSchema,
	updateMenuItem,
} from '#app/utils/menu-catalog.server.ts'
import {
	loadMenuOperatorContext,
	loadMenuOperatorContextFromArgs,
} from '#app/utils/menu-loader.server.ts'
import { MENU_WRITE_PERMISSION } from '#app/utils/menu-permissions.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

import { MenuCatalogGate } from '../components/menu-catalog-gate.tsx'
import { MenuModifierSetPreview } from '../components/menu-modifier-set-preview.tsx'

const ItemActionSchema = z.object({
	intent: z.enum([
		'update-item',
		'delete-item',
		'create-modifier-group',
		'detach-modifier-set',
		'attach-modifier-set',
	]),
	groupId: z.string().optional(),
	modifierSetId: z.string().optional(),
	name: z.string().optional(),
	categoryId: z.string().optional(),
	description: z.string().optional(),
	priceDollars: z.coerce.number().optional(),
	points: z.coerce.number().int().min(0).optional(),
	imageUrl: z.string().optional(),
	calorieMin: z.coerce.number().int().min(0).optional(),
	calorieMax: z.coerce.number().int().min(0).optional(),
	groupName: z.string().optional(),
})

const ITEM_ALLERGENS = [
	'Gluten',
	'Dairy',
	'Eggs',
	'Soy',
	'Peanuts',
	'Tree nuts',
	'Fish',
	'Shellfish',
	'Sesame',
] as const

function optionalNumber(value: string | undefined) {
	if (!value?.trim()) return null
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : null
}

export async function loader(args: LoaderFunctionArgs) {
	const { params } = args
	const ctx = await loadMenuOperatorContextFromArgs(args)
	if (!ctx.catalogReady || !ctx.menuLocationId) {
		return { ...ctx, item: null, categories: [], allModifierSets: [] }
	}
	const [item, categories, allModifierSets] = await Promise.all([
		getMenuItem(ctx.organization.id, ctx.menuLocationId, params.itemId!),
		listCategoriesForLocation(ctx.organization.id, ctx.menuLocationId),
		listModifierSetsForLocation(ctx.organization.id, ctx.menuLocationId),
	])
	return { ...ctx, item, categories, allModifierSets }
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
		return redirectWithToast(
			`/${organization.slug}/menu/items/${params.itemId}`,
			{ type: 'error', title: msg.title, description: msg.description },
		)
	}

	const formData = await request.formData()
	const submission = parseWithZod(formData, { schema: ItemActionSchema })
	if (submission.status !== 'success') return submission.reply()

	const itemUrl = `/${organization.slug}/menu/items/${params.itemId}`
	const listUrl = `/${organization.slug}/menu/items`

	switch (submission.value.intent) {
		case 'update-item': {
			const existing = await getMenuItem(
				organization.id,
				ctx.menuLocationId,
				params.itemId!,
			)
			const priceCents = Math.round((submission.value.priceDollars ?? 0) * 100)
			await updateMenuItem(
				organization.id,
				ctx.menuLocationId,
				params.itemId!,
				menuItemSchema.parse({
					name: submission.value.name ?? existing.name,
					categoryId: submission.value.categoryId ?? existing.categoryId,
					description: submission.value.description || null,
					priceCents,
					imageUrl: submission.value.imageUrl || null,
					points: submission.value.points ?? null,
					alcohol: formData.has('alcohol'),
					glutenFree: formData.has('glutenFree'),
					vegetarian: formData.has('vegetarian'),
					allergens: formData
						.getAll('allergens')
						.map((value) => value.toString()),
					calorieMin: optionalNumber(submission.value.calorieMin?.toString()),
					calorieMax: optionalNumber(submission.value.calorieMax?.toString()),
					popular: formData.has('popular'),
					upsell: formData.has('upsell'),
					taxable: formData.has('taxable'),
					excludeFromThrottle: formData.has('excludeFromThrottle'),
					active: existing.active,
				}),
			)
			return redirectWithToast(itemUrl, {
				type: 'success',
				title: 'Item saved',
				description: '',
			})
		}
		case 'delete-item': {
			await deleteMenuItem(organization.id, ctx.menuLocationId, params.itemId!)
			return redirectWithToast(listUrl, {
				type: 'success',
				title: 'Item deleted',
				description: '',
			})
		}
		case 'create-modifier-group': {
			const group = await createModifierGroup(
				organization.id,
				ctx.menuLocationId,
				{
					menuItemId: params.itemId!,
					name: submission.value.groupName ?? '',
				},
			)
			return redirectWithToast(
				`/${organization.slug}/menu/modifier-groups/${group!.id}`,
				{
					type: 'success',
					title: 'Modifier group created',
					description: '',
				},
			)
		}
		case 'detach-modifier-set': {
			await detachModifierSetFromItem(
				organization.id,
				ctx.menuLocationId,
				params.itemId!,
				submission.value.modifierSetId!,
			)
			return redirectWithToast(itemUrl, {
				type: 'success',
				title: 'Modifier group detached',
				description: '',
			})
		}
		case 'attach-modifier-set': {
			await attachModifierSetToItem(
				organization.id,
				ctx.menuLocationId,
				params.itemId!,
				submission.value.modifierSetId!,
			)
			return redirectWithToast(itemUrl, {
				type: 'success',
				title: 'Modifier group attached',
				description: '',
			})
		}
	}
}

export default function MenuItemDetailPage() {
	const {
		organization,
		item,
		categories,
		allModifierSets,
		catalogReady,
		canEditMenu,
	} = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state !== 'idle'
	const [categoryId, setCategoryId] = useState(item?.categoryId ?? '')

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

	if (!item) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>Item not found.</Trans>
			</p>
		)
	}

	const priceCents = item.priceCents ?? 0
	const selectedAllergens = new Set(item.allergens ?? [])

	return (
		<div className="flex flex-col gap-8">
			<AnnotatedLayout>
				<AnnotatedSection
					title="Item details"
					description="The guest-facing content, price, and dietary information for this item."
				>
					{canEditMenu ? (
						<Form method="post" className="flex max-w-2xl flex-col gap-6">
							<input type="hidden" name="intent" value="update-item" />
							<input type="hidden" name="categoryId" value={categoryId} />
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="space-y-1 sm:col-span-2">
									<Label htmlFor="item-name">Display name</Label>
									<Input
										id="item-name"
										name="name"
										defaultValue={item.name}
										required
									/>
								</div>
								<div className="space-y-1">
									<Label htmlFor="item-category">Category</Label>
									<Select
										value={categoryId}
										onValueChange={(value) => value && setCategoryId(value)}
									>
										<SelectTrigger id="item-category" className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{categories.map((category) => (
												<SelectItem key={category.id} value={category.id}>
													{category.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
								<div className="space-y-1">
									<Label htmlFor="item-price">Price (USD)</Label>
									<Input
										id="item-price"
										name="priceDollars"
										type="number"
										min={0}
										step="0.01"
										defaultValue={(priceCents / 100).toFixed(2)}
										required
									/>
								</div>
								<div className="space-y-1 sm:col-span-2">
									<Label htmlFor="item-description">Description</Label>
									<Textarea
										id="item-description"
										name="description"
										defaultValue={item.description ?? ''}
										rows={4}
										maxLength={1000}
									/>
								</div>
								<div className="space-y-1 sm:col-span-2">
									<Label htmlFor="item-image">Image URL</Label>
									<Input
										id="item-image"
										name="imageUrl"
										type="url"
										defaultValue={item.imageUrl ?? ''}
										placeholder="https://..."
									/>
								</div>
								<div className="space-y-1">
									<Label htmlFor="item-points">Loyalty points</Label>
									<Input
										id="item-points"
										name="points"
										type="number"
										min={0}
										defaultValue={item.points ?? ''}
									/>
								</div>
								<div className="space-y-1">
									<Label htmlFor="item-calories-min">Calories</Label>
									<div className="grid grid-cols-2 gap-2">
										<Input
											id="item-calories-min"
											name="calorieMin"
											type="number"
											min={0}
											placeholder="Min"
											defaultValue={item.calorieMin ?? ''}
										/>
										<Input
											id="item-calories-max"
											name="calorieMax"
											type="number"
											min={0}
											placeholder="Max"
											defaultValue={item.calorieMax ?? ''}
										/>
									</div>
								</div>
							</div>

							<div className="space-y-3">
								<div>
									<p className="text-sm font-medium">
										Dietary and merchandising
									</p>
									<p className="text-muted-foreground text-xs">
										These flags power storefront labels, filters, and upsells.
									</p>
								</div>
								<div className="grid gap-2 sm:grid-cols-2">
									{[
										['alcohol', 'Contains alcohol', item.alcohol],
										['glutenFree', 'Gluten free', item.glutenFree],
										['vegetarian', 'Vegetarian', item.vegetarian],
										['taxable', 'Taxable', item.taxable],
										['popular', 'Popular item', item.popular],
										['upsell', 'Use as an upsell', item.upsell],
										[
											'excludeFromThrottle',
											'Exclude from order throttling',
											item.excludeFromThrottle,
										],
									].map(([name, label, checked]) => (
										<label
											key={name as string}
											className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
										>
											<input
												type="checkbox"
												name={name as string}
												defaultChecked={Boolean(checked)}
											/>
											{label as string}
										</label>
									))}
								</div>
							</div>

							<div className="space-y-2">
								<Label>Allergens</Label>
								<div className="grid gap-2 sm:grid-cols-3">
									{ITEM_ALLERGENS.map((allergen) => (
										<label
											key={allergen}
											className="flex items-center gap-2 text-sm"
										>
											<input
												type="checkbox"
												name="allergens"
												value={allergen}
												defaultChecked={selectedAllergens.has(allergen)}
											/>
											{allergen}
										</label>
									))}
								</div>
							</div>
							<div className="flex flex-wrap gap-2">
								<Button type="submit" disabled={isSubmitting}>
									<Trans>Save item</Trans>
								</Button>
								<Button
									variant="outline"
									render={<Link to={`/${organization.slug}/menu/items`} />}
								>
									<Trans>Back to items</Trans>
								</Button>
							</div>
						</Form>
					) : (
						<dl className="text-sm">
							<dt className="font-medium">{item.name}</dt>
							<dd className="text-muted-foreground mt-1">
								${(priceCents / 100).toFixed(2)}
							</dd>
						</dl>
					)}
				</AnnotatedSection>

				<AnnotatedSection
					title="Modifier groups"
					description="Reusable option sets and the order guests see them."
				>
					{item.modifierSets.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No modifier groups yet.</Trans>
						</p>
					) : (
						<div className="space-y-4">
							{item.modifierSets.map((group) => (
								<div key={group.id} className="space-y-2">
									<MenuModifierSetPreview
										name={group.name}
										displayType={group.displayType}
										minSelections={group.minSelections}
										maxSelections={group.maxSelections}
										options={group.options}
										preselectedOptionIds={group.preselectedOptionIds}
									/>
									<div className="flex items-center justify-end gap-2">
										<Badge variant="outline">
											{group.options.length} options
										</Badge>
										<Link
											to={`/${organization.slug}/menu/modifier-groups/${group.id}`}
											className="text-sm font-medium hover:underline"
										>
											Edit set
										</Link>
										{canEditMenu ? (
											<Form method="post" className="inline">
												<input
													type="hidden"
													name="intent"
													value="detach-modifier-set"
												/>
												<input
													type="hidden"
													name="modifierSetId"
													value={group.id}
												/>
												<Button
													type="submit"
													variant="ghost"
													size="sm"
													disabled={isSubmitting}
												>
													<Trans>Remove</Trans>
												</Button>
											</Form>
										) : null}
									</div>
								</div>
							))}
						</div>
					)}
					{canEditMenu ? (
						<div className="mt-4 flex flex-col gap-4">
							<Form method="post" className="flex flex-wrap items-end gap-2">
								<input
									type="hidden"
									name="intent"
									value="attach-modifier-set"
								/>
								<div className="min-w-[12rem] flex-1 space-y-1">
									<Label htmlFor="attach-set">
										<Trans>Attach existing group</Trans>
									</Label>
									<select
										id="attach-set"
										name="modifierSetId"
										required
										className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
									>
										<option value="">
											<Trans>Select group</Trans>
										</option>
										{allModifierSets
											.filter(
												(set) =>
													!item.modifierSets.some((g) => g.id === set.id),
											)
											.map((set) => (
												<option key={set.id} value={set.id}>
													{set.name}
												</option>
											))}
									</select>
								</div>
								<Button type="submit" disabled={isSubmitting}>
									<Trans>Attach</Trans>
								</Button>
							</Form>
							<Form method="post" className="flex flex-wrap items-end gap-2">
								<input
									type="hidden"
									name="intent"
									value="create-modifier-group"
								/>
								<div className="min-w-[12rem] flex-1 space-y-1">
									<Label htmlFor="group-name">
										<Trans>Create new group</Trans>
									</Label>
									<Input id="group-name" name="groupName" required />
								</div>
								<Button type="submit" disabled={isSubmitting}>
									<Trans>Create &amp; attach</Trans>
								</Button>
							</Form>
						</div>
					) : null}
				</AnnotatedSection>
			</AnnotatedLayout>

			{canEditMenu ? (
				<Form method="post">
					<input type="hidden" name="intent" value="delete-item" />
					<Button type="submit" variant="destructive" disabled={isSubmitting}>
						<Trans>Delete item</Trans>
					</Button>
				</Form>
			) : null}
		</div>
	)
}
