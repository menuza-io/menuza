import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { PageHeader } from '@repo/ui/page-header'
import { WorkspacePage, WorkspaceTabBar } from '@repo/ui/workspace'
import {
	type LoaderFunctionArgs,
	Outlet,
	useLoaderData,
	useLocation,
	useParams,
} from 'react-router'
import { useHasPermission } from '#app/hooks/use-organization-permissions.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { getLandingFeatures } from '#app/utils/seo/landing-pages.server.ts'

/** Which optional Website tabs this organization has (#184 events). */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	const features = await getLandingFeatures(organization.id)
	return { events: features.events, areaPages: features.areaPages }
}

export default function WebsiteLayout() {
	const features = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const location = useLocation()
	const params = useParams()
	const orgSlug = params.orgSlug
	const hasPermission = useHasPermission()
	const canReadWebsite = hasPermission('read:website:any')
	const canReadAnnouncements = hasPermission('read:announcement:any')

	const tabs = [
		...(canReadWebsite
			? [
					{
						label: _(t`General Settings`),
						href: `/${orgSlug}/website`,
						isActive:
							location.pathname === `/${orgSlug}/website` ||
							location.pathname === `/${orgSlug}/website/`,
					},
					{
						label: _(t`Domain`),
						href: `/${orgSlug}/website/domain`,
						isActive: location.pathname.includes(`/${orgSlug}/website/domain`),
					},
					{
						label: _(t`Pages`),
						href: `/${orgSlug}/website/pages`,
						isActive: location.pathname.includes(`/${orgSlug}/website/pages`),
					},
					{
						label: _(t`Forms`),
						href: `/${orgSlug}/website/forms`,
						isActive: location.pathname.includes(`/${orgSlug}/website/forms`),
					},
					{
						label: _(t`Analytics`),
						href: `/${orgSlug}/website/analytics`,
						isActive: location.pathname.includes(
							`/${orgSlug}/website/analytics`,
						),
					},
					{
						label: _(t`SEO`),
						href: `/${orgSlug}/website/seo`,
						isActive: location.pathname.includes(`/${orgSlug}/website/seo`),
					},
					...(features?.events
						? [
								{
									label: _(t`Events`),
									href: `/${orgSlug}/website/events`,
									isActive: location.pathname.includes(
										`/${orgSlug}/website/events`,
									),
								},
							]
						: []),
					...(features?.areaPages
						? [
								{
									label: _(t`Area pages`),
									href: `/${orgSlug}/website/area-pages`,
									isActive: location.pathname.includes(
										`/${orgSlug}/website/area-pages`,
									),
								},
							]
						: []),
				]
			: []),
		...(canReadAnnouncements
			? [
					{
						label: _(t`Announcements`),
						href: `/${orgSlug}/website/announcements`,
						isActive: location.pathname.includes(
							`/${orgSlug}/website/announcements`,
						),
					},
				]
			: []),
		...(canReadWebsite
			? [
					{
						label: _(t`Redirects`),
						href: `/${orgSlug}/website/redirects`,
						isActive: location.pathname.includes(
							`/${orgSlug}/website/redirects`,
						),
					},
					{
						label: _(t`Legal pages`),
						href: `/${orgSlug}/website/legal`,
						isActive: location.pathname.includes(`/${orgSlug}/website/legal`),
					},
					{
						label: _(t`Activity`),
						href: `/${orgSlug}/website/activity`,
						isActive: location.pathname.includes(
							`/${orgSlug}/website/activity`,
						),
					},
				]
			: []),
	]

	// Builders render full-viewport and skip the website settings chrome.
	const isBuilderRoute =
		/\/website\/pages\/[^/]+$/.test(location.pathname) ||
		/\/website\/forms\/[^/]+$/.test(location.pathname)

	if (isBuilderRoute) {
		return <Outlet />
	}

	return (
		<WorkspacePage>
			<PageHeader
				title={_(t`Website`)}
				description={_(
					t`Manage your public organization website and appearance.`,
				)}
			/>
			<WorkspaceTabBar tabs={tabs} className="mb-2" />
			<Outlet />
		</WorkspacePage>
	)
}
