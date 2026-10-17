import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Card, CardContent } from '@repo/ui/card'
import { Skeleton } from '@repo/ui/skeleton'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { type BookingsTodayLocation } from '#app/utils/dashboards/bookings-today.ts'
import {
	type BookingsToday,
	fetchBookingsToday,
} from '#app/utils/reservations/bookings-today-api.ts'
import {
	enumLabel,
	RESERVATION_STATUS_LABELS,
} from '#app/utils/reservations/labels.ts'
import { createReservationsClientPool } from '#app/utils/reservations/reservations-client.ts'

export const BOOKINGS_TODAY_REFRESH_MS = 60_000

const STATUS_ORDER = [
	'booked',
	'confirmed',
	'arrived',
	'seated',
	'partially_seated',
	'finished',
	'completed',
	'no_show',
	'cancelled',
	'pending_approval',
	'requested',
	'pending_payment',
	'declined',
	'expired',
]

function orderedCounts(counts: Record<string, number>) {
	const known = STATUS_ORDER.filter((status) => (counts[status] ?? 0) > 0)
	const extra = Object.keys(counts)
		.filter((status) => !STATUS_ORDER.includes(status) && counts[status]! > 0)
		.sort()
	return [...known, ...extra].map((status) => ({
		status,
		count: counts[status]!,
	}))
}

type State =
	| { kind: 'loading' }
	| { kind: 'ready'; data: BookingsToday }
	| { kind: 'error' }

/**
 * Today's reservations for one location, read from tenant-api in the browser
 * (never through an App loader) and refreshed every minute.
 */
export function BookingsTodayBlock({
	orgSlug,
	locations,
}: {
	orgSlug: string
	locations: readonly BookingsTodayLocation[]
}) {
	const { _ } = useLingui()
	const [locationId, setLocationId] = useState(locations[0]?.id ?? '')
	const [state, setState] = useState<State>({ kind: 'loading' })
	const client = useMemo(
		() => createReservationsClientPool({ orgSlug }).forScope('book'),
		[orgSlug],
	)

	useEffect(() => {
		if (!locationId) return
		let cancelled = false
		let controller = new AbortController()
		const load = async () => {
			controller.abort()
			controller = new AbortController()
			const signal = controller.signal
			try {
				const data = await fetchBookingsToday(client, locationId, signal)
				if (!cancelled && !signal.aborted) setState({ kind: 'ready', data })
			} catch {
				if (!cancelled && !signal.aborted) {
					setState((previous) =>
						previous.kind === 'ready' ? previous : { kind: 'error' },
					)
				}
			}
		}
		void load()
		const timer = window.setInterval(
			() => void load(),
			BOOKINGS_TODAY_REFRESH_MS,
		)
		return () => {
			cancelled = true
			controller.abort()
			window.clearInterval(timer)
		}
	}, [client, locationId])

	return (
		<Card className="h-full overflow-auto" data-testid="bookings-today-block">
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h3 className="text-sm font-semibold">
						<Trans>Bookings today</Trans>
					</h3>
					{locations.length > 1 ? (
						<select
							value={locationId}
							onChange={(event) => {
								setState({ kind: 'loading' })
								setLocationId(event.target.value)
							}}
							aria-label={_(msg`Location`)}
							className="border-input bg-background text-foreground h-8 rounded-md border px-2 text-xs"
							data-testid="bookings-today-location"
						>
							{locations.map((location) => (
								<option key={location.id} value={location.id}>
									{location.name}
								</option>
							))}
						</select>
					) : null}
				</div>
				{state.kind === 'loading' ? (
					<Skeleton className="h-24 rounded-lg" aria-hidden="true" />
				) : state.kind === 'error' ? (
					<p
						className="text-muted-foreground text-sm"
						role="status"
						data-testid="bookings-today-error"
					>
						<Trans>Today's bookings could not be loaded.</Trans>
					</p>
				) : (
					<BookingsTodayBody data={state.data} orgSlug={orgSlug} />
				)}
			</CardContent>
		</Card>
	)
}

function BookingsTodayBody({
	data,
	orgSlug,
}: {
	data: BookingsToday
	orgSlug: string
}) {
	const { _ } = useLingui()
	const counts = orderedCounts(data.counts)
	return (
		<>
			<dl className="grid grid-cols-3 gap-3">
				<div>
					<dt className="text-muted-foreground text-xs">
						<Trans>Parties</Trans>
					</dt>
					<dd
						className="text-xl font-semibold tabular-nums"
						data-testid="bookings-today-parties"
					>
						<bdi>{data.totalParties}</bdi>
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground text-xs">
						<Trans>Covers</Trans>
					</dt>
					<dd
						className="text-xl font-semibold tabular-nums"
						data-testid="bookings-today-covers"
					>
						<bdi>{data.totalCovers}</bdi>
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground text-xs">
						<Trans>On the waitlist</Trans>
					</dt>
					<dd
						className="text-xl font-semibold tabular-nums"
						data-testid="bookings-today-waitlist"
					>
						<bdi>{data.waitlistCount}</bdi>
					</dd>
				</div>
			</dl>

			<section
				className="flex flex-col gap-1.5"
				aria-label={_(msg`Bookings by status`)}
				data-testid="bookings-today-statuses"
			>
				{counts.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No bookings today.</Trans>
					</p>
				) : (
					<ul className="flex flex-wrap gap-1.5">
						{counts.map(({ status, count }) => (
							<li key={status}>
								<Badge
									variant="secondary"
									data-testid={`bookings-today-status-${status}`}
								>
									{enumLabel(_, RESERVATION_STATUS_LABELS, status)}{' '}
									<bdi className="tabular-nums">{count}</bdi>
								</Badge>
							</li>
						))}
					</ul>
				)}
			</section>

			{data.coversByService.length > 0 ? (
				<section
					className="flex flex-col gap-1"
					aria-label={_(msg`Covers by service`)}
					data-testid="bookings-today-services"
				>
					<h4 className="text-muted-foreground text-xs font-medium">
						<Trans>Covers by service</Trans>
					</h4>
					<ul className="flex flex-col gap-0.5 text-sm">
						{data.coversByService.map((row) => (
							<li
								key={row.serviceId ?? 'none'}
								className="flex justify-between gap-2"
							>
								<span>{row.name ?? _(msg`No service`)}</span>
								<bdi className="tabular-nums">{row.covers}</bdi>
							</li>
						))}
					</ul>
				</section>
			) : null}

			<section
				className="flex flex-col gap-1"
				aria-label={_(msg`Next arrivals`)}
				data-testid="bookings-today-arrivals"
			>
				<h4 className="text-muted-foreground text-xs font-medium">
					<Trans>Next arrivals</Trans>
				</h4>
				{data.nextArrivals.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No more arrivals expected.</Trans>
					</p>
				) : (
					<ul className="flex flex-col gap-0.5 text-sm">
						{data.nextArrivals.map((arrival) => (
							<li
								key={arrival.reservationId}
								className="flex items-center justify-between gap-2"
							>
								<span className="wrap-anywhere">
									<bdi dir="ltr" className="tabular-nums">
										{arrival.time}
									</bdi>{' '}
									{arrival.firstName}
								</span>
								<span className="text-muted-foreground tabular-nums">
									<bdi>{arrival.partySize}</bdi>
								</span>
							</li>
						))}
					</ul>
				)}
			</section>
			<Link
				to={`/${orgSlug}/reservations/book`}
				className="text-primary text-sm underline-offset-4 hover:underline"
			>
				<Trans>Open Book</Trans>
			</Link>
		</>
	)
}
