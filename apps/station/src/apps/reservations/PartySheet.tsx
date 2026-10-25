import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	Armchair,
	ArrowRightLeft,
	CalendarPlus,
	CheckCheck,
	Clock3,
	CreditCard,
	Crown,
	RotateCcw,
	TimerReset,
	TriangleAlert,
	Undo2,
	UserRound,
	Users,
	Utensils,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { partyStatus } from './book.ts'
import { ContactRow } from './contact.tsx'
import {
	OCCASION_LABEL,
	shortName,
	type DayReservation,
	type TableKind,
} from './feed.ts'
import {
	bookingMeta,
	depositState,
	dietaryNoteOf,
	dietaryOf,
	historyLine,
	tagChips,
} from './guest.ts'
import { statusText } from './labels.ts'
import {
	ARMED_FOR_MS,
	armedStillHolds,
	partyActions,
	type Armed,
} from './partyActions.ts'
import {
	Detail,
	EQUAL_COLUMNS,
	STATUS_LABEL,
	type PartyCommand,
} from './sheets.tsx'
import { EXTEND_STEP_MIN, stayOf } from './stay.ts'
import { Badge, Button, Chip, cn, Modal } from '~/ui/primitives.tsx'

/** Whole minutes between two instants, never negative. */
const minutesBetween = (from: number, to: number) =>
	Math.max(0, Math.round((to - from) / 60_000))

/**
 * One booking: who, when, how many, where, and what to know before they sit
 * (allergies first, then who they are, then how to reach them). The actions
 * are the ones its status allows, in the order a host reaches for them
 * (`partyActions`); cancelling and no-show ask once more.
 */
