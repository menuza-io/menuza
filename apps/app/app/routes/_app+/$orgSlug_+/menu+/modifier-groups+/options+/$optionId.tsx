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
	listModifierSetsForLocation,
	menuModifierOptionSchema,
	updateModifierOption,
} from '#app/utils/menu-catalog.server.ts'
import { loadMenuOperatorContextFromArgs } from '#app/utils/menu-loader.server.ts'
import { MENU_WRITE_PERMISSION } from '#app/utils/menu-permissions.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

import { MenuCatalogGate } from '../../components/menu-catalog-gate.tsx'
import {
	MenuEditorCard,
	MenuEditorSidebarCard,
	MenuLocalizedInput,
	MenuLocalizedTextarea,
	MenuResourceEditorPage,
} from '../../components/menu-resource-editor.tsx'

const OptionActionSchema = z.object({
	intent: z.literal('save-option'),
	name: z.string().optional(),
	nameI18n: z.string().optional(),
	description: z.string().optional(),
	descriptionI18n: z.string().optional(),
	priceDollars: z.coerce.number().min(0),
})

export async function loader(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	const ctx = await loadMenuOperatorContextFromArgs(args)
	if (!ctx.catalogReady || !ctx.menuLocationId) {
		return { ...ctx, option: null, set: null }
	}
	const sets = await listModifierSetsForLocation(
		ctx.organization.id,
		ctx.menuLocationId,
	)
	for (const set of sets) {
		const option = set.options.find(
			(candidate) => candidate.id === args.params.optionId,
		)
		if (option) return { ...ctx, option, set }
	}
	return { ...ctx, option: null, set: null }
}

export async function action(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	await requireUserId(args.request)
	const organization = await requireUserOrganization(
		args.request,
		args.params.orgSlug,
		{
			id: true,
			slug: true,
			hasProvisionedDb: true,
			dataRegion: true,
		},
	)
	await requireUserWithOrganizationPermission(
		args.request,
		organization.id,
		MENU_WRITE_PERMISSION,
	)
	const ctx = await loadMenuOperatorContextFromArgs(args)
	const optionUrl = `/${organization.slug}/menu/modifier-groups/options/${args.params.optionId}`
	if (!ctx.catalogReady || !ctx.menuLocationId) {
		const msg = menuCatalogUnavailableMessage(organization)
		return redirectWithToast(optionUrl, {
			type: 'error',
			title: msg.title,
			description: msg.description,
		})
	}

	const formData = await args.request.formData()
	const submission = parseWithZod(formData, {
		schema: OptionActionSchema,
	})
	if (submission.status !== 'success') return submission.reply()

	const sets = await listModifierSetsForLocation(
		organization.id,
		ctx.menuLocationId,
	)
	const option = sets
		.flatMap((set) => set.options)
		.find((candidate) => candidate.id === args.params.optionId)
	if (!option) throw new Response('Modifier not found', { status: 404 })

	await updateModifierOption(
		organization.id,
		ctx.menuLocationId,
		option.id,
		menuModifierOptionSchema.parse({
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
			priceCents: Math.round(submission.value.priceDollars * 100),
			active: formData.has('active'),
			sortOrder: option.sortOrder,
		}),
	)

	return redirectWithToast(optionUrl, {
		type: 'success',
		title: t`Modifier saved`,
		description: '',
	})
}

export default function ModifierOptionDetailPage() {
	const {
		organization,
		option,
		set,
		catalogReady,
		canEditMenu,
		localesConfig,
	} = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state !== 'idle'
	const [nameI18n, setNameI18n] = useState(
		option?.nameI18n ?? option?.name ?? '',
	)
	const [descriptionI18n, setDescriptionI18n] = useState(
		option?.descriptionI18n ?? option?.description ?? '',
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
	if (!option || !set) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>Modifier not found.</Trans>
			</p>
		)
	}
	return (
		<MenuResourceEditorPage
			title={<Trans>Edit modifier</Trans>}
			description={
				<Trans>
					Manage the localized name, description, price, and availability.
				</Trans>
			}
			localesConfig={localesConfig}
			backHref={`/${organization.slug}/menu/modifier-groups/options`}
			sidebar={
				canEditMenu ? (
					<MenuEditorSidebarCard title={<Trans>Set membership</Trans>}>
						<p className="text-muted-foreground text-sm">{set.name}</p>
						<Button
							variant="outline"
							render={
								<Link
									to={`/${organization.slug}/menu/modifier-groups/${set.id}`}
								/>
							}
						>
							<Trans>Open modifier set</Trans>
						</Button>
					</MenuEditorSidebarCard>
				) : null
			}
		>
			<Form method="post" className="space-y-6">
				<input type="hidden" name="intent" value="save-option" />
				<MenuEditorCard
					title={<Trans>Modifier details</Trans>}
					description={
						<Trans>This option belongs to the {set.name} modifier set.</Trans>
					}
				>
					<MenuLocalizedInput
						label={<Trans>Name</Trans>}
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
						<Label htmlFor="option-price">
							<Trans>Price (USD)</Trans>
						</Label>
						<Input
							id="option-price"
							name="priceDollars"
							type="number"
							min={0}
							step="0.01"
							defaultValue={(option.priceCents / 100).toFixed(2)}
						/>
					</div>
					<label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
						<input
							type="checkbox"
							name="active"
							defaultChecked={option.active}
						/>
						<Trans>Available to guests</Trans>
					</label>
				</MenuEditorCard>
				<div className="flex justify-end">
					<Button type="submit" disabled={isSubmitting}>
						<Trans>Save modifier</Trans>
					</Button>
				</div>
			</Form>
		</MenuResourceEditorPage>
	)
}
