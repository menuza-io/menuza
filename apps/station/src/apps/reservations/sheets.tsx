import { type MessageDescriptor } from '@lingui/core'
import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	quickActionsFor,
	type QuickAction,
	type WaitlistEntry,
} from '@repo/reservations'
import {
	Armchair,
	BellRing,
	CalendarPlus,
	CheckCheck,
	Phone,
	TriangleAlert,
	Undo2,
	UserRound,
	Users,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type StatusTarget } from './api.ts'
import {
	OCCASION_LABEL,
	shortName,
	type Availability,
	type DayReservation,
	type DayTable,
	type TableState,
} from './feed.ts'
import { SuccessMark } from '~/ui/motion.tsx'
import { Badge, Button, Chip, cn, fieldClass, Modal } from '~/ui/primitives.tsx'

export const STATUS_LABEL: Record<string, MessageDescriptor> = {
	booked: msg`Booked`,
	confirmed: msg`Confirmed`,
	partially_arrived: msg`Partly here`,
	arrived: msg`At the stand`,
	partially_seated: msg`Partly seated`,
	seated: msg`Seated`,
	finished: msg`Finished`,
	cancelled: msg`Cancelled`,
	no_show: msg`No-show`,
	requested: msg`Request`,
	pending_payment: msg`Awaiting payment`,
}

/** What a sheet asks the host stand to do; the stand runs it and reports back. */
export type PartyCommand =
	| {
			kind: 'status'
			to: StatusTarget
			reason?: string
			/** The version the host saw when they decided (an armed confirm). */
			expectedVersion?: number
	  }
	/** The guest called to say they are late (0 clears it). */
	| { kind: 'late'; minutes: number }
	/** Open the change sheet: the party's size or time. */
	| { kind: 'change' }
	| { kind: 'undo' }
	| { kind: 'place' }

/** Party size as big targets: 1 to 8 one tap away, more with the stepper. */
export function PartySize({
	value,
	onChange,
}: {
	value: number
	onChange: (size: number) => void
}) {
	const { _ } = useLingui()
	return (
		<div
			role="group"
			aria-label={_(t`Party size`)}
			className="flex flex-wrap gap-2"
		>
			{[1, 2, 3, 4, 5, 6, 7, 8].map((size) => (
				<Chip
					key={size}
					size="lg"
					selected={value === size}
					aria-pressed={value === size}
					onClick={() => onChange(size)}
					className="tnum w-12"
				>
					{size}
				</Chip>
			))}
			<div className="border-border bg-card flex h-12 items-center rounded-xl border">
				<button
					type="button"
					aria-label={_(t`One fewer`)}
					onClick={() => onChange(Math.max(1, value - 1))}
					className="hover:bg-accent h-full w-11 rounded-s-xl text-lg font-semibold"
				>
					−
				</button>
				<span className="tnum mono w-10 text-center text-lg font-semibold">
					{value}
				</span>
				<button
					type="button"
					aria-label={_(t`One more`)}
					onClick={() => onChange(Math.min(99, value + 1))}
					className="hover:bg-accent h-full w-11 rounded-e-xl text-lg font-semibold"
				>
					+
				</button>
			</div>
		</div>
	)
}

function Detail({
	icon: Icon,
	children,
	tone,
}: {
	icon: typeof Phone
	children: React.ReactNode
	tone?: 'warning'
}) {
	return (
		<p
			className={cn(
				'flex items-start gap-3 text-base',
				tone === 'warning' && 'text-warning font-medium',
			)}
		>
			<Icon className="text-muted-foreground mt-0.5 size-5 shrink-0" />
			<span className="min-w-0 break-words">{children}</span>
		</p>
	)
}

/**
 * One booking: who, when, how many, where, and what to know before they sit
 * (allergies, notes). The actions are the ones its status allows, in the order
 * a host reaches for them; cancelling and no-show ask once more.
 */
