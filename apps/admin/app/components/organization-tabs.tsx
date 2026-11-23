import { Trans } from '@lingui/macro'
import { Link, useLocation } from 'react-router'

/** Overview and Timeline of one restaurant in Admin (#279). */
export function OrganizationTabs({
	organizationId,
}: {
	organizationId: string
}) {
	const { pathname } = useLocation()
	const base = `/organizations/${organizationId}`
	const onTimeline = pathname.startsWith(`${base}/timeline`)
	const link = (active: boolean) =>
		`rounded-md px-3 py-1.5 text-sm font-medium ${
			active
				? 'bg-secondary text-foreground'
				: 'text-muted-foreground hover:text-foreground'
		}`
	return (
		<nav className="flex gap-1" aria-label="Restaurant sections">
			<Link
				to={base}
				className={link(!onTimeline)}
				aria-current={onTimeline ? undefined : 'page'}
			>
				<Trans>Overview</Trans>
			</Link>
			<Link
				to={`${base}/timeline`}
				className={link(onTimeline)}
				aria-current={onTimeline ? 'page' : undefined}
			>
				<Trans>Timeline</Trans>
			</Link>
		</nav>
	)
}
