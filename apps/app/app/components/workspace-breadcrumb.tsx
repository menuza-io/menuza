import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Icon } from '@repo/ui/icon'
import { type ReactNode } from 'react'
import { Link, useLocation, useMatches, useParams } from 'react-router'
import { breadcrumbFromHandle } from '#app/utils/breadcrumb.ts'

const SEGMENT_LABELS: Record<string, ReactNode> = {
	notes: <Trans>Notes</Trans>,
	customers: <Trans>Customers</Trans>,
	settings: <Trans>Settings</Trans>,
	website: <Trans>Website</Trans>,
	marketing: <Trans>Marketing</Trans>,
	'phone-agent': <Trans>Phone agent</Trans>,
	staff: <Trans>Staff</Trans>,
	reports: <Trans>Reports</Trans>,
	mailbox: <Trans>Mailbox</Trans>,
	chat: <Trans>Chat</Trans>,
	media: <Trans>Media library</Trans>,
	dashboards: <Trans>Dashboards</Trans>,
	new: <Trans>New</Trans>,
	edit: <Trans>Edit</Trans>,
	// Staff
	team: <Trans>Team</Trans>,
	positions: <Trans>Positions</Trans>,
	import: <Trans>Import</Trans>,
	bulk: <Trans>Bulk add</Trans>,
	timeclock: <Trans>Time clock</Trans>,
	timesheets: <Trans>Timesheets</Trans>,
	tablets: <Trans>Tablets</Trans>,
	rules: <Trans>Labor rules</Trans>,
	schedule: <Trans>Schedule</Trans>,
	'time-off': <Trans>Time off</Trans>,
	availability: <Trans>Availability</Trans>,
	labor: <Trans>Labor</Trans>,
	hiring: <Trans>Hiring</Trans>,
	applicants: <Trans>Applicants</Trans>,
	onboarding: <Trans>Onboarding</Trans>,
	terminate: <Trans>Terminate</Trans>,
	rehire: <Trans>Rehire</Trans>,
	// Marketing
	campaigns: <Trans>Broadcasts</Trans>,
	automations: <Trans>Automations</Trans>,
	// Phone agent
	calls: <Trans>Calls</Trans>,
	knowledge: <Trans>Knowledge</Trans>,
	training: <Trans>Training rules</Trans>,
	flow: <Trans>Call flow</Trans>,
	transfers: <Trans>Transfers</Trans>,
	'follow-up': <Trans>Follow-up</Trans>,
	phrases: <Trans>Phrases</Trans>,
	advanced: <Trans>Advanced</Trans>,
	test: <Trans>Test call</Trans>,
	// Website
	pages: <Trans>Pages</Trans>,
	forms: <Trans>Forms</Trans>,
	analytics: <Trans>Analytics</Trans>,
	announcements: <Trans>Announcements</Trans>,
	redirects: <Trans>Redirects</Trans>,
	// Settings
	general: <Trans>General</Trans>,
	members: <Trans>Members</Trans>,
	roles: <Trans>Roles & access</Trans>,
	integrations: <Trans>Integrations</Trans>,
	notifications: <Trans>Notifications</Trans>,
	billing: <Trans>Billing</Trans>,
	shop: <Trans>Shop</Trans>,
	mcp: <Trans>MCP server</Trans>,
	runs: <Trans>Runs</Trans>,
	status: <Trans>Status</Trans>,
	// Reservations
	reservations: <Trans>Reservations</Trans>,
	today: <Trans>Today</Trans>,
	book: <Trans>Book</Trans>,
	timeline: <Trans>Timeline</Trans>,
	floor: <Trans>Floor</Trans>,
	calendar: <Trans>Calendar</Trans>,
	overview: <Trans>Overview</Trans>,
	waitlist: <Trans>Waitlist</Trans>,
	guests: <Trans>Guests</Trans>,
	experiences: <Trans>Experiences</Trans>,
	tables: <Trans>Tables</Trans>,
	'floor-plan': <Trans>Floor plan</Trans>,
	sections: <Trans>Sections</Trans>,
	services: <Trans>Services</Trans>,
	'special-days': <Trans>Special days</Trans>,
	policies: <Trans>Payment policies</Trans>,
}

// What a record id under each collection is called when its route gives no name.
const RECORD_LABELS: Record<string, ReactNode> = {
	dashboards: <Trans>Dashboard</Trans>,
	reports: <Trans>Report</Trans>,
	notes: <Trans>Note</Trans>,
	status: <Trans>Status</Trans>,
	campaigns: <Trans>Broadcast</Trans>,
	automations: <Trans>Automation</Trans>,
	roles: <Trans>Role</Trans>,
	pages: <Trans>Page</Trans>,
	forms: <Trans>Form</Trans>,
	team: <Trans>Staff member</Trans>,
	hiring: <Trans>Job post</Trans>,
	applicants: <Trans>Applicant</Trans>,
	timesheets: <Trans>Time card</Trans>,
	experiences: <Trans>Experience</Trans>,
}

