import { Trans } from '@lingui/macro'
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
import { Form, Link, redirect, useNavigation } from 'react-router'

import {
	createModifierSet,
	menuModifierSetSchema,
} from '#app/utils/menu-catalog.server.ts'
import { loadMenuOperatorContextFromArgs } from '#app/utils/menu-loader.server.ts'
import { MENU_WRITE_PERMISSION } from '#app/utils/menu-permissions.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

export async function action(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	const ctx = await loadMenuOperatorContextFromArgs(args)
	const { organization, menuLocationId, catalogReady } = ctx
	if (!catalogReady || !menuLocationId) {
		return new Response('Catalog not ready', { status: 400 })
	}
	await requireUserWithOrganizationPermission(
		args.request,
		organization.id,
		MENU_WRITE_PERMISSION,
	)
	const formData = await args.request.formData()
	const name = formData.get('name')?.toString().trim()
	if (!name) return new Response('Name required', { status: 400 })
	const displayType = formData.get('displayType')?.toString() ?? 'single-select'
	const minSelections = Number(formData.get('minSelections') ?? 0)
	const maxSelections = Number(formData.get('maxSelections') ?? 1)
	const set = await createModifierSet(
		organization.id,
		menuLocationId,
		menuModifierSetSchema.parse({
			name,
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
	const navigation = useNavigation()
	const isSubmitting = navigation.state !== 'idle'

	return (
		<Form method="post" className="mx-auto flex max-w-2xl flex-col gap-5">
			<p className="text-muted-foreground text-sm">
				<Trans>
					Create a reusable modifier group, then attach it to items and add
					options on the next screen.
				</Trans>
			</p>
			<div className="space-y-1">
				<Label htmlFor="name">Display name</Label>
				<Input id="name" name="name" required placeholder="Choose a side" />
			</div>
			<div className="space-y-1">
				<Label htmlFor="display-type">Selection type</Label>
				<Select name="displayType" defaultValue="single-select">
					<SelectTrigger id="display-type" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="single-select">Single select</SelectItem>
						<SelectItem value="multi-select">Multi select</SelectItem>
						<SelectItem value="quantity-select">Quantity select</SelectItem>
						<SelectItem value="pizza-topping">Pizza topping</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-1">
					<Label htmlFor="min-selections">Minimum selections</Label>
					<Input
						id="min-selections"
						name="minSelections"
						type="number"
						min={0}
						defaultValue={1}
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="max-selections">Maximum selections</Label>
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
				Required set
			</label>
			<div className="flex gap-2">
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
		</Form>
	)
}
