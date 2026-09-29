import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { requireUserWithRole } from '@repo/auth'
import {
	Note,
	Organization,
	OrganizationNote,
	Session,
	User,
	count,
	db,
	eq,
	gt,
} from '@repo/database'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Link } from 'react-router'
import { type Route } from './+types/index.ts'

export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

export async function loader({ request }: Route.LoaderArgs) {
	await requireUserWithRole(request, 'admin')

	// Get key metrics and system status
	const [
		totalUsers,
		totalOrganizations,
		activeOrganizations,
		totalNotes,
		totalSessions,
		recentUsers,
		recentOrganizations,
		subscriptionStats,
	] = await Promise.all([
		// Total users count
		db
			.select({ count: count() })
			.from(User)
			.then(([row]) => row?.count ?? 0),

		// Total organizations count
		db
			.select({ count: count() })
			.from(Organization)
			.then(([row]) => row?.count ?? 0),

		// Active organizations count
		db
			.select({ count: count() })
			.from(Organization)
			.where(eq(Organization.active, true))
			.then(([row]) => row?.count ?? 0),

		// Total notes count (personal + organization)
		Promise.all([
			db.select({ count: count() }).from(Note),
			db.select({ count: count() }).from(OrganizationNote),
		]).then(
			([personal, org]) => (personal[0]?.count ?? 0) + (org[0]?.count ?? 0),
		),

		// Active sessions count
		db
			.select({ count: count() })
			.from(Session)
			.where(gt(Session.expirationDate, new Date()))
			.then(([row]) => row?.count ?? 0),

		// Recent users (last 7 days)
		db
			.select({ count: count() })
			.from(User)
			.where(gt(User.createdAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)))
			.then(([row]) => row?.count ?? 0),

		// Recent organizations (last 7 days)
		db
			.select({ count: count() })
			.from(Organization)
			.where(
				gt(
					Organization.createdAt,
					new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
				),
			)
			.then(([row]) => row?.count ?? 0),

		// Subscription statistics
		db
			.select({
				subscriptionStatus: Organization.subscriptionStatus,
				_count: { subscriptionStatus: count(Organization.subscriptionStatus) },
			})
			.from(Organization)
			.groupBy(Organization.subscriptionStatus),
	])

	return {
		metrics: {
			totalUsers,
			totalOrganizations,
			activeOrganizations,
			totalNotes,
			totalSessions,
			recentUsers,
			recentOrganizations,
			subscriptionStats,
		},
	}
}

