import { parseWithZod } from '@conform-to/zod'
import { Trans } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
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

import {
	createModifierGroup,
	deleteMenuItem,
	deleteModifierGroup,
	getMenuItem,
	listCategoriesForLocation,
	menuItemSchema,
	menuModifierGroupSchema,
	updateMenuItem,
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

const ItemActionSchema = z.object({
	intent: z.enum([
		'update-item',
		'delete-item',
		'create-modifier-group',
		'delete-modifier-group',
	]),
	name: z.string().optional(),
	categoryId: z.string().optional(),
	description: z.string().optional(),
	priceDollars: z.coerce.number().optional(),
	groupName: z.string().optional(),
	groupId: z.string().optional(),
})

export async function loader(args: LoaderFunctionArgs) {
	const { params } = args
	const ctx = await loadMenuOperatorContextFromArgs(args)
	if (!ctx.catalogReady || !ctx.menuLocationId) {
		return { ...ctx, item: null, categories: [] }
	}
	const [item, categories] = await Promise.all([
		getMenuItem(ctx.organization.id, ctx.menuLocationId, params.itemId!),
		listCategoriesForLocation(ctx.organization.id, ctx.menuLocationId),
	])
	return { ...ctx, item, categories }
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
			const priceCents = Math.round((submission.value.priceDollars ?? 0) * 100)
			await updateMenuItem(
				organization.id,
				ctx.menuLocationId,
				params.itemId!,
				menuItemSchema.parse({
					name: submission.value.name,
					categoryId: submission.value.categoryId,
					description: submission.value.description || null,
					priceCents,
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
				menuModifierGroupSchema.parse({
					menuItemId: params.itemId!,
					name: submission.value.groupName,
				}),
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
		case 'delete-modifier-group': {
			await deleteModifierGroup(
				organization.id,
				ctx.menuLocationId,
				submission.value.groupId!,
			)
			return redirectWithToast(itemUrl, {
				type: 'success',
				title: 'Modifier group removed',
				description: '',
			})
		}
	}
}

export default function MenuItemDetailPage() {
	const { organization, item, categories, catalogReady, canEditMenu } =
		useLoaderData<typeof loader>()
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

	return (
		<div className="flex flex-col gap-8">
			<AnnotatedLayout>
				<AnnotatedSection
					title="Item details"
					description="Name, category, and price."
				>
					{canEditMenu ? (
						<Form method="post" className="flex max-w-lg flex-col gap-4">
							<input type="hidden" name="intent" value="update-item" />
							<input type="hidden" name="categoryId" value={categoryId} />
							<div className="space-y-1">
								<Label htmlFor="item-name">
									<Trans>Name</Trans>
								</Label>
								<Input
									id="item-name"
									name="name"
									defaultValue={item.name}
									required
								/>
							</div>
							<div className="space-y-1">
								<Label htmlFor="item-category">
									<Trans>Category</Trans>
								</Label>
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
								<Label htmlFor="item-description">
									<Trans>Description</Trans>
								</Label>
								<Input
									id="item-description"
									name="description"
									defaultValue={item.description ?? ''}
								/>
							</div>
							<div className="space-y-1">
								<Label htmlFor="item-price">
									<Trans>Price (USD)</Trans>
								</Label>
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
					description="Choices diners make when ordering this item."
				>
					{item.modifierGroups.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No modifier groups yet.</Trans>
						</p>
					) : (
						<ul className="divide-y text-sm">
							{item.modifierGroups.map((group) => (
								<li
									key={group.id}
									className="flex items-center justify-between gap-4 py-3"
								>
									<Link
										to={`/${organization.slug}/menu/modifier-groups/${group.id}`}
										className="font-medium hover:underline"
									>
										{group.name}
									</Link>
									<span className="text-muted-foreground">
										{group.options.length} <Trans>options</Trans>
									</span>
									{canEditMenu ? (
										<Form method="post" className="inline">
											<input
												type="hidden"
												name="intent"
												value="delete-modifier-group"
											/>
											<input type="hidden" name="groupId" value={group.id} />
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
								</li>
							))}
						</ul>
					)}
					{canEditMenu ? (
						<Form method="post" className="mt-4 flex flex-wrap items-end gap-2">
							<input
								type="hidden"
								name="intent"
								value="create-modifier-group"
							/>
							<div className="min-w-[12rem] flex-1 space-y-1">
								<Label htmlFor="group-name">
									<Trans>New modifier group</Trans>
								</Label>
								<Input id="group-name" name="groupName" required />
							</div>
							<Button type="submit" disabled={isSubmitting}>
								<Trans>Add group</Trans>
							</Button>
						</Form>
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
