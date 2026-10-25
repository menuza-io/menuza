import { type MessageDescriptor } from '@lingui/core'
import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Armchair, CalendarDays, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
	bookingBlocker,
	bookingDirty,
	dayChips,
	hasNote,
	NOTE_PHRASES,
	toggleNote,
} from './booking.ts'
import { DiscardAsk, DiscardClose, useDiscardGuard } from './discard.tsx'
import { openSlotAt, type Availability } from './feed.ts'
import { formatPhoneTyping } from './guest.ts'
import { type Repeat } from './lookup.ts'
import {
	groupSlots,
	looksLikePhone,
	PART_OF_DAY,
	PartySize,
	STATUS_LABEL,
} from './sheets.tsx'
import { serverTime } from './zoned.ts'
import { SuccessMark } from '~/ui/motion.tsx'
import { Button, Chip, cn, fieldClass, Modal } from '~/ui/primitives.tsx'

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
	/** The table the booking was given ("1"), when the server's answer said. */
	table: string | null
	/** The guest was texted a confirmation: only when the server's answer says so. */
	textSent: boolean
}

/** A booking started from a table and a time (an empty stretch of the timeline), or for a guest. */
export type BookingPrefill = {
	date: string
	/**
	 * The time as minutes after the business day's midnight, not wrapped: a
	 * stretch after it is still this day's (1440 and more).
	 */
	startMin?: number
	tableIds: string[]
	tableLabel: string
	/** The table's seats: a bigger party books without the table. */
	maxCovers: number
	/** Whose booking it is, when the host started from a guest (book again, or a search). */
	guest?: { first: string; last: string; phone: string }
	partySize?: number
}

const NOTE_LABEL: Record<(typeof NOTE_PHRASES)[number], MessageDescriptor> = {
	'High chair': msg`High chair`,
	Window: msg`Window`,
	Quiet: msg`Quiet`,
	Wheelchair: msg`Wheelchair`,
	Birthday: msg`Birthday`,
}

