import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type WaitlistEntry } from '@repo/reservations'
import {
	BellRing,
	Cake,
	Clock3,
	Crown,
	Info,
	TriangleAlert,
	UserX,
	Users,
} from 'lucide-react'
import {
	isWaitingAtStand,
	minutesLate,
	shortName,
	type DayReservation,
	OCCASION_LABEL,
} from './feed.ts'
import { cn } from '~/ui/primitives.tsx'

/** A guest the restaurant tagged as a VIP (the tag's own name, in any case). */
const isVip = (r: DayReservation) =>
	(r.guest?.tags ?? []).some((tag) => /\bvip\b/i.test(tag.name))

/** What the host has picked up to place on the floor. */
export type Placing =
	| { kind: 'reservation'; reservation: DayReservation }
	| { kind: 'waitlist'; entry: WaitlistEntry }
	| {
			kind: 'walk_in'
			partySize: number
			guestName: string
			/** One per party: a retry after no answer can never seat them twice. */
			key: string
			/** The same for seating them anyway, over a booking. */
			overbookKey: string
	  }

export const placingSize = (p: Placing) =>
	p.kind === 'reservation'
		? p.reservation.partySize
		: p.kind === 'waitlist'
			? p.entry.partySize
			: p.partySize

export const placingKey = (p: Placing | null) =>
	!p
		? null
		: p.kind === 'reservation'
			? `r:${p.reservation.id}`
			: p.kind === 'waitlist'
				? `w:${p.entry.id}`
				: 'walk-in'

/**
 * The parties still to seat, along the bottom of the floor: bookings in the
 * order they are due, then the waitlist in the order it was joined. Tap one to
 * pick it up (the floor then shows where it fits); tap the info button for its
 * details. Late parties say how late; parties already at the stand say so.
 * Bookings whose slot passed with nobody arriving leave the dock for their own
 * lane, where the host marks them.
 */
