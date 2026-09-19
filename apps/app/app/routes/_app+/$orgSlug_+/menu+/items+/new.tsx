import { parseWithZod } from '@conform-to/zod'
import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
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

import { menuCatalogUnavailableMessage } from '#app/utils/menu-catalog-messages.ts'
import {
	createMenuItem,
	listCategoriesForLocation,
	menuItemSchema,
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
	MenuEditorCard,
	MenuLocalizedInput,
	MenuLocalizedTextarea,
	MenuResourceEditorPage,
} from '../components/menu-resource-editor.tsx'

const CreateItemSchema = z.object({
	name: z.string().trim().min(1),
	nameI18n: z.string().optional(),
	categoryId: z.string().min(1),
	description: z.string().optional(),
	descriptionI18n: z.string().optional(),
	priceDollars: z.coerce.number().min(0),
	points: z.coerce.number().int().min(0).optional(),
	imageUrl: z.string().optional(),
	calorieMin: z.coerce.number().int().min(0).optional(),
	calorieMax: z.coerce.number().int().min(0).optional(),
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

const ITEM_ALLERGEN_LABELS = {
	Gluten: <Trans>Gluten</Trans>,
	Dairy: <Trans>Dairy</Trans>,
	Eggs: <Trans>Eggs</Trans>,
	Soy: <Trans>Soy</Trans>,
	Peanuts: <Trans>Peanuts</Trans>,
	'Tree nuts': <Trans>Tree nuts</Trans>,
	Fish: <Trans>Fish</Trans>,
	Shellfish: <Trans>Shellfish</Trans>,
	Sesame: <Trans>Sesame</Trans>,
} as const

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
			name: pickLocalized(
				submission.value.nameI18n ?? submission.value.name,
				ctx.localesConfig.defaultLocale,
				ctx.localesConfig.defaultLocale,
			),
			nameI18n: serializeLocalizedString(
				parseLocalizedString(
					submission.value.nameI18n ?? submission.value.name,
					ctx.localesConfig.defaultLocale,
				),
			),
			categoryId: submission.value.categoryId,
			description:
				pickLocalized(
					submission.value.descriptionI18n ?? submission.value.description,
					ctx.localesConfig.defaultLocale,
					ctx.localesConfig.defaultLocale,
				) || null,
			descriptionI18n: serializeLocalizedString(
				parseLocalizedString(
					submission.value.descriptionI18n ?? submission.value.description,
					ctx.localesConfig.defaultLocale,
				),
			),
			priceCents,
			imageUrl: submission.value.imageUrl || null,
			points: submission.value.points ?? null,
			alcohol: formData.has('alcohol'),
			glutenFree: formData.has('glutenFree'),
			vegetarian: formData.has('vegetarian'),
			allergens: formData.getAll('allergens').map((value) => value.toString()),
			calorieMin: submission.value.calorieMin ?? null,
			calorieMax: submission.value.calorieMax ?? null,
			popular: formData.has('popular'),
			upsell: formData.has('upsell'),
			taxable: formData.has('taxable'),
			excludeFromThrottle: formData.has('excludeFromThrottle'),
		}),
	)
	return redirectWithToast(`/${organization.slug}/menu/items/${item!.id}`, {
		type: 'success',
		title: t`Item created`,
		description: '',
	})
}

export default function NewMenuItemPage() {
	const { organization, categories, catalogReady, localesConfig } =
		useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const navigation = useNavigation()
	const isSubmitting = navigation.state !== 'idle'
	const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '')
	const [nameI18n, setNameI18n] = useState('')
	const [descriptionI18n, setDescriptionI18n] = useState('')

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
		<MenuResourceEditorPage
			title={<Trans>New item</Trans>}
			description={<Trans>Add a menu item to your catalog.</Trans>}
			localesConfig={localesConfig}
			backHref={`/${organization.slug}/menu/items`}
		>
			<MenuEditorCard
				title={<Trans>New item</Trans>}
				description={<Trans>Add a menu item to your catalog.</Trans>}
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
					<Form method="post" className="flex max-w-2xl flex-col gap-6">
						<input type="hidden" name="categoryId" value={categoryId} />
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="sm:col-span-2">
								<MenuLocalizedInput
									label={<Trans>Display name</Trans>}
									name="name"
									value={nameI18n}
									onChange={setNameI18n}
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
										<SelectValue placeholder={_(t`Select category`)} />
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
							<div className="sm:col-span-2">
								<MenuLocalizedTextarea
									label={<Trans>Description</Trans>}
									name="description"
									value={descriptionI18n}
									onChange={setDescriptionI18n}
									rows={4}
								/>
							</div>
							<div className="space-y-1 sm:col-span-2">
								<Label htmlFor="item-image">
									<Trans>Image URL</Trans>
								</Label>
								<Input id="item-image" name="imageUrl" type="url" />
							</div>
							<div className="space-y-1">
								<Label htmlFor="item-points">
									<Trans>Loyalty points</Trans>
								</Label>
								<Input id="item-points" name="points" type="number" min={0} />
							</div>
							<div className="space-y-1">
								<Label>
									<Trans>Calories</Trans>
								</Label>
								<div className="grid grid-cols-2 gap-2">
									<Input
										name="calorieMin"
										type="number"
										min={0}
										placeholder="Min"
									/>
									<Input
										name="calorieMax"
										type="number"
										min={0}
										placeholder="Max"
									/>
								</div>
							</div>
						</div>
						<div className="grid gap-2 sm:grid-cols-2">
							{[
								{
									name: 'alcohol',
									label: <Trans>Contains alcohol</Trans>,
								},
								{
									name: 'glutenFree',
									label: <Trans>Gluten free</Trans>,
								},
								{
									name: 'vegetarian',
									label: <Trans>Vegetarian</Trans>,
								},
								{ name: 'taxable', label: <Trans>Taxable</Trans> },
								{ name: 'popular', label: <Trans>Popular item</Trans> },
								{ name: 'upsell', label: <Trans>Use as an upsell</Trans> },
								{
									name: 'excludeFromThrottle',
									label: <Trans>Exclude from order throttling</Trans>,
								},
							].map(({ name, label }) => (
								<label
									key={name}
									className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
								>
									<input
										type="checkbox"
										name={name}
										defaultChecked={name === 'taxable'}
									/>
									{label}
								</label>
							))}
						</div>
						<div className="space-y-2">
							<Label>
								<Trans>Allergens</Trans>
							</Label>
							<div className="grid gap-2 sm:grid-cols-3">
								{ITEM_ALLERGENS.map((allergen) => (
									<label
										key={allergen}
										className="flex items-center gap-2 text-sm"
									>
										<input type="checkbox" name="allergens" value={allergen} />
										{ITEM_ALLERGEN_LABELS[allergen]}
									</label>
								))}
							</div>
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
			</MenuEditorCard>
		</MenuResourceEditorPage>
	)
}
