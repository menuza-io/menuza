import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { PageTitle } from '@repo/ui/page-title'
import {
	data,
	Link,
	type LoaderFunctionArgs,
	Outlet,
	useLoaderData,
	useLocation,
} from 'react-router'
import { getStaffingAccess } from '#app/utils/staffing/access.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await getStaffingAccess(request, params.orgSlug)
	if (!access.flags.enabled) throw new Response('Not found', { status: 404 })
	if (!Object.values(access.grants).some(Boolean)) {
		throw new Response('Forbidden', { status: 403 })
	}
	return data(
		{
			orgSlug: params.orgSlug || '',
			grants: access.grants,
			flags: access.flags,
			canViewPay: access.canViewPay,
			impersonating: access.impersonating,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

export default function StaffingLayout() {
	const { orgSlug, grants, flags, canViewPay, impersonating } =
		useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const location = useLocation()
	const base = `/${orgSlug}/staffing`
	const tabs = [
		canViewPay ? { label: _(msg`Overview`), href: base, exact: true } : null,
		grants.staff ? { label: _(msg`Team`), href: `${base}/team` } : null,
		grants.schedule
			? { label: _(msg`Schedule`), href: `${base}/schedule` }
			: null,
		grants.timeclock
			? { label: _(msg`Timesheets`), href: `${base}/timesheets` }
			: null,
		grants.timeclock && flags.timeclock
			? { label: _(msg`Time clocks`), href: `${base}/kiosks` }
			: null,
	].filter((tab): tab is NonNullable<typeof tab> => tab !== null)

	return (
		<div className="mx-auto w-full max-w-7xl py-8 md:px-6 lg:px-8 print:max-w-none print:p-0">
			<div className="mb-6 print:hidden">
				<PageTitle
					title={_(msg`Staff`)}
					description={_(
						msg`Your team, schedules, and time clock. Staff records stay in your organization’s data region.`,
					)}
				/>
			</div>
			{impersonating ? (
				<p
					role="status"
					className="bg-muted mb-4 rounded-md p-3 text-sm print:hidden"
				>
					{_(
						msg`You are impersonating this user. Staff data is read-only during support sessions.`,
					)}
				</p>
			) : null}
			<nav className="border-border mb-6 overflow-x-auto border-b print:hidden">
				<div className="-mb-px flex min-w-max gap-4">
					{tabs.map((tab) => {
						const active =
							'exact' in tab
								? location.pathname === tab.href ||
									location.pathname === `${tab.href}/`
								: location.pathname.startsWith(tab.href)
						return (
							<Link
								key={tab.href}
								to={tab.href}
								aria-current={active ? 'page' : undefined}
								className={cn(
									'border-b-2 px-1 pb-3 text-sm font-medium transition-colors',
									active
										? 'border-primary text-foreground'
										: 'text-muted-foreground hover:text-foreground border-transparent',
								)}
							>
								{tab.label}
							</Link>
						)
					})}
				</div>
			</nav>
			<Outlet />
		</div>
	)
}