export default function AdminDashboard({ loaderData }: Route.ComponentProps) {
	const { metrics } = loaderData
	const { _ } = useLingui()
	const recentUsers = metrics.recentUsers
	const active = metrics.activeOrganizations
	const recent = metrics.recentOrganizations

	return (
		<div className="space-y-6">
			<div className="mb-8">
				<h1 className="text-foreground text-3xl font-bold">
					<Trans>Admin Dashboard</Trans>
				</h1>
				<p className="text-muted-foreground mt-2">
					<Trans>Manage users, organizations, and system settings</Trans>
				</p>
			</div>

			{/* Key Metrics Section */}
			<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Total Users</Trans>
						</CardTitle>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth="2"
							className="text-muted-foreground h-4 w-4"
							aria-hidden="true"
						>
							<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
							<circle cx="9" cy="7" r="4" />
							<path d="M22 21v-2a4 4 0 0 0-3-3.87" />
							<path d="M16 3.13a4 4 0 0 1 0 7.75" />
						</svg>
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{metrics.totalUsers.toLocaleString()}
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>+{recentUsers} new this week</Trans>
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Organizations</Trans>
						</CardTitle>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth="2"
							className="text-muted-foreground h-4 w-4"
							aria-hidden="true"
						>
							<path d="M3 21h18" />
							<path d="M5 21V7l8-4v18" />
							<path d="M19 21V11l-6-4" />
						</svg>
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{metrics.totalOrganizations.toLocaleString()}
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>
								{active} active • +{recent} new this week
							</Trans>
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Total Notes</Trans>
						</CardTitle>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth="2"
							className="text-muted-foreground h-4 w-4"
							aria-hidden="true"
						>
							<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
							<polyline points="14,2 14,8 20,8" />
							<line x1="16" y1="13" x2="8" y2="13" />
							<line x1="16" y1="17" x2="8" y2="17" />
							<polyline points="10,9 9,9 8,9" />
						</svg>
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{metrics.totalNotes.toLocaleString()}
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>Personal + Organization notes</Trans>
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Active Sessions</Trans>
						</CardTitle>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth="2"
							className="text-muted-foreground h-4 w-4"
							aria-hidden="true"
						>
							<circle cx="12" cy="12" r="3" />
							<path d="M12 1v6m0 6v6" />
							<path d="m15.14 8.86 4.24-4.24M4.62 19.38l4.24-4.24M16.86 15.14l4.24 4.24M4.62 4.62l4.24 4.24" />
						</svg>
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{metrics.totalSessions.toLocaleString()}
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>Currently logged in users</Trans>
						</p>
					</CardContent>
				</Card>
			</div>

			{/* Subscription Status */}
			{metrics.subscriptionStats.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="text-lg font-medium">
							<Trans>Subscription Status</Trans>
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="grid gap-4 md:grid-cols-3">
							{metrics.subscriptionStats.map(
								(stat: (typeof metrics.subscriptionStats)[number]) => (
									<div
										key={stat.subscriptionStatus || 'none'}
										className="text-center"
									>
										<div className="text-2xl font-bold">
											{stat._count.subscriptionStatus}
										</div>
										<p className="text-muted-foreground text-sm capitalize">
											{stat.subscriptionStatus || _(msg`No Subscription`)}
										</p>
									</div>
								),
							)}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Management Cards */}
			<div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
				<Card className="transition-shadow">
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Users</Trans>
						</CardTitle>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth="2"
							className="text-muted-foreground h-4 w-4"
						>
							<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
							<circle cx="9" cy="7" r="4" />
							<path d="M22 21v-2a4 4 0 0 0-3-3.87" />
							<path d="M16 3.13a4 4 0 0 1 0 7.75" />
						</svg>
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							<Trans>Manage Users</Trans>
						</div>
						<p className="text-muted-foreground mt-1 text-xs">
							<Trans>View, search, and manage user accounts</Trans>
						</p>
						<Link
							to="/users"
							className="text-primary mt-2 inline-flex items-center text-sm hover:underline"
						>
							<Trans>View Users →</Trans>
						</Link>
					</CardContent>
				</Card>

				<Card className="transition-shadow">
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Organizations</Trans>
						</CardTitle>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth="2"
							className="text-muted-foreground h-4 w-4"
						>
							<path d="M3 21h18" />
							<path d="M5 21V7l8-4v18" />
							<path d="M19 21V11l-6-4" />
						</svg>
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							<Trans>Manage Organizations</Trans>
						</div>
						<p className="text-muted-foreground mt-1 text-xs">
							<Trans>View organization details and subscriptions</Trans>
						</p>
						<Link
							to="/organizations"
							className="text-primary mt-2 inline-flex items-center text-sm hover:underline"
						>
							<Trans>View Organizations →</Trans>
						</Link>
					</CardContent>
				</Card>

				<Card className="transition-shadow">
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Cache</Trans>
						</CardTitle>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth="2"
							className="text-muted-foreground h-4 w-4"
						>
							<ellipse cx="12" cy="5" rx="9" ry="3" />
							<path d="M3 5v14a9 3 0 0 0 18 0V5" />
							<path d="M3 12a9 3 0 0 0 18 0" />
						</svg>
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							<Trans>Cache Management</Trans>
						</div>
						<p className="text-muted-foreground mt-1 text-xs">
							<Trans>Monitor and manage system cache</Trans>
						</p>
						<Link
							to="/cache"
							className="text-primary mt-2 inline-flex items-center text-sm hover:underline"
						>
							<Trans>Manage Cache →</Trans>
						</Link>
					</CardContent>
				</Card>
			</div>

			{/* Quick Actions */}
			<div className="mt-8">
				<h2 className="mb-4 text-xl">
					<Trans>Quick Actions</Trans>
				</h2>
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					<Link
						to="/users"
						className="hover:bg-muted/50 flex items-center rounded-lg border p-4 transition-colors"
					>
						<div className="mr-3">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth="2"
								className="h-5 w-5"
								aria-hidden="true"
							>
								<circle cx="11" cy="11" r="8" />
								<path d="M21 21l-4.35-4.35" />
							</svg>
						</div>
						<div>
							<div className="font-medium">
								<Trans>Search Users</Trans>
							</div>
							<div className="text-muted-foreground text-sm">
								<Trans>Find and manage user accounts</Trans>
							</div>
						</div>
					</Link>

					<Link
						to="/organizations"
						className="hover:bg-muted/50 flex items-center rounded-lg border p-4 transition-colors"
					>
						<div className="mr-3">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth="2"
								className="h-5 w-5"
							>
								<path d="M3 21h18" />
								<path d="M5 21V7l8-4v18" />
								<path d="M19 21V11l-6-4" />
							</svg>
						</div>
						<div>
							<div className="font-medium">
								<Trans>View Organizations</Trans>
							</div>
							<div className="text-muted-foreground text-sm">
								<Trans>Monitor organization activity</Trans>
							</div>
						</div>
					</Link>

					<Link
						to="/cache"
						className="hover:bg-muted/50 flex items-center rounded-lg border p-4 transition-colors"
					>
						<div className="mr-3">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth="2"
								className="h-5 w-5"
							>
								<ellipse cx="12" cy="5" rx="9" ry="3" />
								<path d="M3 5v14a9 3 0 0 0 18 0V5" />
								<path d="M3 12a9 3 0 0 0 18 0" />
							</svg>
						</div>
						<div>
							<div className="font-medium">
								<Trans>Clear Cache</Trans>
							</div>
							<div className="text-muted-foreground text-sm">
								<Trans>Manage system performance</Trans>
							</div>
						</div>
					</Link>
				</div>
			</div>
		</div>
	)
}
