import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
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
		return new Response(t`Catalog not ready`, { status: 400 })
	}
	await requireUserWithOrganizationPermission(
		args.request,
		organization.id,
		MENU_WRITE_PERMISSION,
	)
	const formData = await args.request.formData()
	const name = formData.get('name')?.toString().trim()
	if (!name) return new Response(t`Name required`, { status: 400 })
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
	const { _ } = useLingui()

	return (
		<Form method="post" className="mx-auto flex max-w-2xl flex-col gap-6">
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-1 sm:col-span-2">
					<Label htmlFor="name">
						<Trans>Display name</Trans>
					</Label>
					<Input id="name" name="name" required placeholder={_(t`Lunch`)} />
				</div>
				<div className="space-y-1">
					<Label htmlFor="menu-type">
						<Trans>Menu type</Trans>
					</Label>
					<Select name="menuType" defaultValue="olo">
						<SelectTrigger id="menu-type" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="olo">
								<Trans>Online ordering</Trans>
							</SelectItem>
							<SelectItem value="catering">
								<Trans>Catering</Trans>
							</SelectItem>
							<SelectItem value="dine-in">
								<Trans>Dine-in</Trans>
							</SelectItem>
						</SelectContent>
					</Select>
				</div>
				<div className="space-y-1">
					<Label htmlFor="description">
						<Trans>Description</Trans>
					</Label>
					<Textarea id="description" name="description" rows={3} />
				</div>
			</div>
			<div className="grid gap-2 sm:grid-cols-2">
				<label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
					<input type="checkbox" name="showCalories" />
					<Trans>Show calorie information</Trans>
				</label>
				<label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
					<input type="checkbox" name="instructionsEnabled" defaultChecked />
					<Trans>Enable instructions</Trans>
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
