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
	Form,
	Link,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { z } from 'zod'

import {
	createMenuItem,
	listCategoriesForLocation,
	menuItemSchema,
} from '#app/utils/menu-catalog.server.ts'
import {
	loadMenuOperatorContext,
	loadMenuOperatorContextFromArgs,
	menuCatalogUnavailableMessage,
} from '#app/utils/menu-loader.server.ts'
import { MENU_WRITE_PERMISSION } from '#app/utils/menu-permissions.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

import { MenuCatalogGate } from '../components/menu-catalog-gate.tsx'

const CreateItemSchema = z.object({
	name: z.string().trim().min(1),
	categoryId: z.string().min(1),
	description: z.string().optional(),
	priceDollars: z.coerce.number().min(0),
})

export async function loader(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	const ctx = await loadMenuOperatorContextFromArgs(args)
	if (!ctx.canEditMenu) {
		throw new Response('Forbidden', { status: 403 })
	}
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
		return redirectWithToast(`/${organization.slug}/menu/items/new`, {
			type: 'error',
			title: msg.title,
			description: msg.description,
		})
	}

	const formData = await request.formData()
	const submission = parseWithZod(formData, { schema: CreateItemSchema })
	if (submission.status !== 'success') return submission.reply()

	const priceCents = Math.round(submission.value.priceDollars * 100)
	const item = await createMenuItem(
		organization.id,
		ctx.menuLocationId,
		menuItemSchema.parse({
			name: submission.value.name,
			categoryId: submission.value.categoryId,
			description: submission.value.description || null,
			priceCents,
		}),
	)
	return redirectWithToast(`/${organization.slug}/menu/items/${item!.id}`, {
		type: 'success',
		title: 'Item created',
		description: '',
	})
}

export default function NewMenuItemPage() {
	const { organization, categories, catalogReady } =
		useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state !== 'idle'
	const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '')

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
		<AnnotatedLayout>
			<AnnotatedSection
				title="New item"
				description="Add a menu item to your catalog."
			>
				{categories.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>
							Create a{' '}
							<Link to={`/${organization.slug}/menu/categories`}>category</Link>{' '}
							first.
						</Trans>
					</p>
				) : (
					<Form method="post" className="flex max-w-lg flex-col gap-4">
						<input type="hidden" name="categoryId" value={categoryId} />
						<div className="space-y-1">
							<Label htmlFor="item-name">
								<Trans>Name</Trans>
							</Label>
							<Input id="item-name" name="name" required />
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
									<SelectValue placeholder="Select category" />
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
							<Input id="item-description" name="description" />
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
								required
							/>
						</div>
						<div className="flex gap-2">
							<Button type="submit" disabled={isSubmitting}>
								<Trans>Create item</Trans>
							</Button>
							<Button
								variant="outline"
								render={<Link to={`/${organization.slug}/menu/items`} />}
							>
								<Trans>Cancel</Trans>
							</Button>
						</div>
					</Form>
				)}
			</AnnotatedSection>
		</AnnotatedLayout>
	)
}
