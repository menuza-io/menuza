import { Plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Skeleton } from '@repo/ui/skeleton'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import {
	fetchPeopleSummary,
	type PeopleClient,
	type PeopleSummary,
} from '#app/utils/people/people-api.ts'

/** The group a summary tile selects in the list below. */
export type PeopleSummaryGroup = 'returning' | 'email' | 'sms'

function ChangeText({ change }: { change: number }) {
	if (change > 0) {
		return (
			<Plural
				value={change}
				one="+# in the last 30 days"
				other="+# in the last 30 days"
			/>
		)
	}
	if (change < 0) {
		return (
			<Plural
				value={Math.abs(change)}
				one="−# in the last 30 days"
				other="−# in the last 30 days"
			/>
		)
	}
	return <Trans>No change in the last 30 days</Trans>
}

function Tile({
	id,
	label,
	total,
	change,
	extra,
	active,
	toggle = true,
	onClick,
}: {
	id: string
	label: ReactNode
	total: number
	change: number
	extra?: ReactNode
	active: boolean
	/** False for the "show all" tile, which is a plain button, not a toggle. */
	toggle?: boolean
	onClick: () => void
}) {
	const { i18n } = useLingui()
	return (
		<button
			type="button"
			aria-pressed={toggle ? active : undefined}
			onClick={onClick}
			data-testid={`customers-summary-${id}`}
			className={cn(
				'focus-visible:ring-ring/50 flex min-h-24 flex-col items-start gap-1 rounded-lg border p-3 text-start transition-colors outline-none focus-visible:ring-3',
				active
					? 'border-primary bg-accent'
					: 'bg-card hover:bg-accent/50 border-border',
			)}
		>
			<span className="text-muted-foreground text-xs">{label}</span>
			<span
				className="text-2xl font-semibold tabular-nums"
				data-testid={`customers-summary-${id}-total`}
			>
				<bdi>{new Intl.NumberFormat(i18n.locale).format(total)}</bdi>
			</span>
			{extra ? (
				<span className="text-muted-foreground text-xs">{extra}</span>
			) : null}
			<span
				className={cn(
					'text-xs tabular-nums',
					change > 0 ? 'text-foreground' : 'text-muted-foreground',
				)}
				data-testid={`customers-summary-${id}-change`}
			>
				<ChangeText change={change} />
			</span>
		</button>
	)
}

/**
 * Four totals above the Customers list. Counts only (no names), fetched by the
 * browser from the regional tenant-api; it never blocks the list. A tile
 * filters the list; the active tile (or none for Guests) is `group`.
 */
export function PeopleSummaryRow({
	client,
	group,
	onSelect,
}: {
	client: PeopleClient
	/** The current list group; null is the default list (Guests). */
	group: PeopleSummaryGroup | null
	/** Called with the group to show, or null for the default list. */
	onSelect: (group: PeopleSummaryGroup | null) => void
}) {
	const { i18n } = useLingui()
	const [summary, setSummary] = useState<PeopleSummary | null>(null)
	const [failed, setFailed] = useState(false)
	const [attempt, setAttempt] = useState(0)

	useEffect(() => {
		const controller = new AbortController()
		setFailed(false)
		fetchPeopleSummary(client, controller.signal)
			.then((next) => setSummary(next))
			.catch(() => {
				if (!controller.signal.aborted) setFailed(true)
			})
		return () => controller.abort()
	}, [client, attempt])

	const retry = useCallback(() => {
		setSummary(null)
		setAttempt((n) => n + 1)
	}, [])

	const grid = 'grid grid-cols-2 gap-3 lg:grid-cols-4'

	if (failed) {
		return (
			<div
				className="text-muted-foreground flex min-h-24 flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
				role="status"
				aria-live="polite"
				data-testid="customers-summary-error"
			>
				<Trans>Couldn't load totals</Trans>
				<Button type="button" size="sm" variant="outline" onClick={retry}>
					<Trans>Retry</Trans>
				</Button>
			</div>
		)
	}

	if (!summary) {
		return (
			<div
				className={grid}
				aria-busy="true"
				data-testid="customers-summary-loading"
			>
				<span className="sr-only" role="status">
					<Trans>Loading totals...</Trans>
				</span>
				{[0, 1, 2, 3].map((tile) => (
					<Skeleton key={tile} className="h-24 rounded-lg" />
				))}
			</div>
		)
	}

	const toggle = (next: PeopleSummaryGroup) =>
		onSelect(group === next ? null : next)
	const share = new Intl.NumberFormat(i18n.locale, {
		style: 'percent',
		maximumFractionDigits: 0,
	}).format(summary.returningGuests.share)

	return (
		<div className="flex flex-col gap-2" data-testid="customers-summary">
			<div className={grid}>
				<Tile
					id="guests"
					label={<Trans>Guests</Trans>}
					total={summary.guests.total}
					change={summary.guests.change30d}
					active={group === null}
					toggle={false}
					onClick={() => onSelect(null)}
				/>
				<Tile
					id="returning"
					label={<Trans>Returning guests</Trans>}
					total={summary.returningGuests.total}
					change={summary.returningGuests.change30d}
					extra={
						<Trans>
							<bdi>{share}</bdi> of guests
						</Trans>
					}
					active={group === 'returning'}
					onClick={() => toggle('returning')}
				/>
				<Tile
					id="email"
					label={<Trans>Email subscribers</Trans>}
					total={summary.emailSubscribers.total}
					change={summary.emailSubscribers.change30d}
					active={group === 'email'}
					onClick={() => toggle('email')}
				/>
				<Tile
					id="sms"
					label={<Trans>Text subscribers</Trans>}
					total={summary.textSubscribers.total}
					change={summary.textSubscribers.change30d}
					active={group === 'sms'}
					onClick={() => toggle('sms')}
				/>
			</div>
			{summary.locationScoped ? (
				<p
					className="text-muted-foreground text-xs"
					data-testid="customers-summary-scoped"
				>
					<Trans>Totals for your locations</Trans>
				</p>
			) : null}
		</div>
	)
}