export function BookingSheet({
	open,
	busy,
	locked,
	readBack,
	today,
	prefill = null,
	loadSlots,
	repeatOf,
	onOpenRepeat,
	formatTime,
	onBook,
	onClose,
}: {
	open: boolean
	busy: boolean
	/** No answer came back: the form stays as sent, so a retry is the same booking. */
	locked: boolean
	/** Booked: what to read back to the caller instead of the form. */
	readBack: BookingReadBackInfo | null
	/** The first day that can be booked (today). */
	today: string
	/** Start from this day, table, time or guest instead of today. */
	prefill?: BookingPrefill | null
	loadSlots: (date: string, partySize: number) => Promise<Availability>
	/** Whether this guest already has a booking that day (or is on the waitlist). */
	repeatOf: (
		who: { first: string; last: string; phone: string },
		date: string,
	) => Repeat | null
	/** Look at the booking (or waitlist entry) the guest already has. */
	onOpenRepeat: (repeat: Repeat) => void
	formatTime: (epochMs: number) => string
	onBook: (input: {
		date: string
		/** `HH:MM` for the server; after midnight the hour runs on (`25:30`). */
		time: string
		/** The same time as minutes after the day's midnight. */
		localStartMin: number
		/** The time as the stand shows it ("7:30 PM"). */
		timeLabel: string
		partySize: number
		firstName: string
		lastName: string
		phone: string | null
		notes: string | null
		tableIds?: string[]
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
	/** A day, in words: "Sat 28" for a button, "Sat, Oct 28" beside the date field. */
	const dayFormat = useMemo(() => {
		const make = (options: Intl.DateTimeFormatOptions) =>
			new Intl.DateTimeFormat(i18n.locale, { ...options, timeZone: 'UTC' })
		const short = make({ weekday: 'short', day: 'numeric' })
		const long = make({ weekday: 'short', month: 'short', day: 'numeric' })
		const at = (date: string) => new Date(`${date}T12:00:00Z`)
		return {
			short: (date: string) => short.format(at(date)),
			long: (date: string) => long.format(at(date)),
		}
	}, [i18n.locale])
	const [date, setDate] = useState(today)
	/** The date field is open: another day than the ones a tap away. */
	const [picking, setPicking] = useState(false)
	const [size, setSize] = useState(2)
	const [slots, setSlots] = useState<Availability['slots'] | null>(null)
	const [slotsError, setSlotsError] = useState(false)
	/** The chosen slot, as minutes after the day's midnight (what tells slots apart). */
	const [time, setTime] = useState<number | null>(null)
	const [timeLabel, setTimeLabel] = useState('')
	/** The time the booking was started at has no room: said, so a blank choice is not a mystery. */
	const [wantedGone, setWantedGone] = useState<string | null>(null)
	const [first, setFirst] = useState('')
	const [last, setLast] = useState('')
	const [phone, setPhone] = useState('')
	const [notes, setNotes] = useState('')
	/** The table the booking was started from, until the host lets it go. */
	const [tableIds, setTableIds] = useState<string[]>([])
	/** The repeat the host looked at and chose to book another beside. */
	const [bookedBeside, setBookedBeside] = useState<string | null>(null)
	/** What the form started with: carried over, not the host's own work. */
	const started = useRef({ first: '', last: '', phone: '', notes: '' })
	/** The time the booking was started at, picked again whenever the times reload. */
	const wantTime = useRef<number | null>(null)
	useEffect(() => {
		if (!open) return
		const guest = prefill?.guest
		setDate(prefill?.date ?? today)
		setPicking(false)
		setSize(prefill?.partySize ?? 2)
		setTime(null)
		wantTime.current = prefill?.startMin ?? null
		setTableIds(prefill?.tableIds ?? [])
		setFirst(guest?.first ?? '')
		setLast(guest?.last ?? '')
		setPhone(guest?.phone ?? '')
		setNotes('')
		setBookedBeside(null)
		started.current = {
			first: guest?.first ?? '',
			last: guest?.last ?? '',
			phone: guest?.phone ?? '',
			notes: '',
		}
	}, [open, today, prefill])
	useEffect(() => {
		if (!open) return
		let live = true
		setSlots(null)
		setSlotsError(false)
		setTime(null)
		setWantedGone(null)
		loadSlots(date, size).then(
			(result) => {
				if (!live) return
				const list = result.closed ? [] : result.slots
				setSlots(list)
				const wantedMin = wantTime.current
				// Matched by minute: the slot's clock string wraps at midnight, its minute does not.
				const wanted = openSlotAt(list, wantedMin)
				if (wanted) {
					setTime(wanted.localStartMin)
					setTimeLabel(slotLabel(wanted.localStartMin))
				} else if (wantedMin !== null) setWantedGone(slotLabel(wantedMin))
			},
			() => live && setSlotsError(true),
		)
		return () => {
			live = false
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- reload on the day or size, not on every label change
	}, [open, date, size, loadSlots])
	const tableFits = prefill ? size <= prefill.maxCovers : true
	const tableLabel = prefill?.tableLabel ?? ''
	const maxCovers = prefill?.maxCovers ?? 0
	const bookedTables = tableIds.length > 0 && tableFits ? tableIds : undefined
	const open_ = (slots ?? []).filter((slot) => slot.available)
	const groups = groupSlots(open_)
	const phoneProblem = phone.trim() !== '' && !looksLikePhone(phone)
	const blocker = bookingBlocker({ time, first, phoneProblem })
	const ready = blocker === null
	const chips = useMemo(() => dayChips(today), [today])
	const onChip = chips.some((chip) => chip.date === date)
	const showDateField = picking || !onChip
	// A guest who is already in the book (or waiting) is said before a second booking is made.
	const repeat =
		open && !readBack ? repeatOf({ first, last, phone }, date) : null
	const repeatKey = repeat
		? repeat.kind === 'booking'
			? `b:${repeat.reservation.id}`
			: `w:${repeat.entry.id}`
		: null
	const showRepeat = repeat !== null && repeatKey !== bookedBeside
	// A name, a number or a note typed is not thrown away by a stray tap outside.
	const guard = useDiscardGuard({
		open,
		dirty:
			!readBack && bookingDirty({ first, last, phone, notes }, started.current),
		onClose,
	})
	return (
		<Modal
			open={open}
			onClose={onClose}
			dismissible={guard.dismissible}
			size="lg"
			title={_(msg`New booking`)}
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
				) : guard.asking ? (
					<DiscardAsk
						question={<Trans>Discard this booking?</Trans>}
						onKeep={guard.keep}
						onDiscard={guard.discard}
					/>
				) : (
					<div className="mb-safe flex flex-col gap-2">
						{/* In the footer, so it is in view whatever the form has scrolled to. */}
						{showRepeat && repeat ? (
							<RepeatWarning
								repeat={repeat}
								date={date}
								today={today}
								dayLabel={dayFormat.long(date)}
								formatTime={formatTime}
								onOpen={() => onOpenRepeat(repeat)}
								onBookAnother={() => setBookedBeside(repeatKey)}
							/>
						) : null}
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
								time !== null &&
								onBook({
									date,
									time: serverTime(time),
									localStartMin: time,
									timeLabel,
									partySize: size,
									firstName: first,
									lastName: last,
									phone: phone.trim() || null,
									notes: notes.trim() || null,
									...(bookedTables ? { tableIds: bookedTables } : {}),
								})
							}
						>
							{/* When it is off, it says what is missing. */}
							{blocker === 'time' ? (
								<Trans>Choose a time</Trans>
							) : blocker === 'first' ? (
								<Trans>Add a first name</Trans>
							) : blocker === 'phone' ? (
								<Trans>Check the phone number</Trans>
							) : (
								<Trans>
									Book {size} at {timeLabel}
								</Trans>
							)}
						</Button>
					</div>
				)
			}
		>
			{guard.dismissible || readBack ? null : (
				<DiscardClose onClick={guard.requestClose} />
			)}
			{readBack ? (
				<BookingReadBack {...readBack} />
			) : (
				// Frozen after no answer: tapping Book again sends the very same booking.
				<fieldset disabled={locked} className="contents">
					<div className="flex flex-col gap-6 p-4 sm:p-5">
						<div className="flex flex-col gap-2">
							<span className="font-semibold">
								<Trans>Day</Trans>
							</span>
							<div
								role="group"
								aria-label={_(msg`Day`)}
								className="flex flex-wrap gap-2"
							>
								{chips.map((chip) => (
									<Chip
										key={chip.date}
										selected={chip.date === date && !picking}
										aria-pressed={chip.date === date && !picking}
										onClick={() => {
											setPicking(false)
											setDate(chip.date)
										}}
										className="tnum"
									>
										{chip.kind === 'today' ? (
											<Trans>Today</Trans>
										) : chip.kind === 'tomorrow' ? (
											<Trans>Tomorrow</Trans>
										) : (
											dayFormat.short(chip.date)
										)}
									</Chip>
								))}
								<Chip
									selected={showDateField}
									aria-pressed={showDateField}
									onClick={() => setPicking(true)}
								>
									<CalendarDays aria-hidden className="size-4" />
									<Trans>Pick date</Trans>
								</Chip>
							</div>
							{showDateField ? (
								<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
									<input
										type="date"
										aria-label={_(msg`Day`)}
										className={cn(fieldClass, 'tnum w-auto')}
										min={today}
										value={date}
										onChange={(event) => setDate(event.target.value || today)}
									/>
									{/* The field's own format follows the device; this says the day plainly. */}
									<span className="tnum font-semibold">
										{dayFormat.long(date)}
									</span>
								</div>
							) : null}
						</div>
						<div className="flex flex-col gap-2">
							<span className="font-semibold">
								<Trans>Party size</Trans>
							</span>
							<PartySize value={size} onChange={setSize} />
						</div>
						{prefill && tableIds.length > 0 ? (
							<div className="border-border bg-muted/60 flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3">
								<Armchair aria-hidden className="size-5 shrink-0" />
								<p className="min-w-0 flex-1 text-sm font-medium">
									{tableFits ? (
										<Trans>Table {tableLabel}, if it is free then.</Trans>
									) : (
										<Trans>
											Table {tableLabel} seats {maxCovers}. A table is found for
											this party.
										</Trans>
									)}
								</p>
								<Button variant="ghost" onClick={() => setTableIds([])}>
									<Trans>Any table</Trans>
								</Button>
							</div>
						) : null}
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
									{wantedGone ? (
										<p
											className="text-warning text-sm font-medium"
											role="status"
										>
											<Trans>
												{wantedGone} is not open for {size}. Choose another
												time.
											</Trans>
										</p>
									) : null}
									{groups.map((group) => (
										<div
											key={`${group.part}-${group.slots[0]?.localStartMin}`}
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
														selected={time === slot.localStartMin}
														aria-pressed={time === slot.localStartMin}
														onClick={() => {
															wantTime.current = null
															setWantedGone(null)
															setTime(slot.localStartMin)
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
									onChange={(event) => {
										const field = event.target
										// Spaced as it is read out, while the caret is at the end of what is typed.
										setPhone(
											field.selectionStart === field.value.length
												? formatPhoneTyping(field.value)
												: field.value,
										)
									}}
								/>
								{phoneProblem ? (
									<span
										id="booking-phone-problem"
										className="text-destructive text-sm"
									>
										<Trans>
											Check the number: include the country code, like{' '}
											<bdi dir="ltr">+1 212 555 0100</bdi>.
										</Trans>
									</span>
								) : null}
							</label>
							<div className="flex flex-col gap-2 sm:col-span-2">
								<label className="flex flex-col gap-2">
									<span className="font-semibold">
										<Trans>Note for the team</Trans>
									</span>
									<textarea
										className={cn(fieldClass, 'min-h-20 py-3')}
										value={notes}
										maxLength={500}
										placeholder={_(msg`High chair, birthday, by the window…`)}
										onChange={(event) => setNotes(event.target.value)}
									/>
								</label>
								<div
									role="group"
									aria-label={_(msg`Quick notes`)}
									className="flex flex-wrap gap-2"
								>
									{NOTE_PHRASES.map((phrase) => {
										const label = _(NOTE_LABEL[phrase])
										const on = hasNote(notes, label)
										return (
											<Chip
												key={phrase}
												selected={on}
												aria-pressed={on}
												onClick={() => setNotes(toggleNote(notes, label))}
											>
												{label}
											</Chip>
										)
									})}
								</div>
							</div>
						</div>
					</div>
				</fieldset>
			)}
		</Modal>
	)
}

/**
 * "Rana Khalid already has a booking today: 1:20 PM, 5 guests, at the stand."
 * with the choice to look at it or to book another beside it.
 */
function RepeatWarning({
	repeat,
	date,
	today,
	dayLabel,
	formatTime,
	onOpen,
	onBookAnother,
}: {
	repeat: Repeat
	date: string
	today: string
	dayLabel: string
	formatTime: (epochMs: number) => string
	onOpen: () => void
	onBookAnother: () => void
}) {
	const { _, i18n } = useLingui()
	const isToday = date === today
	let text: React.ReactNode
	if (repeat.kind === 'booking') {
		const r = repeat.reservation
		const name = r.guest?.name?.trim() || _(msg`Guest`)
		const time = formatTime(r.startAt)
		const guests = _(plural(r.partySize, { one: '# guest', other: '# guests' }))
		const state = _(STATUS_LABEL[r.status] ?? msg`Booked`).toLocaleLowerCase(
			i18n.locale,
		)
		const details = _(msg`${time}, ${guests}, ${state}`)
		text = isToday ? (
			<Trans>
				<bdi>{name}</bdi> already has a booking today: {details}.
			</Trans>
		) : (
			<Trans>
				<bdi>{name}</bdi> already has a booking on {dayLabel}: {details}.
			</Trans>
		)
	} else {
		const entry = repeat.entry
		const name = entry.displayName
		const guests = _(
			plural(entry.partySize, { one: '# guest', other: '# guests' }),
		)
		text = (
			<Trans>
				<bdi>{name}</bdi> is already on the waitlist: {guests}.
			</Trans>
		)
	}
	return (
		<div
			role="status"
			className="bg-warning/12 flex flex-col gap-2 rounded-2xl px-4 py-2.5"
		>
			<p className="text-warning flex items-start gap-3 text-sm font-medium">
				<TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
				<span className="min-w-0">{text}</span>
			</p>
			<div className="flex flex-wrap gap-2">
				<Button variant="outline" onClick={onOpen}>
					<Trans>Open it</Trans>
				</Button>
				<Button variant="outline" onClick={onBookAnother}>
					<Trans>Book another</Trans>
				</Button>
			</div>
		</div>
	)
}

/** What the host reads back to the caller once the booking is in. */
function BookingReadBack({
	asFirstSent,
	name,
	partySize,
	when,
	code,
	table,
	textSent,
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
			{table ? (
				<p className="text-lg font-semibold">
					<Trans>Table {table}</Trans>
				</p>
			) : null}
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
			{textSent ? (
				<p className="text-success text-sm font-medium">
					<Trans>A confirmation text was sent.</Trans>
				</p>
			) : null}
		</div>
	)
}