export function Dock({
	arrivals,
	missed,
	waitlist,
	waitlistOn,
	placing,
	now,
	onPick,
	onDetails,
	onWaitlistDetails,
	formatTime,
	ref,
}: {
	/** The toast rises above the dock, so it never covers the next party. */
	ref?: React.Ref<HTMLElement>
	arrivals: DayReservation[]
	/** Bookings whose time is over and whose party never came. */
	missed: DayReservation[]
	waitlist: WaitlistEntry[]
	waitlistOn: boolean
	placing: Placing | null
	now: number
	onPick: (placing: Placing | null) => void
	onDetails: (reservation: DayReservation) => void
	onWaitlistDetails: (entry: WaitlistEntry) => void
	formatTime: (epochMs: number) => string
}) {
	const { _ } = useLingui()
	const selected = placingKey(placing)
	return (
		<section
			ref={ref}
			aria-label={_(msg`Parties to seat`)}
			className="border-border bg-card pb-safe flex shrink-0 flex-col gap-2 border-t pt-3 lg:flex-row lg:items-stretch lg:gap-0"
		>
			<DockLane
				title={_(msg`Arriving`)}
				count={arrivals.length}
				empty={_(msg`No more bookings today.`)}
				className="lg:min-w-0 lg:flex-[3]"
			>
				{arrivals.map((reservation) => {
					const key = `r:${reservation.id}`
					const late = minutesLate(reservation, now)
					const here = isWaitingAtStand(reservation)
					// The guest said they are running late (by text or a call).
					const runningLate = reservation.runningLateMin ?? 0
					const label = reservation.occasion
						? OCCASION_LABEL[reservation.occasion]
						: undefined
					const occasion = label ? _(label) : (reservation.occasion ?? '')
					return (
						<li key={reservation.id} className="shrink-0">
							<div
								className={cn(
									'dock-card bg-background flex h-[5.5rem] w-52 items-stretch overflow-hidden rounded-2xl border',
									here ? 'border-success/60' : 'border-border',
								)}
								data-selected={selected === key}
							>
								<button
									type="button"
									aria-pressed={selected === key}
									onClick={() =>
										onPick(
											selected === key
												? null
												: { kind: 'reservation', reservation },
										)
									}
									className="flex min-w-0 flex-1 flex-col justify-between p-3 text-start"
								>
									<span className="flex items-center gap-2">
										<span className="mono text-base font-semibold">
											{formatTime(reservation.startAt)}
										</span>
										<span className="text-muted-foreground inline-flex items-center gap-1 text-sm">
											<Users className="size-3.5" />
											<span className="tnum">{reservation.partySize}</span>
										</span>
										{reservation.hasAllergy ? (
											<TriangleAlert
												className="text-warning size-3.5"
												aria-label={_(msg`Allergy noted`)}
											/>
										) : null}
										{isVip(reservation) ? (
											<Crown
												className="text-primary size-3.5"
												aria-label={_(msg`VIP`)}
											/>
										) : null}
										{reservation.occasion ? (
											<Cake
												className="text-primary size-3.5"
												aria-label={_(msg`Occasion: ${occasion}`)}
											/>
										) : null}
									</span>
									<bdi className="truncate font-medium">
										{shortName(reservation, _(msg`Guest`))}
									</bdi>
									<span className="text-xs font-medium">
										{here ? (
											<span className="text-success">
												<Trans>At the stand</Trans>
											</span>
										) : runningLate > 0 && late > runningLate ? (
											// Later than they said: the real figure, and what they said.
											<span className="text-warning">
												<Trans>
													{late} min late (said {runningLate})
												</Trans>
											</span>
										) : runningLate > 0 ? (
											<span className="text-warning">
												<Trans>Running {runningLate} min late</Trans>
											</span>
										) : late > 0 ? (
											<span className="text-warning">
												<Trans>{late} min late</Trans>
											</span>
										) : reservation.tableLabels.length ? (
											<span className="text-muted-foreground">
												<Trans>
													Table {reservation.tableLabels.join(' + ')}
												</Trans>
											</span>
										) : (
											<span className="text-muted-foreground">
												<Trans>No table yet</Trans>
											</span>
										)}
									</span>
								</button>
								<button
									type="button"
									onClick={() => onDetails(reservation)}
									aria-label={_(
										msg`Details for ${shortName(reservation, _(msg`Guest`))}`,
									)}
									className="text-muted-foreground hover:bg-accent hover:text-foreground border-border flex w-11 shrink-0 items-center justify-center border-s transition-colors"
								>
									<Info className="size-4" />
								</button>
							</div>
						</li>
					)
				})}
			</DockLane>
			{missed.length > 0 ? (
				<DockLane
					title={_(msg`Didn’t arrive`)}
					count={missed.length}
					empty=""
					className="lg:border-border lg:min-w-0 lg:flex-[1] lg:border-s"
				>
					{missed.map((reservation) => {
						const who = shortName(reservation, _(msg`Guest`))
						return (
							<li key={reservation.id} className="shrink-0">
								<button
									type="button"
									onClick={() => onDetails(reservation)}
									aria-label={_(msg`${who} did not arrive. Details`)}
									className="dock-card bg-background border-border text-muted-foreground hover:bg-accent flex h-[5.5rem] w-40 flex-col justify-between rounded-2xl border border-dashed p-3 text-start transition-colors"
								>
									<span className="flex items-center gap-2">
										<span className="mono text-base font-semibold line-through">
											{formatTime(reservation.startAt)}
										</span>
										<UserX className="size-3.5" aria-hidden />
									</span>
									<bdi className="text-foreground truncate font-medium">
										{who}
									</bdi>
									<span className="text-xs font-medium">
										<Trans>Mark as no-show</Trans>
									</span>
								</button>
							</li>
						)
					})}
				</DockLane>
			) : null}
			{waitlistOn ? (
				<DockLane
					title={_(msg`Waitlist`)}
					count={waitlist.length}
					empty={_(msg`Nobody is waiting.`)}
					className="lg:border-border lg:min-w-0 lg:flex-[2] lg:border-s"
				>
					{waitlist.map((entry) => {
						const key = `w:${entry.id}`
						const waited = Math.max(
							0,
							Math.floor((now - entry.joinedAt) / 60_000),
						)
						return (
							<li key={entry.id} className="shrink-0">
								<div
									className="dock-card bg-background border-border flex h-[5.5rem] w-48 items-stretch overflow-hidden rounded-2xl border"
									data-selected={selected === key}
								>
									<button
										type="button"
										aria-pressed={selected === key}
										onClick={() =>
											onPick(
												selected === key ? null : { kind: 'waitlist', entry },
											)
										}
										className="flex min-w-0 flex-1 flex-col justify-between p-3 text-start"
									>
										<span className="flex items-center gap-2">
											<span className="text-muted-foreground inline-flex items-center gap-1 text-sm">
												<Users className="size-3.5" />
												<span className="tnum">{entry.partySize}</span>
											</span>
											{entry.status === 'notified' ? (
												<BellRing
													className="text-success size-3.5"
													aria-label={_(msg`Told their table is ready`)}
												/>
											) : null}
										</span>
										<bdi className="truncate font-medium">
											{entry.firstName || entry.displayName}
										</bdi>
										<span className="text-muted-foreground inline-flex items-center gap-1 text-xs font-medium">
											<Clock3 className="size-3" />
											{entry.quotedMin !== null ? (
												<Trans>
													{waited} of {entry.quotedMin} min
												</Trans>
											) : (
												<Trans>{waited} min</Trans>
											)}
										</span>
									</button>
									<button
										type="button"
										onClick={() => onWaitlistDetails(entry)}
										aria-label={_(
											msg`Details for ${entry.firstName || entry.displayName}`,
										)}
										className="text-muted-foreground hover:bg-accent hover:text-foreground border-border flex w-11 shrink-0 items-center justify-center border-s transition-colors"
									>
										<Info className="size-4" />
									</button>
								</div>
							</li>
						)
					})}
				</DockLane>
			) : null}
		</section>
	)
}

function DockLane({
	title,
	count,
	empty,
	className,
	children,
}: {
	title: string
	count: number
	empty: string
	className?: string
	children: React.ReactNode
}) {
	return (
		<div className={cn('flex min-w-0 flex-col gap-2', className)}>
			<h3 className="text-muted-foreground flex items-center gap-2 px-4 text-sm font-semibold">
				{title}
				<span className="bg-muted text-foreground tnum rounded-full px-2 py-0.5 text-xs">
					{count}
				</span>
			</h3>
			{count === 0 ? (
				<p className="text-muted-foreground flex h-[5.5rem] items-center px-4 text-sm">
					{empty}
				</p>
			) : (
				<ul className="no-scrollbar flex gap-3 overflow-x-auto px-4 pt-1 pb-2">
					{children}
				</ul>
			)}
		</div>
	)
}