export function PartySheet({
	reservation,
	canReadGuest,
	busy,
	now,
	formatTime,
	onCommand,
	onClose,
}: {
	reservation: DayReservation | null
	canReadGuest: boolean
	busy: boolean
	now: number
	formatTime: (epochMs: number) => string
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
	const [confirm, setConfirm] = useState<{
		to: 'cancelled' | 'no_show'
		version: number
		status: string
	} | null>(null)
	useEffect(() => setConfirm(null), [reservation?.id])
	useEffect(() => {
		if (!confirm || !reservation) return
		if (
			reservation.version !== confirm.version ||
			reservation.status !== confirm.status
		)
			setConfirm(null)
	}, [confirm, reservation])
	useEffect(() => {
		if (!confirm) return
		const timer = window.setTimeout(() => setConfirm(null), 8000)
		return () => window.clearTimeout(timer)
	}, [confirm])
	const arm = (to: 'cancelled' | 'no_show') =>
		reservation &&
		setConfirm({ to, version: reservation.version, status: reservation.status })
	const r = reservation
	const actions = r
		? quickActionsFor(r.status as never, {
				nowMs: now,
				finishedAtMs: r.finishedAt ?? null,
			})
		: []
	// Awaiting its deposit: confirming would waive it and cancelling touches
	// the payment, both a manager's call in the app.
	const awaitingPayment = r?.status === 'pending_payment'
	const has = (action: QuickAction) =>
		actions.includes(action) &&
		!(awaitingPayment && (action === 'confirm' || action === 'cancel'))
	const run = (command: PartyCommand) => r && onCommand(r, command)
	const phoneEnd = (r?.guest?.phone ?? '').replace(/\D/g, '').slice(-4)
	const guestName =
		r?.guest?.name?.trim() || (r ? shortName(r, _(t`Guest`)) : '')

	return (
		<Modal
			open={r !== null}
			onClose={onClose}
			title={guestName}
			footer={
				r ? (
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
					) : (
						<div className="mb-safe flex flex-wrap gap-3">
							{has('seat') || has('partially_seat') ? (
								<Button
									variant="primary"
									size="lg"
									className="min-w-40 flex-1"
									disabled={busy}
									onClick={() => run({ kind: 'place' })}
								>
									<Armchair className="size-5" />
									<Trans>Choose a table</Trans>
								</Button>
							) : null}
							{has('finish') ? (
								<Button
									variant="primary"
									size="lg"
									className="min-w-40 flex-1"
									disabled={busy}
									onClick={() => run({ kind: 'status', to: 'finished' })}
								>
									<CheckCheck className="size-5" />
									<Trans>Finished, clear table</Trans>
								</Button>
							) : null}
							{has('arrive') && r.status !== 'arrived' ? (
								<Button
									size="lg"
									className="flex-1"
									disabled={busy}
									onClick={() => run({ kind: 'status', to: 'arrived' })}
								>
									<Trans>They’re here</Trans>
								</Button>
							) : null}
							{has('confirm') ? (
								<Button
									size="lg"
									className="flex-1"
									disabled={busy}
									onClick={() => run({ kind: 'status', to: 'confirmed' })}
								>
									<Trans>Confirmed by phone</Trans>
								</Button>
							) : null}
							{r.status === 'booked' ||
							r.status === 'confirmed' ||
							r.status === 'arrived' ? (
								<Button
									variant="outline"
									size="lg"
									className="flex-1"
									disabled={busy}
									onClick={() => run({ kind: 'change' })}
								>
									<Trans>Change size or time</Trans>
								</Button>
							) : null}
							{has('undo_seat') || has('undo_finish') || has('undo_no_show') ? (
								<Button
									variant="outline"
									size="lg"
									className="flex-1"
									disabled={busy}
									onClick={() => run({ kind: 'undo' })}
								>
									<Undo2 className="size-5" />
									{has('undo_finish') ? (
										<Trans>Back to seated</Trans>
									) : has('undo_no_show') ? (
										<Trans>Not a no-show</Trans>
									) : (
										<Trans>Undo seating</Trans>
									)}
								</Button>
							) : null}
							{has('no_show') ? (
								<Button
									variant="ghost"
									size="lg"
									disabled={busy}
									onClick={() => arm('no_show')}
								>
									<Trans>No-show</Trans>
								</Button>
							) : null}
							{has('cancel') ? (
								<Button
									variant="ghost"
									size="lg"
									className="text-destructive"
									disabled={busy}
									onClick={() => arm('cancelled')}
								>
									<Trans>Cancel</Trans>
								</Button>
							) : null}
						</div>
					)
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
						{r.tableLabels.length ? (
							<Badge tone="primary">
								<Trans>Table {r.tableLabels.join(' + ')}</Trans>
							</Badge>
						) : null}
					</div>
					<div className="flex flex-col gap-3">
						{r.guest?.phone ? (
							<Detail icon={Phone}>
								{canReadGuest ? (
									<a
										href={`tel:${r.guest.phone}`}
										className="tnum underline-offset-4 hover:underline"
										dir="ltr"
									>
										{r.guest.phone}
									</a>
								) : (
									// Only the end of the number: enough to recognise a guest on the phone.
									<span
										className="tnum"
										dir="ltr"
										aria-label={_(t`Phone ending ${phoneEnd}`)}
									>
										{r.guest.phone}
									</span>
								)}
							</Detail>
						) : null}
						{r.hasAllergy ? (
							<Detail icon={TriangleAlert} tone="warning">
								{canReadGuest && (r.guest?.allergyNotes || r.dietaryNotes) ? (
									r.guest?.allergyNotes || r.dietaryNotes
								) : (
									<Trans>Allergy noted. A manager can see the details.</Trans>
								)}
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
						{r.status === 'booked' || r.status === 'confirmed' ? (
							// The guest called: the dock then says how late they are running.
							<div
								role="group"
								aria-label={_(t`Running late`)}
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
										<Trans>{minutes} min</Trans>
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
						{r.guest ? (
							<p className="text-muted-foreground text-sm">
								{r.guest.visits > 0 ? (
									<Trans>{r.guest.visits} visits before</Trans>
								) : (
									<Trans>First visit</Trans>
								)}
								{r.guest.noShows > 0 ? (
									<>
										{' · '}
										<Trans>{r.guest.noShows} no-shows</Trans>
									</>
								) : null}
							</p>
						) : null}
					</div>
				</div>
			) : null}
		</Modal>
	)
}

/** A party on the waitlist: how long they have waited, and what to do next. */
export function WaitlistSheet({
	entry,
	canReadGuest,
	busy,
	now,
	onNotify,
	onPlace,
	onRemove,
	onClose,
}: {
	entry: WaitlistEntry | null
	/** Without guest details the server sends only the end of the number. */
	canReadGuest: boolean
	busy: boolean
	now: number
	onNotify: (entry: WaitlistEntry) => void
	onPlace: (entry: WaitlistEntry) => void
	onRemove: (entry: WaitlistEntry) => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const waited = entry
		? Math.max(0, Math.floor((now - entry.joinedAt) / 60_000))
		: 0
	return (
		<Modal
			open={entry !== null}
			onClose={onClose}
			title={entry?.displayName ?? ''}
			footer={
				entry ? (
					<div className="mb-safe flex flex-wrap gap-3">
						<Button
							variant="primary"
							size="lg"
							className="min-w-40 flex-1"
							disabled={busy}
							onClick={() => onPlace(entry)}
						>
							<Armchair className="size-5" />
							<Trans>Choose a table</Trans>
						</Button>
						{entry.status === 'waiting' && entry.phone ? (
							<Button
								size="lg"
								className="flex-1"
								disabled={busy}
								onClick={() => onNotify(entry)}
							>
								<BellRing className="size-5" />
								<Trans>Text: table ready</Trans>
							</Button>
						) : null}
						<ConfirmButton
							busy={busy}
							onConfirm={() => onRemove(entry)}
							label={_(t`They left`)}
							confirmLabel={_(t`Tap again: remove`)}
						/>
					</div>
				) : null
			}
		>
			{entry ? (
				<div className="flex flex-col gap-4 p-4 sm:p-5">
					<p className="flex flex-wrap items-center gap-3 text-lg">
						<span className="inline-flex items-center gap-1.5">
							<Users className="text-muted-foreground size-5" />
							<span className="tnum">{entry.partySize}</span>
						</span>
						<span className="text-muted-foreground tnum">
							{entry.quotedMin !== null ? (
								<Trans>
									Waiting {waited} min, quoted {entry.quotedMin}
								</Trans>
							) : (
								<Trans>Waiting {waited} min</Trans>
							)}
						</span>
					</p>
					{entry.phone ? (
						<Detail icon={Phone}>
							{canReadGuest ? (
								<a href={`tel:${entry.phone}`} className="tnum" dir="ltr">
									{entry.phone}
								</a>
							) : (
								<span className="tnum" dir="ltr">
									{entry.phone}
								</span>
							)}
						</Detail>
					) : null}
					{entry.notes ? <Detail icon={UserRound}>{entry.notes}</Detail> : null}
					{entry.status === 'notified' ? (
						<p className="text-success font-medium">
							<Trans>They have been told their table is ready.</Trans>
						</p>
					) : null}
				</div>
			) : null}
		</Modal>
	)
}

/** A table tapped outside of placing: who is there or due, and a walk-in for it. */
/**
 * A step that cannot be undone from the stand takes two taps: the first arms
 * it (the label says what the next tap does), and it disarms by itself.
 */
function ConfirmButton({
	label,
	confirmLabel,
	busy,
	onConfirm,
}: {
	label: string
	confirmLabel: string
	busy: boolean
	onConfirm: () => void
}) {
	const [armed, setArmed] = useState(false)
	useEffect(() => {
		if (!armed) return
		const timer = window.setTimeout(() => setArmed(false), 4000)
		return () => window.clearTimeout(timer)
	}, [armed])
	return (
		<Button
			variant={armed ? 'danger' : 'ghost'}
			size="lg"
			disabled={busy}
			onClick={() => {
				if (!armed) return setArmed(true)
				setArmed(false)
				onConfirm()
			}}
		>
			{armed ? confirmLabel : label}
		</Button>
	)
}

export function TableSheet({
	target,
	busy,
	now,
	formatTime,
	onWalkIn,
	onFinish,
	onDetails,
	onClose,
}: {
	target: { table: DayTable; state: TableState } | null
	busy: boolean
	now: number
	formatTime: (epochMs: number) => string
	onWalkIn: (table: DayTable, partySize: number) => void
	onFinish: (reservation: DayReservation) => void
	onDetails: (reservation: DayReservation) => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const [size, setSize] = useState(2)
	// A new table starts at two; the same table redrawn by a poll keeps the host's choice.
	const tableId = target?.table.id ?? null
	const maxCovers = target?.table.maxCovers ?? 2
	useEffect(() => {
		if (tableId) setSize(Math.min(maxCovers, 2))
		// eslint-disable-next-line react-hooks/exhaustive-deps -- reset per table only
	}, [tableId])
	const state = target?.state
	const next =
		state && state.kind !== 'seated' ? state.next : (state?.next ?? null)
	return (
		<Modal
			open={target !== null}
			onClose={onClose}
			title={target ? _(t`Table ${target.table.label}`) : ''}
		>
			{target && state ? (
				<div className="flex flex-col gap-5 p-4 sm:p-5">
					{state.kind === 'seated' ? (
						<div className="border-border flex flex-col gap-3 rounded-2xl border p-4">
							<p className="text-lg font-semibold">
								{shortName(state.party, _(t`Guest`))}
							</p>
							<p className="text-muted-foreground tnum">
								{state.party.seatedAt ? (
									<Trans>
										Party of {state.party.partySize}, seated{' '}
										{Math.max(
											0,
											Math.floor((now - state.party.seatedAt) / 60_000),
										)}{' '}
										min
									</Trans>
								) : (
									<Trans>Party of {state.party.partySize}</Trans>
								)}
							</p>
							<div className="flex flex-wrap gap-3">
								<Button
									variant="primary"
									size="lg"
									className="flex-1"
									disabled={busy}
									onClick={() => onFinish(state.party)}
								>
									<CheckCheck className="size-5" />
									<Trans>Finished, clear table</Trans>
								</Button>
								<Button size="lg" onClick={() => onDetails(state.party)}>
									<Trans>Details</Trans>
								</Button>
							</div>
						</div>
					) : null}
					{state.kind === 'blocked' ? (
						<p className="text-muted-foreground">
							{state.reason ? (
								<Trans>Blocked: {state.reason}</Trans>
							) : (
								<Trans>This table is blocked right now.</Trans>
							)}
						</p>
					) : null}
					{next ? (
						<button
							type="button"
							onClick={() => onDetails(next)}
							className="border-border hover:bg-accent flex items-center justify-between gap-3 rounded-2xl border p-4 text-start transition-colors"
						>
							<span>
								<span className="text-muted-foreground block text-sm">
									<Trans>Next booking</Trans>
								</span>
								<span className="font-semibold">
									{shortName(next, _(t`Guest`))} · {next.partySize}
								</span>
							</span>
							<span className="mono text-xl font-semibold">
								{formatTime(next.startAt)}
							</span>
						</button>
					) : null}
					{state.kind !== 'seated' && state.kind !== 'blocked' ? (
						<div className="flex flex-col gap-3">
							<p className="font-semibold">
								<Trans>Seat a walk-in here</Trans>
							</p>
							<PartySize value={size} onChange={setSize} />
							{size > target.table.maxCovers ? (
								<p className="text-warning text-sm font-medium">
									<Trans>This table seats {target.table.maxCovers}.</Trans>
								</p>
							) : null}
							<Button
								variant="primary"
								size="lg"
								disabled={busy}
								onClick={() => onWalkIn(target.table, size)}
							>
								<Armchair className="size-5" />
								<Trans>Seat {size} now</Trans>
							</Button>
						</div>
					) : null}
				</div>
			) : null}
		</Modal>
	)
}

/**
 * "We're six now", "can we make it 8:00": a booking's size or time, the only
 * things a till changes on it. Times come from availability for the new size;
 * keeping the time is the default.
 */
export function ChangePartySheet({
	reservation,
	busy,
	date,
	loadSlots,
	formatTime,
	onSave,
	onClose,
}: {
	reservation: DayReservation | null
	busy: boolean
	/** The day the booking is on (the stand shows one day). */
	date: string
	loadSlots: (date: string, partySize: number) => Promise<Availability>
	formatTime: (epochMs: number) => string
	onSave: (change: {
		partySize?: number
		time?: string
		/** The new time as the stand shows it, for the toast. */
		timeLabel?: string
	}) => void
	onClose: () => void
}) {
	const { _, i18n } = useLingui()
	const r = reservation
	const [size, setSize] = useState(r?.partySize ?? 2)
	const [time, setTime] = useState<{ value: string; label: string } | null>(
		null,
	)
	const [slots, setSlots] = useState<Availability['slots'] | null>(null)
	const id = r?.id ?? null
	useEffect(() => {
		if (!r) return
		setSize(r.partySize)
		setTime(null)
		// eslint-disable-next-line react-hooks/exhaustive-deps -- reset per booking only
	}, [id])
	useEffect(() => {
		if (!id) return
		let live = true
		setSlots(null)
		loadSlots(date, size).then(
			(result) => live && setSlots(result.closed ? [] : result.slots),
			() => live && setSlots([]),
		)
		return () => {
			live = false
		}
	}, [id, date, size, loadSlots])
	const slotLabel = useMemo(() => {
		const format = new Intl.DateTimeFormat(i18n.locale, {
			hour: 'numeric',
			minute: '2-digit',
			timeZone: 'UTC',
		})
		return (minutes: number) =>
			format.format(Date.UTC(2000, 0, 1, 0, minutes % 1440))
	}, [i18n.locale])
	const current = r ? formatTime(r.startAt) : ''
	const changed = r !== null && (size !== r.partySize || time !== null)
	const open_ = (slots ?? []).filter(
		(slot) => slot.available && slot.time !== r?.time,
	)
	return (
		<Modal
			open={r !== null}
			onClose={onClose}
			size="lg"
			title={_(t`Change size or time`)}
			footer={
				r ? (
					<div className="mb-safe">
						<Button
							variant="primary"
							size="lg"
							className="w-full"
							disabled={!changed || busy}
							onClick={() =>
								onSave({
									...(size !== r.partySize ? { partySize: size } : {}),
									...(time ? { time: time.value, timeLabel: time.label } : {}),
								})
							}
						>
							<Trans>Save</Trans>
						</Button>
					</div>
				) : null
			}
		>
			{r ? (
				<div className="flex flex-col gap-6 p-4 sm:p-5">
					<div className="flex flex-col gap-2">
						<span className="font-semibold">
							<Trans>Party size</Trans>
						</span>
						<PartySize value={size} onChange={setSize} />
					</div>
					<div className="flex flex-col gap-2">
						<span className="font-semibold">
							<Trans>Time</Trans>
						</span>
						<div className="flex flex-wrap gap-2">
							<Chip
								selected={time === null}
								aria-pressed={time === null}
								onClick={() => setTime(null)}
								className="tnum"
							>
								<Trans>Keep {current}</Trans>
							</Chip>
							{slots === null ? (
								<span className="t-shimmer self-center text-sm">
									<Trans>Finding times…</Trans>
								</span>
							) : (
								open_.map((slot) => (
									<Chip
										key={slot.localStartMin}
										selected={time?.value === slot.time}
										aria-pressed={time?.value === slot.time}
										onClick={() =>
											setTime({
												value: slot.time,
												label: slotLabel(slot.localStartMin),
											})
										}
										className="tnum min-w-20"
									>
										{slotLabel(slot.localStartMin)}
									</Chip>
								))
							)}
						</div>
					</div>
				</div>
			) : null}
		</Modal>
	)
}

/** A walk-in from the top bar: how many, then the floor picks the table. */
export function WalkInSheet({
	open,
	onPlace,
	onClose,
}: {
	open: boolean
	onPlace: (partySize: number, guestName: string) => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const [size, setSize] = useState(2)
	const [name, setName] = useState('')
	useEffect(() => {
		if (open) {
			setSize(2)
			setName('')
		}
	}, [open])
	return (
		<Modal
			open={open}
			onClose={onClose}
			title={_(t`Walk-in`)}
			footer={
				<div className="mb-safe">
					<Button
						variant="primary"
						size="lg"
						className="w-full"
						onClick={() => onPlace(size, name)}
					>
						<Armchair className="size-5" />
						<Trans>Choose a table</Trans>
					</Button>
				</div>
			}
		>
			<div className="flex flex-col gap-5 p-4 sm:p-5">
				<div className="flex flex-col gap-3">
					<p className="font-semibold">
						<Trans>How many?</Trans>
					</p>
					<PartySize value={size} onChange={setSize} />
				</div>
				<label className="flex flex-col gap-2">
					<span className="font-semibold">
						<Trans>Name (optional)</Trans>
					</span>
					<input
						className={fieldClass}
						value={name}
						maxLength={120}
						onChange={(event) => setName(event.target.value)}
						autoComplete="off"
					/>
				</label>
			</div>
		</Modal>
	)
}

/**
 * A booking taken at the stand or on the phone: when, how many, who. Times come
 * from the location's own availability, so the stand never books what the
 * floor cannot seat (a manager can still overbook from the App).
 */
export type BookingReadBackInfo = {
	/**
	 * A retry the server already had under this key: it holds the first
	 * request as sent, so the form's details are not read back.
	 */
	asFirstSent?: boolean
	name: string
	partySize: number
	/** "Fri, Oct 24 at 7:30 PM" or "Today at 7:30 PM", as said to the caller. */
	when: string
	/** The confirmation code, when the server's answer carried it. */
	code: string | null
}

export function BookingSheet({
	open,
	busy,
	locked,
	readBack,
	today,
	loadSlots,
	onBook,
	onClose,
}: {
	open: boolean
	busy: boolean
	/** No answer came back: the form stays as sent, so a retry is the same booking. */
	locked: boolean
	/** Booked: what to read back to the caller instead of the form. */
	readBack: BookingReadBackInfo | null
	today: string
	loadSlots: (date: string, partySize: number) => Promise<Availability>
	onBook: (input: {
		date: string
		time: string
		/** The time as the stand shows it ("7:30 PM"). */
		timeLabel: string
		partySize: number
		firstName: string
		lastName: string
		phone: string | null
		notes: string | null
	}) => void
	onClose: () => void
}) {
	const { _, i18n } = useLingui()
	// A slot is minutes after local midnight; show it the way the stand shows times.
	const slotLabel = useMemo(() => {
		const format = new Intl.DateTimeFormat(i18n.locale, {
			hour: 'numeric',
			minute: '2-digit',
			timeZone: 'UTC',
		})
		return (minutes: number) =>
			format.format(Date.UTC(2000, 0, 1, 0, minutes % 1440))
	}, [i18n.locale])
	const [date, setDate] = useState(today)
	const [size, setSize] = useState(2)
	const [slots, setSlots] = useState<Availability['slots'] | null>(null)
	const [slotsError, setSlotsError] = useState(false)
	const [time, setTime] = useState<string | null>(null)
	const [timeLabel, setTimeLabel] = useState('')
	const [first, setFirst] = useState('')
	const [last, setLast] = useState('')
	const [phone, setPhone] = useState('')
	const [notes, setNotes] = useState('')
	useEffect(() => {
		if (!open) return
		setDate(today)
		setSize(2)
		setTime(null)
		setFirst('')
		setLast('')
		setPhone('')
		setNotes('')
	}, [open, today])
	useEffect(() => {
		if (!open) return
		let live = true
		setSlots(null)
		setSlotsError(false)
		setTime(null)
		loadSlots(date, size).then(
			(result) => live && setSlots(result.closed ? [] : result.slots),
			() => live && setSlotsError(true),
		)
		return () => {
			live = false
		}
	}, [open, date, size, loadSlots])
	const open_ = (slots ?? []).filter((slot) => slot.available)
	const groups = groupSlots(open_)
	const phoneProblem = phone.trim() !== '' && !looksLikePhone(phone)
	const ready = time !== null && first.trim().length > 0 && !phoneProblem
	return (
		<Modal
			open={open}
			onClose={onClose}
			size="lg"
			title={_(t`New booking`)}
			footer={
				readBack ? (
					<div className="mb-safe">
						<Button
							variant="primary"
							size="lg"
							className="w-full"
							onClick={onClose}
						>
							<Trans>Done</Trans>
						</Button>
					</div>
				) : (
					<div className="mb-safe flex flex-col gap-2">
						{locked ? (
							<p className="text-warning text-sm font-medium" role="status">
								<Trans>
									No answer yet. Tap Book again to check: the same booking is
									sent, never a second one.
								</Trans>
							</p>
						) : null}
						<Button
							variant="primary"
							size="lg"
							className="w-full"
							disabled={!ready || busy}
							onClick={() =>
								time &&
								onBook({
									date,
									time,
									timeLabel,
									partySize: size,
									firstName: first,
									lastName: last,
									phone: phone.trim() || null,
									notes: notes.trim() || null,
								})
							}
						>
							{time ? (
								<Trans>
									Book {size} at {timeLabel}
								</Trans>
							) : (
								<Trans>Choose a time</Trans>
							)}
						</Button>
					</div>
				)
			}
		>
			{readBack ? (
				<BookingReadBack {...readBack} />
			) : (
				// Frozen after no answer: tapping Book again sends the very same booking.
				<fieldset disabled={locked} className="contents">
					<div className="flex flex-col gap-6 p-4 sm:p-5">
						<div className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-start">
							<label className="flex flex-col gap-2">
								<span className="font-semibold">
									<Trans>Day</Trans>
								</span>
								<input
									type="date"
									className={cn(fieldClass, 'tnum')}
									min={today}
									value={date}
									onChange={(event) => setDate(event.target.value || today)}
								/>
							</label>
							<div className="flex flex-col gap-2">
								<span className="font-semibold">
									<Trans>Party size</Trans>
								</span>
								<PartySize value={size} onChange={setSize} />
							</div>
						</div>
						<div className="flex flex-col gap-2">
							<span className="font-semibold">
								<Trans>Time</Trans>
							</span>
							{slotsError ? (
								<p className="text-destructive text-sm">
									<Trans>Could not load the times. Check the connection.</Trans>
								</p>
							) : slots === null ? (
								<p className="t-shimmer text-sm">
									<Trans>Finding times…</Trans>
								</p>
							) : open_.length === 0 ? (
								<p className="text-muted-foreground text-sm">
									<Trans>No times left for {size} on this day.</Trans>
								</p>
							) : (
								<div className="flex flex-col gap-3">
									{groups.map((group) => (
										<div
											key={group.part}
											role="group"
											aria-label={_(PART_OF_DAY[group.part])}
											className="flex flex-col gap-1.5"
										>
											<span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
												{_(PART_OF_DAY[group.part])}
											</span>
											<div className="flex flex-wrap gap-2">
												{group.slots.map((slot) => (
													<Chip
														key={slot.localStartMin}
														selected={time === slot.time}
														aria-pressed={time === slot.time}
														onClick={() => {
															setTime(slot.time)
															setTimeLabel(slotLabel(slot.localStartMin))
														}}
														className="tnum min-w-20"
													>
														{slotLabel(slot.localStartMin)}
													</Chip>
												))}
											</div>
										</div>
									))}
								</div>
							)}
						</div>
						<div className="grid gap-4 sm:grid-cols-2">
							<label className="flex flex-col gap-2">
								<span className="font-semibold">
									<Trans>First name</Trans>
								</span>
								<input
									className={fieldClass}
									value={first}
									maxLength={120}
									autoComplete="off"
									onChange={(event) => setFirst(event.target.value)}
								/>
							</label>
							<label className="flex flex-col gap-2">
								<span className="font-semibold">
									<Trans>Last name</Trans>
								</span>
								<input
									className={fieldClass}
									value={last}
									maxLength={120}
									autoComplete="off"
									onChange={(event) => setLast(event.target.value)}
								/>
							</label>
							<label className="flex flex-col gap-2 sm:col-span-2">
								<span className="font-semibold">
									<Trans>Phone (for reminders)</Trans>
								</span>
								<input
									className={cn(fieldClass, 'tnum')}
									type="tel"
									inputMode="tel"
									dir="ltr"
									value={phone}
									maxLength={32}
									autoComplete="off"
									aria-invalid={phoneProblem}
									aria-describedby={
										phoneProblem ? 'booking-phone-problem' : undefined
									}
									onChange={(event) => setPhone(event.target.value)}
								/>
								{phoneProblem ? (
									<span
										id="booking-phone-problem"
										className="text-destructive text-sm"
									>
										<Trans>
											Check the number: include the country code, like +1 212
											555 0100.
										</Trans>
									</span>
								) : null}
							</label>
							<label className="flex flex-col gap-2 sm:col-span-2">
								<span className="font-semibold">
									<Trans>Note for the team</Trans>
								</span>
								<textarea
									className={cn(fieldClass, 'min-h-20 py-3')}
									value={notes}
									maxLength={500}
									placeholder={_(t`High chair, birthday, by the window…`)}
									onChange={(event) => setNotes(event.target.value)}
								/>
							</label>
						</div>
					</div>
				</fieldset>
			)}
		</Modal>
	)
}

/** What the host reads back to the caller once the booking is in. */
function BookingReadBack({
	asFirstSent,
	name,
	partySize,
	when,
	code,
}: BookingReadBackInfo) {
	if (asFirstSent)
		return (
			<div className="flex flex-col items-center gap-3 p-6 text-center">
				<SuccessMark tone="muted" />
				<p className="text-xl font-bold">
					<Trans>Already booked, as first sent</Trans>
				</p>
				<p className="text-muted-foreground">
					<Trans>
						Check today’s list for the time and party size it was booked with
						before reading it back.
					</Trans>
				</p>
			</div>
		)
	return (
		<div className="flex flex-col items-center gap-4 p-6 text-center">
			<SuccessMark />
			<p className="text-2xl font-bold">
				<Trans>
					<bdi>{name}</bdi>, party of {partySize}
				</Trans>
			</p>
			<p className="text-muted-foreground text-lg">{when}</p>
			{code ? (
				<div className="flex flex-col items-center gap-1">
					<span className="text-muted-foreground text-sm font-medium">
						<Trans>Confirmation code</Trans>
					</span>
					<span className="mono text-3xl font-bold tracking-widest" dir="ltr">
						{code}
					</span>
				</div>
			) : null}
		</div>
	)
}

type PartOfDay = 'morning' | 'afternoon' | 'evening'

const PART_OF_DAY: Record<PartOfDay, MessageDescriptor> = {
	morning: msg`Morning`,
	afternoon: msg`Afternoon`,
	evening: msg`Evening`,
}

/** Slots in the order of the day, under morning, afternoon and evening. */
function groupSlots<T extends { localStartMin: number }>(slots: T[]) {
	const part = (minutes: number): PartOfDay => {
		const m = minutes % 1440
		return m < 12 * 60 ? 'morning' : m < 17 * 60 ? 'afternoon' : 'evening'
	}
	const groups: Array<{ part: PartOfDay; slots: T[] }> = []
	for (const slot of slots) {
		const p = part(slot.localStartMin)
		const last = groups[groups.length - 1]
		if (last?.part === p) last.slots.push(slot)
		else groups.push({ part: p, slots: [slot] })
	}
	return groups
}

/** A number the server can text: 8 to 15 digits, with the country code. */
export function looksLikePhone(value: string) {
	const trimmed = value.trim()
	if (!/^\+?[\d\s().-]+$/.test(trimmed)) return false
	const digits = trimmed.replace(/\D/g, '').length
	return digits >= 8 && digits <= 15
}

/** Adds a party to the waitlist at the stand. */
export function JoinWaitlistSheet({
	open,
	busy,
	loadQuote,
	onJoin,
	onClose,
}: {
	open: boolean
	busy: boolean
	/** How long a party this size would wait now, to tell them before they join. */
	loadQuote: (partySize: number) => Promise<{
		quotedMin: number | null
		position: number
	}>
	onJoin: (input: {
		displayName: string
		partySize: number
		phone: string | null
	}) => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const [name, setName] = useState('')
	const [size, setSize] = useState(2)
	const [phone, setPhone] = useState('')
	useEffect(() => {
		if (open) {
			setName('')
			setSize(2)
			setPhone('')
		}
	}, [open])
	const phoneProblem = phone.trim() !== '' && !looksLikePhone(phone)
	const [quote, setQuote] = useState<{
		quotedMin: number | null
		position: number
	} | null>(null)
	useEffect(() => {
		if (!open) return
		let live = true
		setQuote(null)
		loadQuote(size).then(
			(answer) => live && setQuote(answer),
			() => live && setQuote(null),
		)
		return () => {
			live = false
		}
	}, [open, size, loadQuote])
	const quotedMin = quote?.quotedMin ?? null
	const position = quote?.position ?? 0
	return (
		<Modal
			open={open}
			onClose={onClose}
			title={_(t`Add to the waitlist`)}
			footer={
				<div className="mb-safe">
					<Button
						variant="primary"
						size="lg"
						className="w-full"
						disabled={!name.trim() || phoneProblem || busy}
						onClick={() =>
							onJoin({
								displayName: name,
								partySize: size,
								phone: phone.trim() || null,
							})
						}
					>
						<Trans>Add to the waitlist</Trans>
					</Button>
				</div>
			}
		>
			<div className="flex flex-col gap-5 p-4 sm:p-5">
				<label className="flex flex-col gap-2">
					<span className="font-semibold">
						<Trans>Name</Trans>
					</span>
					<input
						className={fieldClass}
						value={name}
						maxLength={120}
						autoComplete="off"
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<div className="flex flex-col gap-2">
					<span className="font-semibold">
						<Trans>Party size</Trans>
					</span>
					<PartySize value={size} onChange={setSize} />
					{/* Said to the party before they join: what they are signing up for. */}
					<p className="text-muted-foreground text-sm" role="status">
						{quote === null ? null : quotedMin === null ? (
							<Trans>No wait estimate right now.</Trans>
						) : (
							<Trans>
								About {quotedMin} min, number {position} in line.
							</Trans>
						)}
					</p>
				</div>
				<label className="flex flex-col gap-2">
					<span className="font-semibold">
						<Trans>Phone (to text when the table is ready)</Trans>
					</span>
					<input
						className={cn(fieldClass, 'tnum')}
						type="tel"
						inputMode="tel"
						dir="ltr"
						value={phone}
						maxLength={32}
						autoComplete="off"
						aria-invalid={phoneProblem}
						aria-describedby={
							phoneProblem ? 'waitlist-phone-problem' : undefined
						}
						onChange={(event) => setPhone(event.target.value)}
					/>
					{phoneProblem ? (
						<span
							id="waitlist-phone-problem"
							className="text-destructive text-sm"
						>
							<Trans>
								Check the number: include the country code, like +1 212 555
								0100.
							</Trans>
						</span>
					) : null}
				</label>
			</div>
		</Modal>
	)
}
