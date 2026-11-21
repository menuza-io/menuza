import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { ORG_PERMISSIONS, userHasOrganizationPermission } from '@repo/auth'
import { PageHeader } from '@repo/ui/page-header'
import { WorkspacePage, WorkspaceTabBar } from '@repo/ui/workspace'
import {
	type LoaderFunctionArgs,
	Outlet,
	useLoaderData,
	useLocation,
	useParams,
} from 'react-router'
import { requireMenuRead } from '#app/utils/menu/access.server.ts'
import {
	getMenuBulkEditEnabled,
	getMenuHistoryEnabled,
	getMenuImportEnabled,
	isGuestPhotosEnabledForOrganization,
} from '#app/utils/menu/menu-feature-access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

export const MENU_LAYOUT_ROUTE_ID = 'routes/_app+/$orgSlug_+/menu+/_layout'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		dataRegion: true,
	})
	const userId = await requireMenuRead(request, organization.id)
	const [
		menuHistoryEnabled,
		menuBulkEditEnabled,
		menuImportEnabled,
		guestPhotosFlagOn,
		canModerateGuestPhotos,
	] = await Promise.all([
		getMenuHistoryEnabled(organization.id),
		getMenuBulkEditEnabled(organization.id),
		getMenuImportEnabled(organization.id),
		isGuestPhotosEnabledForOrganization(organization),
		userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.UPDATE_GUEST_PHOTO_ANY,
		),
	])
	const guestPhotosEnabled = guestPhotosFlagOn && canModerateGuestPhotos
	return {
		menuHistoryEnabled,
		menuBulkEditEnabled,
		menuImportEnabled,
		guestPhotosEnabled,
	}
}

export default function MenuLayout() {
	const { _ } = useLingui()
	const location = useLocation()
	const params = useParams()
	const orgSlug = params.orgSlug
	const {
		menuHistoryEnabled,
		menuBulkEditEnabled,
		menuImportEnabled,
		guestPhotosEnabled,
	} = useLoaderData<typeof loader>()

	const tabs = [
		{
			label: _(t`Overview`),
			href: `/${orgSlug}/menu`,
			isActive:
				location.pathname === `/${orgSlug}/menu` ||
				location.pathname === `/${orgSlug}/menu/`,
		},
		{
			label: _(t`Menus`),
			href: `/${orgSlug}/menu/menus`,
			isActive:
				location.pathname === `/${orgSlug}/menu/menus` ||
				location.pathname === `/${orgSlug}/menu/menus/`,
		},
		{
			label: _(t`Categories`),
			href: `/${orgSlug}/menu/categories`,
			isActive:
				location.pathname === `/${orgSlug}/menu/categories` ||
				location.pathname === `/${orgSlug}/menu/categories/`,
		},
		{
			label: _(t`Items`),
			href: `/${orgSlug}/menu/items`,
			isActive:
				location.pathname === `/${orgSlug}/menu/items` ||
				location.pathname === `/${orgSlug}/menu/items/`,
		},
		{
			label: _(t`Modifier Groups`),
			href: `/${orgSlug}/menu/modifiers`,
			isActive:
				location.pathname === `/${orgSlug}/menu/modifiers` ||
				location.pathname === `/${orgSlug}/menu/modifiers/`,
		},
		{
			label: _(t`Options`),
			href: `/${orgSlug}/menu/options`,
			isActive:
				location.pathname === `/${orgSlug}/menu/options` ||
				location.pathname === `/${orgSlug}/menu/options/`,
		},
		{
			label: _(t`Drops`),
			href: `/${orgSlug}/menu/drops`,
			isActive:
				location.pathname === `/${orgSlug}/menu/drops` ||
				location.pathname === `/${orgSlug}/menu/drops/` ||
				location.pathname.startsWith(`/${orgSlug}/menu/drops/`),
		},
		{
			label: _(t`Pricing rules`),
			href: `/${orgSlug}/menu/pricing-rules`,
			isActive: location.pathname.startsWith(`/${orgSlug}/menu/pricing-rules`),
		},
		{
			label: _(t`Translations`),
			href: `/${orgSlug}/menu/translations`,
			isActive: location.pathname.startsWith(`/${orgSlug}/menu/translations`),
		},
		...(menuBulkEditEnabled
			? [
					{
						label: _(t`Spreadsheet`),
						href: `/${orgSlug}/menu/spreadsheet`,
						isActive: location.pathname.startsWith(
							`/${orgSlug}/menu/spreadsheet`,
						),
					},
				]
			: []),
		...(menuHistoryEnabled
			? [
					{
						label: _(t`History`),
						href: `/${orgSlug}/menu/history`,
						isActive:
							location.pathname === `/${orgSlug}/menu/history` ||
							location.pathname.startsWith(`/${orgSlug}/menu/history/`),
					},
				]
			: []),
		...(menuImportEnabled
			? [
					{
						label: _(t`Import`),
						href: `/${orgSlug}/menu/import`,
						isActive:
							location.pathname === `/${orgSlug}/menu/import` ||
							location.pathname.startsWith(`/${orgSlug}/menu/import/`),
					},
				]
			: []),
		...(guestPhotosEnabled
			? [
					{
						label: _(t`Guest photos`),
						href: `/${orgSlug}/menu/guest-photos`,
						isActive:
							location.pathname === `/${orgSlug}/menu/guest-photos` ||
							location.pathname.startsWith(`/${orgSlug}/menu/guest-photos/`),
					},
				]
			: []),
	]

	// Create and Edit views render full-page Shopify-style chrome
	const isEditOrCreate =
		/\/menu\/(menus|categories|items|modifiers|options|drops)\/(new|[^/]+)$/.test(
			location.pathname,
		)

	if (isEditOrCreate) {
		return <Outlet />
	}

	return (
		<WorkspacePage>
			<PageHeader
				title={_(t`Menu`)}
				description={_(
					t`Manage your menus, categories, items, drops, and modifier groups.`,
				)}
			/>
			<WorkspaceTabBar tabs={tabs} className="mb-2" />
			<Outlet />
		</WorkspacePage>
	)
}
