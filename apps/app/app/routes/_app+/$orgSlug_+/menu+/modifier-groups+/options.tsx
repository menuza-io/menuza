import { parseWithZod } from '@conform-to/zod'
import { Trans } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { Form, useLoaderData, useNavigation } from 'react-router'
import { z } from 'zod'

import { menuCatalogUnavailableMessage } from '#app/utils/menu-catalog-messages.ts'
import {
	listModifierSetsForLocation,
	updateModifierOption,
} from '#app/utils/menu-catalog.server.ts'
import { loadMenuOperatorContextFromArgs } from '#app/utils/menu-loader.server.ts'
import { MENU_WRITE_PERMISSION } from '#app/utils/menu-permissions.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

import { MenuCatalogGate } from '../components/menu-catalog-gate.tsx'
import {
	MenuClickableTableRow,
	stopRowClick,
} from '../components/menu-clickable-table-row.tsx'
import {
	MenuListHeader,
	MenuTableShell,
} from '../components/menu-list-header.tsx'
import { useMenuListSearch } from '../components/use-menu-list-search.ts'

const ModifierActionSchema = z.object({
	intent: z.literal('toggle-active'),
	optionId: z.string().min(1),
	active: z.enum(['true', 'false']),
})

export async function loader(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	const ctx = await loadMenuOperatorContextFromArgs(args)
	const sets =
		ctx.catalogReady && ctx.menuLocationId
			? await listModifierSetsForLocation(
					ctx.organization.id,
					ctx.menuLocationId,
				)
			: []
	return {
		...ctx,
		options: sets.flatMap((set) =>
			set.options.map((option) => ({
				...option,
				setId: set.id,
				setName: set.name,
			})),
		),
	}
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
	if (!ctx.catalogReady || !ctx.menuLocationId) {
		const msg = menuCatalogUnavailableMessage(organization)
		return redirectWithToast(
			`/${organization.slug}/menu/modifier-groups/options`,
			{
				type: 'error',
				title: msg.title,
				description: msg.description,
			},
		)
	}
	const submission = parseWithZod(await args.request.formData(), {
		schema: ModifierActionSchema,
	})
	if (submission.status !== 'success') return submission.reply()

	const options = (
		await listModifierSetsForLocation(organization.id, ctx.menuLocationId)
	).flatMap((set) => set.options)
	const option = options.find(
		(candidate) => candidate.id === submission.value.optionId,
	)
	if (!option) return new Response('Modifier not found', { status: 404 })

	await updateModifierOption(organization.id, ctx.menuLocationId, option.id, {
		name: option.name,
		description: option.description,
		priceCents: option.priceCents,
		active: submission.value.active === 'true',
		sortOrder: option.sortOrder,
	})
	return redirectWithToast(
		`/${organization.slug}/menu/modifier-groups/options`,
		{
			type: 'success',
			title: 'Modifier updated',
			description: '',
		},
	)
}

export default function ModifiersListPage() {
	const { organization, options, catalogReady, operatorContext } =
		useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state !== 'idle'
	const { query, setQuery } = useMenuListSearch()
	const needle = query.toLowerCase()
	const filteredOptions = options.filter((option) =>
		`${option.name} ${option.setName}`.toLowerCase().includes(needle),
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

	return (
		<div className="flex flex-col gap-4">
			<MenuListHeader
				title={<Trans>Modifiers</Trans>}
				subtitle={
					operatorContext === 'branch' ? (
						<Trans>Location scope</Trans>
					) : (
						<Trans>Brand scope — default location</Trans>
					)
				}
				searchQuery={query}
				onSearchChange={setQuery}
				searchPlaceholder="Search modifiers"
			/>
			<p className="text-muted-foreground text-sm">
				Options are reusable across items through their modifier sets.
			</p>
			<MenuTableShell>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Name</TableHead>
							<TableHead>Modifier set</TableHead>
							<TableHead>Price</TableHead>
							<TableHead>Status</TableHead>
							<TableHead className="w-28 text-end">
								<span className="sr-only">Actions</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{filteredOptions.length === 0 ? (
							<TableRow>
								<TableCell colSpan={5}>
									<p className="text-muted-foreground px-4 py-12 text-center text-sm">
										{query
											? 'No modifiers match your search.'
											: 'No modifiers yet.'}
									</p>
								</TableCell>
							</TableRow>
						) : (
							filteredOptions.map((option) => (
								<MenuClickableTableRow
									key={option.id}
									to={`/${organization.slug}/menu/modifier-groups/${option.setId}`}
								>
									<TableCell className="font-medium">{option.name}</TableCell>
									<TableCell className="text-muted-foreground">
										{option.setName}
									</TableCell>
									<TableCell className="tabular-nums">
										${(option.priceCents / 100).toFixed(2)}
									</TableCell>
									<TableCell>
										{option.active ? (
											<Badge variant="secondary">Available</Badge>
										) : (
											<Badge variant="outline">Unavailable</Badge>
										)}
									</TableCell>
									<TableCell className="text-end" onClick={stopRowClick}>
										<Form method="post" className="inline">
											<input
												type="hidden"
												name="intent"
												value="toggle-active"
											/>
											<input type="hidden" name="optionId" value={option.id} />
											<input
												type="hidden"
												name="active"
												value={option.active ? 'false' : 'true'}
											/>
											<Button
												type="submit"
												variant="outline"
												size="sm"
												disabled={isSubmitting}
											>
												{option.active ? '86' : 'Restock'}
											</Button>
										</Form>
									</TableCell>
								</MenuClickableTableRow>
							))
						)}
					</TableBody>
				</Table>
			</MenuTableShell>
		</div>
	)
}
