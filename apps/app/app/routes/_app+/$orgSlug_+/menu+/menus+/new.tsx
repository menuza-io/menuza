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
import { Textarea } from '@repo/ui/textarea'
import { Form, Link, redirect, useNavigation } from 'react-router'

import { createMenu, menuSchema } from '#app/utils/menu-catalog.server.ts'
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
	const menu = await createMenu(
		organization.id,
		menuLocationId,
		menuSchema.parse({
			name,
			description: formData.get('description')?.toString() || null,
			menuType: formData.get('menuType')?.toString() || 'olo',
			showCalories: formData.has('showCalories'),
			instructionsEnabled: formData.has('instructionsEnabled'),
		}),
	)
	return redirect(`/${organization.slug}/menu/menus/${menu!.id}`)
}

export async function loader(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	return loadMenuOperatorContextFromArgs(args)
}

export default function NewMenuRoute() {
	const navigation = useNavigation()
	const isSubmitting = navigation.state !== 'idle'

	return (
		<Form method="post" className="mx-auto flex max-w-2xl flex-col gap-6">
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-1 sm:col-span-2">
					<Label htmlFor="name">Display name</Label>
					<Input id="name" name="name" required placeholder="Lunch" />
				</div>
				<div className="space-y-1">
					<Label htmlFor="menu-type">Menu type</Label>
					<Select name="menuType" defaultValue="olo">
						<SelectTrigger id="menu-type" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="olo">Online ordering</SelectItem>
							<SelectItem value="catering">Catering</SelectItem>
							<SelectItem value="dine-in">Dine-in</SelectItem>
						</SelectContent>
					</Select>
				</div>
				<div className="space-y-1">
					<Label htmlFor="description">Description</Label>
					<Textarea id="description" name="description" rows={3} />
				</div>
			</div>
			<div className="grid gap-2 sm:grid-cols-2">
				<label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
					<input type="checkbox" name="showCalories" />
					Show calorie information
				</label>
				<label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
					<input type="checkbox" name="instructionsEnabled" defaultChecked />
					Enable instructions
				</label>
			</div>
			<div className="flex gap-2">
				<Button type="submit" disabled={isSubmitting}>
					<Trans>Create menu</Trans>
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
