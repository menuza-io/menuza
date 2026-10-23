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
	shortName,
	type Availability,
	type DayReservation,
	type DayTable,
	type TableState,
} from './feed.ts'
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
	| { kind: 'status'; to: StatusTarget; reason?: string }
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
	const [confirm, setConfirm] = useState<'cancelled' | 'no_show' | null>(null)
	useEffect(() => setConfirm(null), [reservation?.id])
	const r = reservation
	const actions = r
		? quickActionsFor(r.status as never, {
				nowMs: now,
				finishedAtMs: r.finishedAt ?? null,
			})
		: []
	const has = (action: QuickAction) => actions.includes(action)
	const run = (command: PartyCommand) => r && onCommand(r, command)
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
								{confirm === 'cancelled' ? (
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
									onClick={() => run({ kind: 'status', to: confirm })}
								>
									{confirm === 'cancelled' ? (
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
									onClick={() => setConfirm('no_show')}
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
									onClick={() => setConfirm('cancelled')}
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
								<a
									href={`tel:${r.guest.phone}`}
									className="tnum underline-offset-4 hover:underline"
									dir="ltr"
								>
									{r.guest.phone}
								</a>
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
							<Detail icon={CalendarPlus}>{r.occasion}</Detail>
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
	busy,
	now,
	onNotify,
	onPlace,
	onRemove,
	onClose,
}: {
	entry: WaitlistEntry | null
	busy: boolean
	now: number
	onNotify: (entry: WaitlistEntry) => void
	onPlace: (entry: WaitlistEntry) => void
	onRemove: (entry: WaitlistEntry) => void
	onClose: () => void
}) {
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
						<Button
							variant="ghost"
							size="lg"
							disabled={busy}
							onClick={() => onRemove(entry)}
						>
							<Trans>They left</Trans>
						</Button>
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
							<a href={`tel:${entry.phone}`} className="tnum" dir="ltr">
								{entry.phone}
							</a>
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
	useEffect(() => {
		if (target) setSize(Math.min(target.table.maxCovers, 2))
	}, [target])
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
export function BookingSheet({
	open,
	busy,
	today,
	loadSlots,
	onBook,
	onClose,
}: {
	open: boolean
	busy: boolean
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
	useEffect(() => {
		if (!open) return
		setDate(today)
		setSize(2)
		setTime(null)
		setFirst('')
		setLast('')
		setPhone('')
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
	const ready = time !== null && first.trim().length > 0
	return (
		<Modal
			open={open}
			onClose={onClose}
			size="lg"
			title={_(t`New booking`)}
			footer={
				<div className="mb-safe">
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
			}
		>
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
						<div className="flex flex-wrap gap-2">
							{open_.map((slot) => (
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
							onChange={(event) => setPhone(event.target.value)}
						/>
					</label>
				</div>
			</div>
		</Modal>
	)
}

/** Adds a party to the waitlist at the stand. */
export function JoinWaitlistSheet({
	open,
	busy,
	onJoin,
	onClose,
}: {
	open: boolean
	busy: boolean
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
						disabled={!name.trim() || busy}
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
						onChange={(event) => setPhone(event.target.value)}
					/>
				</label>
			</div>
		</Modal>
	)
}
