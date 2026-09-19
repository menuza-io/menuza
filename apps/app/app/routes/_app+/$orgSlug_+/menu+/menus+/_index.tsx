import { Trans } from '@lingui/macro'
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
import { Form, Link, useLoaderData, useNavigation } from 'react-router'

import { listMenusForLocation } from '#app/utils/menu-catalog.server.ts'
import { menuCatalogUnavailableMessage } from '#app/utils/menu-catalog-messages.ts'
import { loadMenuOperatorContextFromArgs } from '#app/utils/menu-loader.server.ts'
import { MENU_WRITE_PERMISSION } from '#app/utils/menu-permissions.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

import { MenuCatalogGate } from '../components/menu-catalog-gate.tsx'

export async function loader(
	args: Parameters<typeof loadMenuOperatorContextFromArgs>[0],
) {
	const ctx = await loadMenuOperatorContextFromArgs(args)
	const { organization, menuLocationId, catalogReady } = ctx
	if (!catalogReady || !menuLocationId) {
		return { ...ctx, menus: [] as const }
	}
	const menuList = await listMenusForLocation(organization.id, menuLocationId)
	return { ...ctx, menus: menuList }
}

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
	const intent = formData.get('intent')
	const menuId = formData.get('menuId')?.toString()
	if (!menuId) return new Response('Missing menuId', { status: 400 })

	const { setMenuActive, deleteMenu } =
		await import('#app/utils/menu-catalog.server.ts')

	if (intent === 'toggle-active') {
		const active = formData.get('active') === 'true'
		await setMenuActive(organization.id, menuLocationId, menuId, active)
		return { ok: true }
	}
	if (intent === 'delete') {
		await deleteMenu(organization.id, menuLocationId, menuId)
		return { ok: true }
	}
	return new Response('Unknown intent', { status: 400 })
}

export default function MenusListRoute() {
	const { organization, menus, catalogReady, canEditMenu } =
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

	const base = `/${organization.slug}/menu/menus`

	return (
		<div className="flex flex-col gap-6">
			{canEditMenu ? (
				<div className="flex justify-end">
					<Button render={<Link to={`${base}/new`} />}>
						<Trans>New menu</Trans>
					</Button>
				</div>
			) : null}

			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>
							<Trans>Name</Trans>
						</TableHead>
						<TableHead>
							<Trans>Status</Trans>
						</TableHead>
						{canEditMenu ? (
							<TableHead className="text-end">
								<Trans>Actions</Trans>
							</TableHead>
						) : null}
					</TableRow>
				</TableHeader>
				<TableBody>
					{menus.length === 0 ? (
						<TableRow>
							<TableCell colSpan={canEditMenu ? 3 : 2}>
								<p className="text-muted-foreground py-6 text-center text-sm">
									<Trans>No menus yet.</Trans>
								</p>
							</TableCell>
						</TableRow>
					) : (
						menus.map((menu) => (
							<TableRow key={menu.id}>
								<TableCell>
									<Link
										to={`${base}/${menu.id}`}
										className="font-medium hover:underline"
									>
										{menu.name}
									</Link>
								</TableCell>
								<TableCell>
									{menu.active ? (
										<Badge variant="secondary">
											<Trans>On</Trans>
										</Badge>
									) : (
										<Badge variant="outline">
											<Trans>Off</Trans>
										</Badge>
									)}
								</TableCell>
								{canEditMenu ? (
									<TableCell className="text-end">
										<div className="flex flex-wrap justify-end gap-2">
											<Form method="post" className="inline">
												<input
													type="hidden"
													name="intent"
													value="toggle-active"
												/>
												<input type="hidden" name="menuId" value={menu.id} />
												<input
													type="hidden"
													name="active"
													value={menu.active ? 'false' : 'true'}
												/>
												<Button
													type="submit"
													variant="outline"
													size="sm"
													disabled={isSubmitting}
												>
													{menu.active ? (
														<Trans>Turn off</Trans>
													) : (
														<Trans>Turn on</Trans>
													)}
												</Button>
											</Form>
										</div>
									</TableCell>
								) : null}
							</TableRow>
						))
					)}
				</TableBody>
			</Table>
		</div>
	)
}
