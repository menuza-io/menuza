import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { PageHeader } from '@repo/ui/page-header'
import { WorkspacePage, WorkspaceTabBar } from '@repo/ui/workspace'
import {
	type LoaderFunctionArgs,
	Outlet,
	useLocation,
	useParams,
} from 'react-router'
import { requireMenuRead } from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	await requireMenuRead(request, organization.id)
	return null
}

export default function MenuLayout() {
	const { _ } = useLingui()
	const location = useLocation()
	const params = useParams()
	const orgSlug = params.orgSlug

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
