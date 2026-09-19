import { Trans, t } from '@lingui/macro'
import {
	parseLocalizedString,
	pickLocalized,
	serializeLocalizedString,
} from '@repo/common/site-locales'
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
	Form,
	Link,
	redirect,
	useLoaderData,
	useNavigation,
} from 'react-router'

import {
	createModifierSet,
	menuModifierSetSchema,
} from '#app/utils/menu-catalog.server.ts'
import { loadMenuOperatorContextFromArgs } from '#app/utils/menu-loader.server.ts'
import { MENU_WRITE_PERMISSION } from '#app/utils/menu-permissions.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'
import {
	MenuEditorCard,
	MenuLocalizedInput,
	MenuResourceEditorPage,
} from '../components/menu-resource-editor.tsx'

export async function action(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	const ctx = await loadMenuOperatorContextFromArgs(args)
	const { organization, menuLocationId, catalogReady } = ctx
	if (!catalogReady || !menuLocationId) {
		return new Response(t`Catalog not ready`, { status: 400 })
	}
	await requireUserWithOrganizationPermission(
		args.request,
		organization.id,
		MENU_WRITE_PERMISSION,
	)
	const formData = await args.request.formData()
	const name = formData.get('name')?.toString().trim()
	const nameI18n = formData.get('nameI18n')?.toString()
	if (!name) return new Response(t`Name required`, { status: 400 })
	const displayType = formData.get('displayType')?.toString() ?? 'single-select'
	const minSelections = Number(formData.get('minSelections') ?? 0)
	const maxSelections = Number(formData.get('maxSelections') ?? 1)
	const set = await createModifierSet(
		organization.id,
		menuLocationId,
		menuModifierSetSchema.parse({
			name: pickLocalized(
				nameI18n ?? name,
				ctx.localesConfig.defaultLocale,
				ctx.localesConfig.defaultLocale,
			),
			nameI18n: serializeLocalizedString(
				parseLocalizedString(nameI18n ?? name, ctx.localesConfig.defaultLocale),
			),
			displayType,
			minSelections: displayType === 'single-select' ? 1 : minSelections,
			maxSelections:
				displayType === 'single-select'
					? 1
					: Math.max(maxSelections, minSelections),
			required: formData.has('required'),
		}),
	)
	return redirect(`/${organization.slug}/menu/modifier-groups/${set!.id}`)
}

export async function loader(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	return loadMenuOperatorContextFromArgs(args)
}

export default function NewModifierGroupRoute() {
	const { organization, localesConfig } = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state !== 'idle'
	const [nameI18n, setNameI18n] = useState('')

	return (
		<MenuResourceEditorPage
			title={<Trans>New modifier set</Trans>}
			description={
				<Trans>Create a reusable set of options for menu items.</Trans>
			}
			localesConfig={localesConfig}
			backHref={`/${organization.slug}/menu/modifier-groups`}
		>
			<Form method="post" className="space-y-6">
				<MenuEditorCard title={<Trans>Modifier set details</Trans>}>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Create a reusable modifier group, then attach it to items and add
							options on the next screen.
						</Trans>
					</p>
					<MenuLocalizedInput
						label={<Trans>Display name</Trans>}
						name="name"
						value={nameI18n}
						onChange={setNameI18n}
						required
					/>
					<div className="space-y-1">
						<Label htmlFor="display-type">
							<Trans>Selection type</Trans>
						</Label>
						<Select name="displayType" defaultValue="single-select">
							<SelectTrigger id="display-type" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="single-select">
									<Trans>Single select</Trans>
								</SelectItem>
								<SelectItem value="multi-select">
									<Trans>Multi select</Trans>
								</SelectItem>
								<SelectItem value="quantity-select">
									<Trans>Quantity select</Trans>
								</SelectItem>
								<SelectItem value="pizza-topping">
									<Trans>Pizza topping</Trans>
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-1">
							<Label htmlFor="min-selections">
								<Trans>Minimum selections</Trans>
							</Label>
							<Input
								id="min-selections"
								name="minSelections"
								type="number"
								min={0}
								defaultValue={1}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor="max-selections">
								<Trans>Maximum selections</Trans>
							</Label>
							<Input
								id="max-selections"
								name="maxSelections"
								type="number"
								min={1}
								defaultValue={1}
							/>
						</div>
					</div>
					<label className="flex items-center gap-2 text-sm">
						<input type="checkbox" name="required" />
						<Trans>Required set</Trans>
					</label>
					<div className="flex justify-end gap-2">
						<Button type="submit" disabled={isSubmitting}>
							<Trans>Create group</Trans>
						</Button>
						<Button
							variant="outline"
							render={<Link to=".." />}
							disabled={isSubmitting}
						>
							<Trans>Cancel</Trans>
						</Button>
					</div>
				</MenuEditorCard>
			</Form>
		</MenuResourceEditorPage>
	)
}