// Path prefixes with no page of their own. `notes/status` would be read as a
// note id and show "note not found", so its crumb is text, not a link.
const UNLINKED_PREFIXES = new Set(['notes/status'])

function isWordSegment(segment: string) {
	return /^[a-z]+(?:-[a-z]+)*$/.test(segment)
}

function labelForSegment(segment: string, isOrgRoot: boolean) {
	if (isOrgRoot) return <Trans>Home</Trans>
	// Own keys only: `constructor` or `toString` in a URL must not resolve to
	// an inherited function.
	const known = Object.hasOwn(SEGMENT_LABELS, segment)
		? SEGMENT_LABELS[segment]
		: undefined
	if (known) return known
	// Unknown word-like segments read as sentence case.
	const words = segment.replace(/-/g, ' ')
	return words.charAt(0).toUpperCase() + words.slice(1)
}

export function WorkspaceBreadcrumb({ className }: { className?: string }) {
	const { _ } = useLingui()
	const { pathname } = useLocation()
	const matches = useMatches()
	const { orgSlug } = useParams()
	const navLabel = _(msg`Breadcrumb`)
	const parts = pathname.split('/').filter(Boolean)

	// Record ids show the route's own name for the record (handle.breadcrumb),
	// else what the collection calls one ("Dashboard"), never the raw id.
	function labelForRecord(href: string, parentSegment: string | undefined) {
		for (let i = matches.length - 1; i >= 0; i--) {
			const match = matches[i]
			if (!match) continue
			const path = match.pathname.replace(/\/$/, '')
			if (path !== href && !path.startsWith(`${href}/`)) continue
			const label = breadcrumbFromHandle(match.handle, match.loaderData)
			if (label) return label
		}
		return (
			(parentSegment && Object.hasOwn(RECORD_LABELS, parentSegment)
				? RECORD_LABELS[parentSegment]
				: undefined) ?? <Trans>Details</Trans>
		)
	}

	if (parts.length === 0) {
		return (
			<nav aria-label={navLabel} className={cn('text-sm', className)}>
				<span className="font-medium">
					<Trans>Home</Trans>
				</span>
			</nav>
		)
	}

	const crumbs: { href: string; label: ReactNode; linked: boolean }[] = []

	// `/profile` and `/security` share this chrome but are not organizations,
	// so only a matched `$orgSlug` route gets the Home crumb and its offset.
	const start = orgSlug ? 1 : 0
	if (orgSlug) {
		crumbs.push({
			href: `/${parts[0]}`,
			label: <Trans>Home</Trans>,
			linked: true,
		})
	}
	for (let i = start; i < parts.length; i++) {
		const segment = parts[i]
		if (!segment || segment.startsWith('_')) continue
		const href = `/${parts.slice(0, i + 1).join('/')}`
		const isKnownWord =
			Object.hasOwn(SEGMENT_LABELS, segment) || isWordSegment(segment)
		crumbs.push({
			href,
			linked: !UNLINKED_PREFIXES.has(parts.slice(start, i + 1).join('/')),
			label: isKnownWord
				? labelForSegment(segment, false)
				: labelForRecord(href, parts[i - 1]),
		})
	}

	return (
		<nav aria-label={navLabel} className={cn('min-w-0 text-[13px]', className)}>
			<ol className="flex min-w-0 items-center gap-1.5">
				{crumbs.map((crumb, index) => {
					const isLast = index === crumbs.length - 1
					const title =
						typeof crumb.label === 'string' ? crumb.label : undefined
					return (
						<li
							key={crumb.href}
							className={cn(
								'flex min-w-0 items-center gap-1.5',
								isLast && 'font-medium',
							)}
						>
							{isLast ? (
								<span aria-current="page" title={title} className="truncate">
									{crumb.label}
								</span>
							) : crumb.linked ? (
								<Link
									to={crumb.href}
									title={title}
									className="text-muted-foreground hover:text-foreground truncate transition-colors"
								>
									{crumb.label}
								</Link>
							) : (
								<span title={title} className="text-muted-foreground truncate">
									{crumb.label}
								</span>
							)}
							{isLast ? null : (
								<Icon
									name="chevron-right"
									aria-hidden="true"
									className="text-muted-foreground size-3.5 shrink-0 opacity-60"
								/>
							)}
						</li>
					)
				})}
			</ol>
		</nav>
	)
}
