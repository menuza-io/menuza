import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { PageHeader } from '@repo/ui/page-header'
import { WorkspacePage, WorkspaceTabBar } from '@repo/ui/workspace'
import { Outlet, useLocation, useParams } from 'react-router'
import { useHasPermission } from '#app/hooks/use-organization-permissions.ts'

export default function WebsiteLayout() {
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
