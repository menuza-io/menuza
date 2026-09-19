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
	createModifierOption,
	deleteModifierGroup,
	deleteModifierOption,
	getModifierGroup,
	menuModifierOptionSchema,
	menuModifierSetSchema,
	updateModifierGroup,
	updateModifierOption,
} from '#app/utils/menu-catalog.server.ts'
import {
	loadMenuOperatorContext,
	loadMenuOperatorContextFromArgs,
} from '#app/utils/menu-loader.server.ts'
import { MENU_WRITE_PERMISSION } from '#app/utils/menu-permissions.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

import { MenuCatalogGate } from '../components/menu-catalog-gate.tsx'
import { MenuReorderList } from '../components/menu-reorder-list.tsx'

const GroupActionSchema = z.object({
	intent: z.enum([
		'update-group',
		'delete-group',
		'create-option',
		'update-option',
		'delete-option',
	]),
	name: z.string().optional(),
	minSelections: z.coerce.number().optional(),
	maxSelections: z.coerce.number().optional(),
	required: z.coerce.boolean().optional(),
	displayType: z
		.enum([
			'single-select',
			'multi-select',
			'quantity-select',
			'pizza-topping',
			'custom',
		])
		.optional(),
	optionName: z.string().optional(),
	optionDescription: z.string().optional(),
	priceDollars: z.coerce.number().optional(),
	optionId: z.string().optional(),
})

export async function loader(args: LoaderFunctionArgs) {
	const { params } = args
	const ctx = await loadMenuOperatorContextFromArgs(args)
	if (!ctx.catalogReady || !ctx.menuLocationId) {
		return { ...ctx, group: null }
	}
	const group = await getModifierGroup(
		ctx.organization.id,
		ctx.menuLocationId,
		params.groupId!,
	)
	return { ...ctx, group }
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
			`/${organization.slug}/menu/modifier-groups/${params.groupId}`,
			{ type: 'error', title: msg.title, description: msg.description },
		)
	}

	const formData = await request.formData()
	const submission = parseWithZod(formData, { schema: GroupActionSchema })
	if (submission.status !== 'success') return submission.reply()

	const groupUrl = `/${organization.slug}/menu/modifier-groups/${params.groupId}`

	switch (submission.value.intent) {
		case 'update-group': {
			const minSelections = submission.value.minSelections ?? 0
			const maxSelections =
				submission.value.maxSelections ?? Math.max(1, minSelections)
			const displayType = submission.value.displayType ?? 'single-select'
			await updateModifierGroup(
				organization.id,
				ctx.menuLocationId,
				params.groupId!,
				menuModifierSetSchema.parse({
					name: submission.value.name,
					minSelections: displayType === 'single-select' ? 1 : minSelections,
					maxSelections:
						displayType === 'single-select'
							? 1
							: Math.max(maxSelections, minSelections),
					required: formData.has('required'),
					displayType,
					preselectedOptionIds: formData
						.getAll('preselectedOptionIds')
						.map((value) => value.toString()),
				}),
			)
			return redirectWithToast(groupUrl, {
				type: 'success',
				title: 'Modifier group saved',
				description: '',
			})
		}
		case 'delete-group': {
			await deleteModifierGroup(
				organization.id,
				ctx.menuLocationId,
				params.groupId!,
			)
			return redirectWithToast(`/${organization.slug}/menu/modifier-groups`, {
				type: 'success',
				title: 'Modifier group deleted',
				description: '',
			})
		}
		case 'create-option': {
			const priceCents = Math.round((submission.value.priceDollars ?? 0) * 100)
			await createModifierOption(
				organization.id,
				ctx.menuLocationId,
				params.groupId!,
				menuModifierOptionSchema.parse({
					name: submission.value.optionName,
					description: submission.value.optionDescription || null,
					priceCents,
				}),
			)
			return redirectWithToast(groupUrl, {
				type: 'success',
				title: 'Option added',
				description: '',
			})
		}
		case 'delete-option': {
			await deleteModifierOption(
				organization.id,
				ctx.menuLocationId,
				submission.value.optionId!,
			)
			return redirectWithToast(groupUrl, {
				type: 'success',
				title: 'Option removed',
				description: '',
			})
		}
		case 'update-option': {
			await updateModifierOption(
				organization.id,
				ctx.menuLocationId,
				submission.value.optionId!,
				menuModifierOptionSchema.parse({
					name: submission.value.optionName,
					description: submission.value.optionDescription || null,
					priceCents: Math.round((submission.value.priceDollars ?? 0) * 100),
					active: formData.has('active'),
				}),
			)
			return redirectWithToast(groupUrl, {
				type: 'success',
				title: 'Option saved',
				description: '',
			})
		}
	}
}

