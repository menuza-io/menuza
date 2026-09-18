import { parseWithZod } from '@conform-to/zod'
import { requireUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Form,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'

import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ensureDefaultOrganizationLocation } from '#app/utils/organization/locations.server.ts'
import {
	createMenuCategory,
	createMenuItem,
	listMenuForLocation,
	menuCategorySchema,
	menuItemSchema,
	resolveMenuLocationId,
} from '#app/utils/menu.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'

const MenuActionSchema = z.object({
	intent: z.enum(['create-category', 'create-item']),
	name: z.string().optional(),
	categoryId: z.string().optional(),
	priceCents: z.coerce.number().optional(),
})

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		hasProvisionedDb: true,
		dataRegion: true,
	})

	const locationId = await resolveMenuLocationId(organization.id)
	const menu =
		organization.hasProvisionedDb && organization.dataRegion === 'us'
			? await listMenuForLocation(organization.id, locationId)
			: { categories: [] }

	return { organization, locationId, menu }
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserWithOrganizationPermission(
		request,
		params.orgSlug,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
		{ id: true, hasProvisionedDb: true, dataRegion: true },
	)

	if (!organization.hasProvisionedDb || organization.dataRegion !== 'us') {
		return redirectWithToast(`/${params.orgSlug}/settings/menu`, {
			type: 'error',
			title: 'Publish your restaurant site first',
		})
	}

	const formData = await request.formData()
	const submission = parseWithZod(formData, { schema: MenuActionSchema })
	if (submission.status !== 'success') {
		return submission.reply()
	}

	const locationId = await resolveMenuLocationId(organization.id)

	if (submission.value.intent === 'create-category') {
		await createMenuCategory(
			organization.id,
			locationId,
			menuCategorySchema.parse({ name: submission.value.name }),
		)
		return redirectWithToast(`/${organization.slug}/settings/menu`, {
			type: 'success',
			title: 'Category added',
		})
	}

	await createMenuItem(
		organization.id,
		locationId,
		menuItemSchema.parse({
			categoryId: submission.value.categoryId,
			name: submission.value.name,
			priceCents: submission.value.priceCents,
		}),
	)
	return redirectWithToast(`/${organization.slug}/settings/menu`, {
		type: 'success',
		title: 'Menu item added',
	})
}

export default function RestaurantMenuSettings() {
	const { menu, locationId } = useLoaderData<typeof loader>()

	return (
		<AnnotatedLayout>
			<AnnotatedSection
				title="Menu"
				description="Build your restaurant menu for the default location. Per-location menu overrides can follow in a later release."
			>
				<p className="text-muted-foreground mb-4 text-sm">
					Location ID: <code className="text-xs">{locationId}</code>
				</p>

				<div className="mb-8 space-y-4">
					{menu.categories.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							No categories yet. Add your first category below.
						</p>
					) : (
						menu.categories.map((category) => (
							<div key={category.id} className="rounded-lg border p-4">
								<h3 className="font-medium">{category.name}</h3>
								<ul className="mt-2 space-y-1 text-sm">
									{category.items.map((item) => (
										<li key={item.id}>
											{item.name} — ${(item.priceCents / 100).toFixed(2)}
										</li>
									))}
								</ul>
							</div>
						))
					)}
				</div>

				<div className="grid gap-6 md:grid-cols-2">
					<Form method="post" className="space-y-3 rounded-lg border p-4">
						<input type="hidden" name="intent" value="create-category" />
						<p className="font-medium">New category</p>
						<div className="space-y-1">
							<Label htmlFor="category-name">Name</Label>
							<Input id="category-name" name="name" required />
						</div>
						<Button type="submit">Add category</Button>
					</Form>

					<Form method="post" className="space-y-3 rounded-lg border p-4">
						<input type="hidden" name="intent" value="create-item" />
						<p className="font-medium">New item</p>
						<div className="space-y-1">
							<Label htmlFor="item-category">Category</Label>
							<select
								id="item-category"
								name="categoryId"
								className="border-input bg-background flex h-10 w-full rounded-md border px-3 text-sm"
								required
							>
								<option value="">Select…</option>
								{menu.categories.map((category) => (
									<option key={category.id} value={category.id}>
										{category.name}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-1">
							<Label htmlFor="item-name">Name</Label>
							<Input id="item-name" name="name" required />
						</div>
						<div className="space-y-1">
							<Label htmlFor="item-price">Price (cents)</Label>
							<Input
								id="item-price"
								name="priceCents"
								type="number"
								min={0}
								required
							/>
						</div>
						<Button type="submit">Add item</Button>
					</Form>
				</div>
			</AnnotatedSection>
		</AnnotatedLayout>
	)
}
