import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type HealthCheck,
	type HealthStatus,
	type HealthSummary,
	type LocationHealth,
} from '@repo/common/location-health'
import { Badge } from '@repo/ui/badge'
import { Icon } from '@repo/ui/icon'
import { Link } from 'react-router'

type Params = Record<string, string>

/** Plain-words messages by check code, in the reader's language. */
const MESSAGES: Record<string, (params: Params) => MessageDescriptor> = {
	ordering_on: () => msg`Online ordering is on.`,
	ordering_paused: () =>
		msg`Online ordering is paused. Guests cannot order until it is resumed.`,
	open_now: () => msg`Open now by its opening hours.`,
	closed_now: () => msg`Closed right now by its opening hours.`,
	no_hours: () =>
		msg`No opening hours are set, so guests cannot tell when you are open.`,
	payments_ready: () => msg`The payments account can take card payments.`,
	pay_at_pickup_only: () =>
		msg`Guests pay at pickup (online payments are off on purpose).`,
	payments_disabled: () =>
		msg`The payments account is not active, so guests cannot pay online. Finish connecting it.`,
	menu_on_sale: () => msg`A menu is on sale here.`,
	no_active_menu: () =>
		msg`No menu is on sale at this location, so there is nothing to order.`,
	site_published: () => msg`The website is published.`,
	site_unpublished: () =>
		msg`The website is not published, so guests cannot reach your menu.`,
	domain_ok: () => msg`The custom domain works.`,
	domain_error: () =>
		msg`Your custom domain has a problem. Guests can still reach the site on its Menuza address.`,
	sync_ok: ({ provider = '' }) => msg`${provider} is connected.`,
	sync_disconnected: ({ provider = '' }) =>
		msg`${provider} is disconnected, so its orders and menu are not syncing.`,
	sync_stale: ({ provider = '' }) =>
		msg`${provider} has not synced for over two days.`,
	phone_agent_ready: () => msg`The phone agent is on and has an active line.`,
	phone_line_inactive: () =>
		msg`The phone agent is on but has no active phone line for this location.`,
}

export function useHealthMessage() {
	const { _ } = useLingui()
	return (check: HealthCheck) => {
		const make = MESSAGES[check.code]
		return make ? _(make(check.params ?? {})) : check.message
	}
}

const STATUS_ICON: Record<
	HealthStatus,
	'check' | 'info' | 'alert-triangle' | 'circle-x'
> = {
	ok: 'check',
	info: 'info',
	warning: 'alert-triangle',
	blocking: 'circle-x',
}

export function HealthSummaryBadge({ summary }: { summary: HealthSummary }) {
	switch (summary) {
		case 'taking_orders':
			return (
				<Badge variant="secondary" data-testid="health-summary">
					<Icon name="circle-check" className="size-3" />
					<Trans>Taking orders</Trans>
				</Badge>
			)
		case 'taking_orders_with_problems':
			return (
				<Badge variant="outline" data-testid="health-summary">
					<Icon name="alert-triangle" className="size-3" />
					<Trans>Taking orders with problems</Trans>
				</Badge>
			)
		case 'not_taking_orders':
			return (
				<Badge variant="destructive" data-testid="health-summary">
					<Icon name="circle-x" className="size-3" />
					<Trans>Not taking orders</Trans>
				</Badge>
			)
	}
}

/** One location: its summary and every check, failing ones with a fix link. */
export function LocationHealthCard({
	health,
	orgSlug,
	compact = false,
}: {
	health: LocationHealth
	orgSlug: string
	/** Only the problems (the dashboard card). */
	compact?: boolean
}) {
	const message = useHealthMessage()
	const shown = compact
		? health.checks.filter(
				(check) => check.status === 'blocking' || check.status === 'warning',
			)
		: health.checks
	return (
		<div
			className="bg-card space-y-2 rounded-md border p-3"
			data-testid="location-health"
			data-location-id={health.locationId}
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="font-medium wrap-anywhere">{health.name}</h3>
				<div className="flex flex-wrap items-center gap-2">
					{health.closedNow ? (
						<Badge variant="outline">
							<Trans>Closed now</Trans>
						</Badge>
					) : null}
					<HealthSummaryBadge summary={health.summary} />
				</div>
			</div>
			{health.allPassed && !compact ? (
				<p
					className="text-muted-foreground text-sm"
					data-testid="all-checks-passed"
				>
					<Trans>All checks passed.</Trans>
				</p>
			) : null}
			{shown.length > 0 ? (
				<ul className="space-y-1.5">
					{shown.map((check, index) => (
						<li
							key={`${check.id}-${index}`}
							className="flex items-start gap-2 text-sm"
							data-check={check.code}
							data-status={check.status}
						>
							<Icon
								name={STATUS_ICON[check.status]}
								className="mt-0.5 size-4 shrink-0"
							/>
							<span className="min-w-0 flex-1 wrap-anywhere">
								{message(check)}
							</span>
							{check.href && check.status !== 'ok' ? (
								<Link
									to={`/${orgSlug}${check.href}`}
									className="text-primary shrink-0 underline-offset-4 hover:underline"
								>
									<Trans>Fix</Trans>
								</Link>
							) : null}
						</li>
					))}
				</ul>
			) : null}
		</div>
	)
}