export default function ModifierGroupDetailPage() {
	const { organization, group, catalogReady, canEditMenu } =
		useLoaderData<typeof loader>()
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

	if (!group) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>Modifier group not found.</Trans>
			</p>
		)
	}

	return (
		<div className="flex flex-col gap-8">
			<AnnotatedLayout>
				<AnnotatedSection
					title="Group rules"
					description="How many options diners can pick."
				>
					{group.attachedItems.length ? (
						<p className="text-muted-foreground mb-4 text-sm">
							<Trans>Attached to:</Trans>{' '}
							{group.attachedItems.map((item) => (
								<Link
									key={item.id}
									to={`/${organization.slug}/menu/items/${item.id}`}
									className="text-foreground hover:underline"
								>
									{item.name}
								</Link>
							))}
						</p>
					) : (
						<p className="text-muted-foreground mb-4 text-sm">
							<Trans>
								Not attached to any items yet. Open an item and attach this
								group.
							</Trans>
						</p>
					)}
					{canEditMenu ? (
						<Form method="post" className="flex max-w-2xl flex-col gap-4">
							<input type="hidden" name="intent" value="update-group" />
							<div className="space-y-1">
								<Label htmlFor="group-name">Display name</Label>
								<Input
									id="group-name"
									name="name"
									defaultValue={group.name}
									required
								/>
							</div>
							<div className="space-y-1">
								<Label htmlFor="display-type">Selection type</Label>
								<Select
									name="displayType"
									defaultValue={group.displayType ?? 'single-select'}
								>
									<SelectTrigger id="display-type" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="single-select">Single select</SelectItem>
										<SelectItem value="multi-select">Multi select</SelectItem>
										<SelectItem value="quantity-select">
											Quantity select
										</SelectItem>
										<SelectItem value="pizza-topping">Pizza topping</SelectItem>
									</SelectContent>
								</Select>
								<p className="text-muted-foreground text-xs">
									Controls whether guests choose one, many, quantities, or
									toppings.
								</p>
							</div>
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="space-y-1">
									<Label htmlFor="min-sel">
										<Trans>Min selections</Trans>
									</Label>
									<Input
										id="min-sel"
										name="minSelections"
										type="number"
										min={0}
										defaultValue={group.minSelections}
									/>
								</div>
								<div className="space-y-1">
									<Label htmlFor="max-sel">
										<Trans>Max selections</Trans>
									</Label>
									<Input
										id="max-sel"
										name="maxSelections"
										type="number"
										min={1}
										defaultValue={group.maxSelections}
									/>
								</div>
							</div>
							<label className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									name="required"
									value="true"
									defaultChecked={group.required}
								/>
								<Trans>Required group</Trans>
							</label>
							<div className="space-y-2">
								<div>
									<p className="text-sm font-medium">Preselected options</p>
									<p className="text-muted-foreground text-xs">
										These options are selected for guests by default.
									</p>
								</div>
								<div className="grid gap-2 sm:grid-cols-2">
									{group.options.map((option) => (
										<label
											key={option.id}
											className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
										>
											<input
												type="checkbox"
												name="preselectedOptionIds"
												value={option.id}
												defaultChecked={group.preselectedOptionIds.includes(
													option.id,
												)}
											/>
											<span className="flex-1">{option.name}</span>
											{option.priceCents > 0 ? (
												<span className="text-muted-foreground text-xs">
													+${(option.priceCents / 100).toFixed(2)}
												</span>
											) : null}
										</label>
									))}
								</div>
							</div>
							<Button type="submit" disabled={isSubmitting}>
								<Trans>Save group</Trans>
							</Button>
						</Form>
					) : (
						<p className="font-medium">{group.name}</p>
					)}
				</AnnotatedSection>

				<AnnotatedSection
					title="Options"
					description="Choices and price adjustments."
				>
					{group.options.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No options yet.</Trans>
						</p>
					) : null}
					{group.options.length > 0 ? (
						<>
							<div className="mb-4">
								<div className="mb-2 flex items-center justify-between gap-2">
									<p className="text-sm font-medium">Guest preview</p>
									<Badge variant="outline">
										{group.displayType ?? 'single-select'}
									</Badge>
								</div>
								<div className="rounded-lg border">
									{group.options.map((option) => (
										<div
											key={option.id}
											className="flex items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0"
										>
											<span
												className={
													group.displayType === 'single-select'
														? 'size-4 rounded-full border'
														: 'size-4 rounded-sm border'
												}
											/>
											<span className="flex-1">{option.name}</span>
											{option.priceCents > 0 ? (
												<span className="text-muted-foreground text-xs">
													+${(option.priceCents / 100).toFixed(2)}
												</span>
											) : null}
										</div>
									))}
								</div>
							</div>
							<MenuReorderList
								rows={group.options.map((option) => ({
									id: option.id,
									label:
										option.priceCents > 0
											? `${option.name} (+$${(option.priceCents / 100).toFixed(2)})`
											: option.name,
								}))}
								reorderAction={`/${organization.slug}/menu/reorder`}
								reorderIntent="reorder-modifier-options"
								extraFields={{ modifierSetId: group.id }}
								disabled={!canEditMenu || isSubmitting}
							/>
							<ul className="mt-4 divide-y text-sm">
								{group.options.map((option) => (
									<li key={option.id} className="flex flex-col gap-3 py-3">
										{canEditMenu ? (
											<Form method="post" className="grid gap-2 sm:grid-cols-6">
												<input
													type="hidden"
													name="intent"
													value="update-option"
												/>
												<input
													type="hidden"
													name="optionId"
													value={option.id}
												/>
												<Input
													name="optionName"
													defaultValue={option.name}
													className="sm:col-span-2"
													aria-label="Option name"
												/>
												<Input
													name="optionDescription"
													defaultValue={option.description ?? ''}
													placeholder="Description"
													className="sm:col-span-2"
													aria-label="Option description"
												/>
												<Input
													name="priceDollars"
													type="number"
													min={0}
													step="0.01"
													defaultValue={(option.priceCents / 100).toFixed(2)}
													aria-label="Option price"
												/>
												<label className="flex items-center gap-2 text-xs">
													<input
														type="checkbox"
														name="active"
														defaultChecked={option.active}
													/>
													Active
												</label>
												<Button
													type="submit"
													variant="outline"
													size="sm"
													disabled={isSubmitting}
												>
													Save
												</Button>
											</Form>
										) : (
											<span>
												{option.name}
												{option.priceCents > 0 ? (
													<span className="text-muted-foreground">
														{' '}
														(+${(option.priceCents / 100).toFixed(2)})
													</span>
												) : null}
											</span>
										)}
										{canEditMenu ? (
											<Form method="post" className="self-end">
												<input
													type="hidden"
													name="intent"
													value="delete-option"
												/>
												<input
													type="hidden"
													name="optionId"
													value={option.id}
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
									</li>
								))}
							</ul>
						</>
					) : null}
					{canEditMenu ? (
						<Form method="post" className="mt-4 flex flex-wrap items-end gap-2">
							<input type="hidden" name="intent" value="create-option" />
							<div className="min-w-[10rem] flex-1 space-y-1">
								<Label htmlFor="option-name">
									<Trans>Option name</Trans>
								</Label>
								<Input id="option-name" name="optionName" required />
							</div>
							<div className="min-w-[12rem] flex-1 space-y-1">
								<Label htmlFor="option-description">Description</Label>
								<Input id="option-description" name="optionDescription" />
							</div>
							<div className="w-28 space-y-1">
								<Label htmlFor="option-price">
									<Trans>+$ (USD)</Trans>
								</Label>
								<Input
									id="option-price"
									name="priceDollars"
									type="number"
									min={0}
									step="0.01"
									defaultValue={0}
								/>
							</div>
							<Button type="submit" disabled={isSubmitting}>
								<Trans>Add option</Trans>
							</Button>
						</Form>
					) : null}
				</AnnotatedSection>
			</AnnotatedLayout>

			{canEditMenu ? (
				<Form method="post">
					<input type="hidden" name="intent" value="delete-group" />
					<Button type="submit" variant="destructive" disabled={isSubmitting}>
						<Trans>Delete modifier group</Trans>
					</Button>
				</Form>
			) : null}
		</div>
	)
}
