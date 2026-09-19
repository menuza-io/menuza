import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
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
		menuSchema.parse({ name }),
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
		<Form method="post" className="mx-auto flex max-w-lg flex-col gap-4">
			<div className="space-y-1">
				<Label htmlFor="name">
					<Trans>Menu name</Trans>
				</Label>
				<Input id="name" name="name" required placeholder="Lunch" />
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
