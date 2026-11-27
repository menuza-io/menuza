import { Trans } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import {
	isCalorieDisplayMode,
	resolveCalorieDisplay,
	type CalorieDisplayMode,
} from '@repo/common/calorie-display'
import {
	and,
	db,
	eq,
	Organization,
	OrganizationMenu,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'
import { Button } from '@repo/ui/button'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Form,
	useLoaderData,
} from 'react-router'
import {
	requireMenuRead,
	requireMenuWrite,
} from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

const MODES: CalorieDisplayMode[] = ['always', 'complete', 'never']

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		calorieDisplay: true,
	})
	await requireMenuRead(request, organization.id)
	const menus = await db
		.select({
			id: OrganizationMenu.id,
			displayName: OrganizationMenu.displayName,
			calorieDisplay: OrganizationMenu.calorieDisplay,
			nutritionalInfo: OrganizationMenu.nutritionalInfo,
		})
		.from(OrganizationMenu)
		.where(eq(OrganizationMenu.organizationId, organization.id))
	const links = await db
		.select({
			menuId: OrganizationMenuCategoryAssignment.menuId,
			itemId: OrganizationMenuItemCategoryAssignment.itemId,
			calorieMin: OrganizationMenuItem.calorieMin,
		})
		.from(OrganizationMenuCategoryAssignment)
		.innerJoin(
			OrganizationMenu,
			eq(OrganizationMenu.id, OrganizationMenuCategoryAssignment.menuId),
		)
		.innerJoin(
			OrganizationMenuItemCategoryAssignment,
			eq(
				OrganizationMenuItemCategoryAssignment.categoryId,
				OrganizationMenuCategoryAssignment.categoryId,
			),
		)
		.innerJoin(
			OrganizationMenuItem,
			eq(
				OrganizationMenuItem.id,
				OrganizationMenuItemCategoryAssignment.itemId,
			),
		)
		.where(eq(OrganizationMenu.organizationId, organization.id))
	const missing = new Map<string, number>()
	const seen = new Map<string, Set<string>>()
	for (const link of links) {
		const ids = seen.get(link.menuId) ?? new Set<string>()
		if (ids.has(link.itemId)) continue
		ids.add(link.itemId)
		seen.set(link.menuId, ids)
		if (link.calorieMin == null) {
			missing.set(link.menuId, (missing.get(link.menuId) ?? 0) + 1)
		}
	}
	const orgMode = isCalorieDisplayMode(organization.calorieDisplay)
		? organization.calorieDisplay
		: 'always'
	return {
		organization,
		orgMode,
		menus: menus.map((menu) => {
			const display = resolveCalorieDisplay({
				orgMode,
				menuMode: menu.calorieDisplay,
				nutritionalInfo: menu.nutritionalInfo,
				missingCount: missing.get(menu.id) ?? 0,
			})
			return {
				id: menu.id,
				displayName: menu.displayName,
				mode: menu.calorieDisplay ?? '',
				missingCount: display.missingCount,
				show: display.show,
			}
		}),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	await requireMenuWrite(request, organization.id)
	const form = await request.formData()
	const orgMode = form.get('orgMode')
	if (!isCalorieDisplayMode(orgMode)) {
		return { ok: false }
	}
	await db
		.update(Organization)
		.set({ calorieDisplay: orgMode })
		.where(eq(Organization.id, organization.id))
	const menuIds = form
		.getAll('menuId')
		.filter((value): value is string => typeof value === 'string')
	for (const menuId of menuIds) {
		const mode = form.get(`mode:${menuId}`)
		await db
			.update(OrganizationMenu)
			.set({
				calorieDisplay: isCalorieDisplayMode(mode) ? mode : null,
				nutritionalInfo: mode !== 'never',
			})
			.where(
				and(
					eq(OrganizationMenu.id, menuId),
					eq(OrganizationMenu.organizationId, organization.id),
				),
			)
	}
	return { ok: true }
}

export default function CalorieSettingsRoute() {
	const { orgMode, menus } = useLoaderData<typeof loader>()
	return (
		<Form method="post" className="max-w-xl space-y-4">
			<h2 className="text-lg font-semibold">
				<Trans>Show calories on the menu</Trans>
			</h2>
			<label className="block text-sm">
				<Trans>Organization</Trans>
				<select
					name="orgMode"
					defaultValue={orgMode}
					className="mt-1 block w-full"
				>
					<option value="always">
						<Trans>Always</Trans>
					</option>
					<option value="complete">
						<Trans>Only when every dish has them</Trans>
					</option>
					<option value="never">
						<Trans>Never</Trans>
					</option>
				</select>
			</label>
			<ul className="space-y-3">
				{menus.map((menu) => {
					const missingCount = menu.missingCount
					return (
						<li key={menu.id} className="space-y-1">
							<input type="hidden" name="menuId" value={menu.id} />
							<p className="text-sm font-medium">{menu.displayName}</p>
							<select
								name={`mode:${menu.id}`}
								defaultValue={menu.mode}
								className="block w-full"
							>
								<option value="">{/* inherit */}</option>
								{MODES.map((mode) => (
									<option key={mode} value={mode}>
										{mode}
									</option>
								))}
							</select>
							{menu.mode === 'complete' || orgMode === 'complete' ? (
								<p className="text-muted-foreground text-sm">
									<Trans>{missingCount} dishes are missing calories.</Trans>
								</p>
							) : null}
							{!menu.show ? (
								<p className="text-muted-foreground text-sm">
									<Trans>Calories are hidden on this menu.</Trans>
								</p>
							) : null}
						</li>
					)
				})}
			</ul>
			<Button type="submit">
				<Trans>Save</Trans>
			</Button>
		</Form>
	)
}