export function PartySheet({
	reservation,
	canReadGuest,
	busy,
	now,
	formatTime,
	formatDay,
	viewOnly = false,
	tableKindOf,
	onCommand,
	onClose,
}: {
	reservation: DayReservation | null
	canReadGuest: boolean
	busy: boolean
	now: number
	formatTime: (epochMs: number) => string
	/** "Oct 3": a day, in the restaurant's own time zone. */
	formatDay: (epochMs: number) => string
	/**
	 * Another day: details, confirming, changing and cancelling stay, but
	 * nothing about arrival, seating or no-shows (the server refuses those off today).
	 */
	viewOnly?: boolean
	/** What a table is doing now: "Seat at Table 3" is offered only while it is free. */
	tableKindOf?: (tableId: string) => TableKind | null
	onCommand: (reservation: DayReservation, command: PartyCommand) => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	/**
	 * An armed cancel or no-show, with the booking as the host saw it. If it
	 * changes meanwhile (another host marks them arrived), it disarms: the
	 * decision was about something that is no longer true. It also disarms
	 * by itself after a few seconds.
	 */
	const [confirm, setConfirm] = useState<Armed | null>(null)
	useEffect(() => setConfirm(null), [reservation?.id])
	useEffect(() => {
		if (confirm && !armedStillHolds(confirm, reservation)) setConfirm(null)
	}, [confirm, reservation])
	useEffect(() => {
		if (!confirm) return
		const timer = window.setTimeout(() => setConfirm(null), ARMED_FOR_MS)
		return () => window.clearTimeout(timer)
	}, [confirm])
	const arm = (to: Armed['to']) =>
		reservation &&
		setConfirm({ to, version: reservation.version, status: reservation.status })
	const r = reservation
	const bookedTable = r?.tableIds.length === 1 ? r.tableIds[0] : undefined
	const a = r
		? partyActions({
				r,
				now,
				viewOnly,
				seatTableKind:
					bookedTable !== undefined
						? (tableKindOf?.(bookedTable) ?? null)
						: null,
			})
		: null
	const run = (command: PartyCommand) => r && onCommand(r, command)
	const primary = a
		? [a.canSeat, a.canFinish, a.canArrive].filter(Boolean).length
		: 0
	const secondary = a
		? [
				a.canConfirm,
				a.canChange,
				a.canMove,
				a.canExtend,
				a.undo !== null,
				a.canBookAgain,
			].filter(Boolean).length
		: 0
	const destructive = a ? [a.canNoShow, a.canCancel].filter(Boolean).length : 0
	const standing = r ? partyStatus(r, now) : null
	const guestName =
		r?.guest?.name?.trim() || (r ? shortName(r, _(msg`Guest`)) : '')
	const chips = r ? tagChips(r) : []
	const dietary = r ? dietaryOf(_, r) : { allergens: [], diets: [] }
	// An allergy is a warning; a diet is a quiet line; a note we may not read is said as a note.
	const note = r ? dietaryNoteOf(_, r, canReadGuest) : null
	const dietLine = note?.kind === 'diet' ? note.diets.join(', ') : ''
	const stayNow = r ? stayOf(r, now) : null
	const clearClock = stayNow ? formatTime(stayNow.clearAt) : ''
	const seatedMin = stayNow?.seatedMin ?? 0
	const overMin = stayNow?.overMin ?? 0
	const history = r?.guest ? historyLine(_, r.guest, formatDay) : null
	const meta = r ? bookingMeta(_, r, formatDay) : null
	const deposit = r ? depositState(r) : null
	const pinned = r && canReadGuest ? (r.guest?.pinnedNotes ?? []) : []
	// How long they sat, once they have sat: what to say at the end of a stay.
	const seatedClock = r?.seatedAt != null ? formatTime(r.seatedAt) : ''
	const clearedClock = r?.finishedAt != null ? formatTime(r.finishedAt) : ''
	const noShowClock =
		typeof r?.noShowAt === 'number' ? formatTime(r.noShowAt) : ''
	const stay: { text: string; minutes: number | null; sofar: boolean } | null =
		!r
			? null
			: stayNow
				? null
				: r.status === 'finished' && r.finishedAt != null
					? r.seatedAt != null
						? {
								text: _(msg`Seated ${seatedClock}, cleared ${clearedClock}`),
								minutes: minutesBetween(r.seatedAt, r.finishedAt),
								sofar: false,
							}
						: {
								text: _(msg`Cleared ${clearedClock}`),
								minutes: null,
								sofar: false,
							}
					: r.status === 'no_show' && noShowClock
						? {
								text: _(msg`Marked as a no-show at ${noShowClock}`),
								minutes: null,
								sofar: false,
							}
						: null
	const allergenList = dietary.allergens.join(', ')
	const seatLabel = a?.seatAt?.label ?? ''

	return (
		<Modal
			open={r !== null}
			onClose={onClose}
			title={guestName}
			footer={
				r && a ? (
					confirm ? (
						<div className="mb-safe flex flex-col gap-3">
							<p className="font-medium">
								{confirm.to === 'cancelled' ? (
									<Trans>Cancel this booking?</Trans>
								) : (
									<Trans>Mark this party as a no-show?</Trans>
								)}
							</p>
							<div className="grid grid-cols-2 gap-3">
								<Button size="lg" onClick={() => setConfirm(null)}>
									<Trans>Keep it</Trans>
								</Button>
								<Button
									variant="danger"
									size="lg"
									disabled={busy}
									onClick={() =>
										run({
											kind: 'status',
											to: confirm.to,
											expectedVersion: confirm.version,
										})
									}
								>
									{confirm.to === 'cancelled' ? (
										<Trans>Cancel booking</Trans>
									) : (
										<Trans>No-show</Trans>
									)}
								</Button>
							</div>
						</div>
					) : a.any ? (
						<div className="mb-safe flex flex-col gap-3">
							{/* The next step for this party. */}
							{primary > 0 ? (
								<div className="flex gap-3">
									{a.canSeat && a.seatAt ? (
										<>
											{/* Booked at a table and here: one tap seats them there. */}
											<Button
												variant="primary"
												size="lg"
												className="min-w-0 flex-1"
												disabled={busy}
												onClick={() =>
													run({ kind: 'seatAt', tableId: a.seatAt!.tableId })
												}
											>
												<Armchair className="size-5 shrink-0" />
												<span className="truncate">
													<Trans>Seat at Table {seatLabel}</Trans>
												</span>
											</Button>
											<Button
												variant="outline"
												size="lg"
												className="shrink-0 px-4"
												disabled={busy}
												onClick={() => run({ kind: 'place' })}
											>
												<Trans>Other table</Trans>
											</Button>
										</>
									) : a.canSeat ? (
										<Button
											variant="primary"
											size="lg"
											className="min-w-0 flex-1"
											disabled={busy}
											onClick={() => run({ kind: 'place' })}
										>
											<Armchair className="size-5" />
											<Trans>Choose a table</Trans>
										</Button>
									) : null}
									{a.canFinish ? (
										<Button
											variant="primary"
											size="lg"
											className="min-w-0 flex-1"
											disabled={busy}
											onClick={() => run({ kind: 'status', to: 'finished' })}
										>
											<CheckCheck className="size-5" />
											<Trans>Finished, clear table</Trans>
										</Button>
									) : null}
									{a.canArrive ? (
										<Button
											size="lg"
											className="min-w-0 flex-1"
											disabled={busy}
											onClick={() => run({ kind: 'status', to: 'arrived' })}
										>
											<Trans>They’re here</Trans>
										</Button>
									) : null}
								</div>
							) : null}
							{/* Changing the booking: equal buttons in one row. */}
							{secondary > 0 ? (
								<div
									className={cn(
										'grid gap-3',
										EQUAL_COLUMNS[Math.min(secondary, 3)],
									)}
								>
									{a.canConfirm ? (
										<Button
											variant="outline"
											size="lg"
											className="h-auto min-h-14 py-2 leading-tight"
											disabled={busy}
											onClick={() => run({ kind: 'status', to: 'confirmed' })}
										>
											<Trans>Mark confirmed</Trans>
										</Button>
									) : null}
									{a.canChange ? (
										<Button
											variant="outline"
											size="lg"
											className="h-auto min-h-14 py-2 leading-tight"
											disabled={busy}
											onClick={() => run({ kind: 'change' })}
										>
											{a.changeKind === 'size' ? (
												<Trans>Change party size</Trans>
											) : (
												<Trans>Change size or time</Trans>
											)}
										</Button>
									) : null}
									{a.canMove ? (
										<Button
											variant="outline"
											size="lg"
											className="h-auto min-h-14 py-2 leading-tight"
											disabled={busy}
											onClick={() => run({ kind: 'move' })}
										>
											<ArrowRightLeft className="size-5 shrink-0" />
											<Trans>Move table</Trans>
										</Button>
									) : null}
									{a.canExtend ? (
										<Button
											variant="outline"
											size="lg"
											className="h-auto min-h-14 py-2 leading-tight"
											disabled={busy}
											onClick={() => run({ kind: 'extend' })}
										>
											<TimerReset className="size-5 shrink-0" />
											<Trans>+{EXTEND_STEP_MIN} min</Trans>
										</Button>
									) : null}
									{a.undo !== null ? (
										<Button
											variant="outline"
											size="lg"
											className="h-auto min-h-14 py-2 leading-tight"
											disabled={busy}
											onClick={() => run({ kind: 'undo' })}
										>
											<Undo2 className="size-5 shrink-0" />
											{a.undo === 'finish' ? (
												<Trans>Back to seated</Trans>
											) : a.undo === 'no_show' ? (
												<Trans>Not a no-show</Trans>
											) : (
												<Trans>Undo seating</Trans>
											)}
										</Button>
									) : null}
									{a.canBookAgain ? (
										<Button
											variant="outline"
											size="lg"
											className="h-auto min-h-14 py-2 leading-tight"
											disabled={busy}
											onClick={() => run({ kind: 'again' })}
										>
											<RotateCcw className="size-5 shrink-0" />
											<Trans>Book again</Trans>
										</Button>
									) : null}
								</div>
							) : null}
							{/* A deposit or a card is on it: changing and ending it are the manager's. */}
							{a.managerHandles ? (
								<p
									role="note"
									className="text-muted-foreground flex items-start gap-2 text-sm font-medium"
								>
									<CreditCard aria-hidden className="mt-0.5 size-4 shrink-0" />
									<Trans>
										A manager handles this booking: it has a deposit.
									</Trans>
								</p>
							) : null}
							{/* Ending the booking: apart, so it is never tapped by mistake. */}
							{destructive > 0 ? (
								<div
									className={cn(
										'border-border grid gap-3 border-t pt-3',
										EQUAL_COLUMNS[destructive],
									)}
								>
									{a.canNoShow ? (
										<Button
											variant="outline"
											size="lg"
											className="border-destructive/40 text-destructive hover:bg-destructive/10"
											disabled={busy}
											onClick={() => arm('no_show')}
										>
											<Trans>No-show</Trans>
										</Button>
									) : null}
									{a.canCancel ? (
										<Button
											variant="outline"
											size="lg"
											className="border-destructive/40 text-destructive hover:bg-destructive/10"
											disabled={busy}
											onClick={() => arm('cancelled')}
										>
											<Trans>Cancel booking</Trans>
										</Button>
									) : null}
								</div>
							) : null}
						</div>
					) : null
				) : null
			}
		>
			{r ? (
				<div className="flex flex-col gap-5 p-4 sm:p-5">
					<div className="flex flex-wrap items-center gap-3">
						<span className="mono text-3xl font-semibold">
							{formatTime(r.startAt)}
						</span>
						<span className="text-muted-foreground inline-flex items-center gap-1.5 text-lg">
							<Users className="size-5" />
							<span className="tnum">{r.partySize}</span>
						</span>
						<Badge tone={r.status === 'arrived' ? 'success' : 'muted'}>
							{_(STATUS_LABEL[r.status] ?? msg`Booked`)}
						</Badge>
						{standing &&
						!viewOnly &&
						(standing.kind === 'late' || standing.kind === 'running') ? (
							<Badge tone="warning">{statusText(_, standing)}</Badge>
						) : null}
						{r.tableLabels.length ? (
							<Badge tone="primary">
								<Trans>Table {r.tableLabels.join(' + ')}</Trans>
							</Badge>
						) : null}
					</div>

					{/* An allergy first: said in words, from the codes whoever is signed in. */}
					{note?.kind === 'allergy' ? (
						<div
							role="note"
							className="bg-warning/12 text-warning flex items-start gap-3 rounded-2xl px-4 py-3"
						>
							<TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0" />
							<div className="flex min-w-0 flex-col gap-1">
								{note.allergens.length > 0 ? (
									<>
										<p className="font-semibold break-words">
											<Trans>Allergy: {allergenList}</Trans>
										</p>
										{note.text ? (
											<p className="font-medium break-words">{note.text}</p>
										) : null}
									</>
								) : (
									<p className="font-semibold break-words">
										<Trans>Allergy: {note.text}</Trans>
									</p>
								)}
							</div>
						</div>
					) : null}
					{note?.kind === 'unreadable' ? (
						<Detail icon={Utensils}>
							<Trans>
								Dietary note on file. A manager can see the details.
							</Trans>
						</Detail>
					) : null}
					{note?.kind === 'diet' ? (
						<Detail icon={Utensils}>
							<Trans>Dietary: {dietLine}</Trans>
						</Detail>
					) : null}

					{chips.length > 0 ||
					(dietary.diets.length > 0 && note?.kind !== 'diet') ? (
						<ul
							aria-label={_(msg`Guest tags`)}
							className="flex flex-wrap items-center gap-2"
						>
							{chips.map((chip) => (
								<li key={chip.id}>
									<Badge
										tone={chip.tone === 'vip' ? 'primary' : 'muted'}
										className="px-3 py-1 text-sm"
									>
										{chip.tone === 'vip' ? (
											<Crown aria-hidden className="size-3.5" />
										) : null}
										<bdi>{chip.label}</bdi>
									</Badge>
								</li>
							))}
							{note?.kind === 'diet'
								? null
								: dietary.diets.map((diet) => (
										<li key={diet}>
											<Badge className="px-3 py-1 text-sm">{diet}</Badge>
										</li>
									))}
						</ul>
					) : null}

					{r.guest?.phone ? (
						<ContactRow phone={r.guest.phone} canContact={canReadGuest} />
					) : null}

					<div className="flex flex-col gap-3 empty:hidden">
						{a?.awaitingPayment ? (
							<Detail icon={CreditCard}>
								<Trans>
									Held until the deposit is paid. A manager settles it in the
									app.
								</Trans>
							</Detail>
						) : null}
						{r.occasion ? (
							<Detail icon={CalendarPlus}>
								{OCCASION_LABEL[r.occasion]
									? _(OCCASION_LABEL[r.occasion]!)
									: r.occasion}
							</Detail>
						) : null}
						{r.guestRequests ? (
							<Detail icon={UserRound}>{r.guestRequests}</Detail>
						) : null}
						{r.staffNotes ? (
							<Detail icon={UserRound}>
								<span className="text-muted-foreground">
									<Trans>Staff note:</Trans>
								</span>{' '}
								{r.staffNotes}
							</Detail>
						) : null}
						{pinned.map((note) => (
							<Detail key={note.id} icon={UserRound}>
								<span className="text-muted-foreground">
									<Trans>Guest note:</Trans>
								</span>{' '}
								{note.body}
							</Detail>
						))}
						{stayNow ? (
							// Where the stay stands: how long, and when the table should clear.
							<Detail icon={Clock3} tone={stayNow.over ? 'warning' : undefined}>
								<span className="tnum">
									{stayNow.over
										? _(
												msg`Seated ${seatedMin} min, ${overMin} min over (expected clear ${clearClock})`,
											)
										: _(
												msg`Seated ${seatedMin} min, expected clear about ${clearClock}`,
											)}
								</span>
							</Detail>
						) : null}
						{stay ? (
							<Detail icon={Clock3}>
								<span className="tnum">
									{stay.text}
									{stay.minutes !== null ? (
										<>
											{' · '}
											{stay.sofar
												? _(
														plural(stay.minutes, {
															one: '# min so far',
															other: '# min so far',
														}),
													)
												: _(
														plural(stay.minutes, {
															one: '# min',
															other: '# min',
														}),
													)}
										</>
									) : null}
								</span>
							</Detail>
						) : null}
						{!viewOnly &&
						(r.status === 'booked' || r.status === 'confirmed') ? (
							// The guest called: the list then says how late they are running.
							<div
								role="group"
								aria-label={_(msg`Running late`)}
								className="flex flex-wrap items-center gap-2"
							>
								<span className="text-muted-foreground text-sm font-medium">
									<Trans>Running late</Trans>
								</span>
								{[10, 15, 20, 30].map((minutes) => (
									<Chip
										key={minutes}
										selected={(r.runningLateMin ?? 0) === minutes}
										aria-pressed={(r.runningLateMin ?? 0) === minutes}
										disabled={busy}
										onClick={() => run({ kind: 'late', minutes })}
										className="tnum"
									>
										{_(plural(minutes, { one: '# min', other: '# min' }))}
									</Chip>
								))}
								{(r.runningLateMin ?? 0) > 0 ? (
									<Chip
										selected={false}
										disabled={busy}
										onClick={() => run({ kind: 'late', minutes: 0 })}
									>
										<Trans>On time</Trans>
									</Chip>
								) : null}
							</div>
						) : null}
					</div>

					{/* How it was booked, and the guest's history: small, but enough to verify a caller. */}
					<div className="border-border flex flex-col gap-2 border-t pt-4 text-sm">
						{meta ? (
							<p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1.5">
								<span>{meta.source}</span>
								{meta.code ? (
									<>
										<span aria-hidden>·</span>
										<span>
											<Trans>
												code{' '}
												<bdi dir="ltr" className="mono font-semibold">
													{meta.code}
												</bdi>
											</Trans>
										</span>
									</>
								) : null}
								{meta.booked ? (
									<>
										<span aria-hidden>·</span>
										<span>{meta.booked}</span>
									</>
								) : null}
								{deposit ? (
									<Badge
										tone={
											deposit === 'awaiting'
												? 'warning'
												: deposit === 'paid'
													? 'success'
													: 'muted'
										}
										className="ms-1"
									>
										<CreditCard aria-hidden className="size-3.5" />
										{deposit === 'awaiting' ? (
											<Trans>Awaiting deposit</Trans>
										) : deposit === 'paid' ? (
											<Trans>Deposit paid</Trans>
										) : (
											<Trans>Card on file</Trans>
										)}
									</Badge>
								) : null}
							</p>
						) : null}
						{history ? (
							<p
								className={cn(
									'tnum',
									history.warn
										? 'text-warning font-medium'
										: 'text-muted-foreground',
								)}
							>
								{history.text}
							</p>
						) : null}
					</div>
				</div>
			) : null}
		</Modal>
	)
}
