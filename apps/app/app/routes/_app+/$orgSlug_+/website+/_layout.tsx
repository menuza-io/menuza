import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { PageTitle } from '@repo/ui/page-title'
import { Link, Outlet, useLocation, useParams } from 'react-router'

export default function WebsiteLayout() {
	const { _ } = useLingui()
	const location = useLocation()
	const params = useParams()
	const orgSlug = params.orgSlug

	const tabs = [
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
			isActive: location.pathname.includes(`/${orgSlug}/website/analytics`),
		},
		{
			label: _(t`Announcements`),
			href: `/${orgSlug}/website/announcements`,
			isActive: location.pathname.includes(`/${orgSlug}/website/announcements`),
		},
		{
			label: _(t`Redirects`),
			href: `/${orgSlug}/website/redirects`,
			isActive: location.pathname.includes(`/${orgSlug}/website/redirects`),
		},
	]

	// Builder routes (pages.$pageId) render full-viewport, skip the layout chrome
	const isBuilderRoute = /\/website\/pages\/[^/]+$/.test(location.pathname)

	if (isBuilderRoute) {
		return <Outlet />
	}

	return (
		<div className="mx-auto w-full max-w-6xl py-8 md:px-6 lg:px-8">
			<div className="mb-8 md:mb-10">
				<PageTitle
					title={_(t`Website`)}
					description={_(
						t`Manage your public organization website and appearance.`,
					)}
				/>
			</div>

			<nav className="border-border mb-6 [scrollbar-width:none] overflow-x-auto border-b [&::-webkit-scrollbar]:hidden">
				<div className="-mb-px flex min-w-max gap-4">
					{tabs.map((tab) => (
						<Link
							key={tab.href}
							to={tab.href}
							className={cn(
								'border-b-2 px-1 pb-3 text-sm font-medium transition-colors',
								tab.isActive
									? 'border-primary text-foreground'
									: 'text-muted-foreground hover:text-foreground border-transparent',
							)}
						>
							{tab.label}
						</Link>
					))}
				</div>
			</nav>

			<Outlet />
		</div>
	)
}
