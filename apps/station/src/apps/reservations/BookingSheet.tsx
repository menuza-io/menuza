import { type MessageDescriptor } from '@lingui/core'
import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
	bookingBlocker,
	bookingDirty,
	dayChips,
	hasNote,
	NOTE_MAX,
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
import { type SlotReason } from './slotReasons.ts'
import { serverTime } from './zoned.ts'
import { SuccessMark } from '~/ui/motion.tsx'
import { Input, Button, Chip, cn, fieldClass, Modal } from '~/ui/primitives.tsx'

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
	slotReason,
	repeatOf,
	checkedDay,
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
	/**
	 * Why a time is not open, when the stand can tell (no table seats a party this
	 * big, the slot is full). Without it a time that is not open says "Not open".
	 */
	slotReason?: (
		slot: Availability['slots'][number],
		partySize: number,
		date: string,
	) => SlotReason
	/** Whether this guest already has a booking that day (or is on the waitlist). */
	repeatOf: (
		who: { first: string; last: string; phone: string },
		date: string,
	) => Repeat | null
	/**
	 * The one day a repeat is looked for (the day the stand has loaded): a
	 * booking on another day is not compared, and the sheet says so.
	 */
	checkedDay: string
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
	/** The few words under a time that is not open. */
	const reasonWords = (reason: SlotReason) =>
		reason === 'big'
			? _(msg`Needs a bigger table`)
			: reason === 'full'
				? _(msg`Full`)
				: reason === 'held'
					? _(msg`Held`)
					: _(msg`Not open`)
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
	// The same prefill drawn again (an equal copy, a re-render) does not start the form over.
	const prefillKey = prefill ? JSON.stringify(prefill) : ''
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
		// eslint-disable-next-line react-hooks/exhaustive-deps -- the prefill's content (its key) starts the form, not its identity
	}, [open, today, prefillKey])
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
	// Every time stays on the grid, the ones not open dimmed with why (so a host
	// can tell a caller "we are full at 8" and offer the times either side).
	const groups = groupSlots(slots ?? [])
	const phoneProblem = phone.trim() !== '' && !looksLikePhone(phone)
	const blocker = bookingBlocker({ time, first, phoneProblem })
	const ready = blocker === null
	const chips = useMemo(() => dayChips(today), [today])
	const checkedDayLabel = dayFormat.long(checkedDay)
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
	/** "Open it": the booking to look at once this form is let go (asked about first when it holds something). */
	const opening = useRef<Repeat | null>(null)
	// A name, a number or a note typed is not thrown away by a stray tap outside,
	// and not by "Open it" either: it asks the same question first.
	const guard = useDiscardGuard({
		open,
		dirty:
			!readBack && bookingDirty({ first, last, phone, notes }, started.current),
		onClose: () => {
			const repeatToOpen = opening.current
			opening.current = null
			if (repeatToOpen) onOpenRepeat(repeatToOpen)
			else onClose()
		},
	})
	// Not asking (kept editing, or closed): nothing is waiting to open.
	useEffect(() => {
		if (!guard.asking) opening.current = null
	}, [guard.asking])
	/** The quick note that would not fit: said, so a tap is never dead. */
	const [noteFull, setNoteFull] = useState(false)
	// Whether the repeat check covers the day picked, and a name or number is typed to check.
	const unchecked =
		date !== checkedDay &&
		[first, last, phone].some((field) => field.trim() !== '')
	return (
		<Modal
			open={open}
			onClose={onClose}
			dismissible={guard.dismissible}
			size="lg"
			title={_(msg`New booking`)}
			footer={
				readBack ? (
					<div>
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
					<div className="flex flex-col gap-2">
						{/* In the footer, so it is in view whatever the form has scrolled to. */}
						{showRepeat && repeat ? (
							<RepeatWarning
								repeat={repeat}
								date={date}
								today={today}
								dayLabel={dayFormat.long(date)}
								formatTime={formatTime}
								onOpen={() => {
									opening.current = repeat
									guard.requestClose()
								}}
								onBookAnother={() => setBookedBeside(repeatKey)}
							/>
						) : null}
						{unchecked && !showRepeat ? (
							<p className="text-muted-foreground text-xs" role="status">
								{checkedDay === today ? (
									<Trans>Duplicates are checked for today only.</Trans>
								) : (
									<Trans>
										Duplicates are checked for {checkedDayLabel} only.
									</Trans>
								)}
							</p>
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
										look="outlined"
										key={chip.date}
										selected={chip.date === date && !picking}
										aria-pressed={chip.date === date && !picking}
										onClick={() => {
											setPicking(false)
											setDate(chip.date)
										}}
										className="tabular-nums"
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
									look="outlined"
									selected={showDateField}
									aria-pressed={showDateField}
									onClick={() => setPicking(true)}
								>
									<Icon name="calendar-days" aria-hidden className="size-4" />
									<Trans>Pick date</Trans>
								</Chip>
							</div>
							{showDateField ? (
								<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
									<Input
										type="date"
										aria-label={_(msg`Day`)}
										className={cn('w-auto tabular-nums')}
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
							<div className="border-border bg-muted/60 flex flex-wrap items-center gap-3 rounded-(--station-panel-radius) border px-4 py-3">
								<Icon name="armchair" aria-hidden className="size-5 shrink-0" />
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
							) : slots.length === 0 ? (
								<p className="text-muted-foreground text-sm">
									<Trans>No times left for {size} on this day.</Trans>
								</p>
							) : (
								<div className="flex flex-col gap-3">
									{open_.length === 0 ? (
										<p className="text-muted-foreground text-sm">
											<Trans>No times left for {size} on this day.</Trans>
										</p>
									) : null}
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
														look="outlined"
														key={slot.localStartMin}
														selected={time === slot.localStartMin}
														aria-pressed={time === slot.localStartMin}
														disabled={!slot.available}
														onClick={() => {
															// The time they picked is the one wanted: a change of size looks for it again.
															wantTime.current = slot.localStartMin
															setWantedGone(null)
															setTime(slot.localStartMin)
															setTimeLabel(slotLabel(slot.localStartMin))
														}}
														className={cn(
															'min-w-20 tabular-nums',
															!slot.available &&
																'h-auto min-h-11 max-w-28 flex-col gap-0 py-1 text-center leading-tight',
														)}
													>
														{slotLabel(slot.localStartMin)}
														{slot.available ? null : (
															<span className="text-muted-foreground text-xs font-medium">
																{reasonWords(
																	slotReason?.(slot, size, date) ?? 'closed',
																)}
															</span>
														)}
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
								<Input
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
								<Input
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
								<Input
									className={cn('tabular-nums')}
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
										maxLength={NOTE_MAX}
										placeholder={_(msg`High chair, birthday, by the window…`)}
										onChange={(event) => {
											setNotes(event.target.value)
											setNoteFull(false)
										}}
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
												look="outlined"
												key={phrase}
												selected={on}
												aria-pressed={on}
												onClick={() => {
													const next = toggleNote(notes, label, NOTE_MAX)
													// Nothing changed and it was not there to take out: it does not fit.
													setNoteFull(next === notes && !on)
													setNotes(next)
												}}
											>
												{label}
											</Chip>
										)
									})}
								</div>
								{noteFull ? (
									<p className="text-warning text-sm font-medium" role="status">
										<Trans>
											The note is full ({NOTE_MAX} characters). Shorten it to
											add more.
										</Trans>
									</p>
								) : null}
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
			className="bg-warning/10 flex flex-col gap-2 rounded-(--station-control-radius) px-4 py-3"
		>
			<p className="text-warning flex items-start gap-3 text-sm font-medium">
				<Icon
					name="alert-triangle"
					aria-hidden
					className="mt-0.5 size-4 shrink-0 self-start"
				/>
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
}: BookingReadBackInfo) {
	if (asFirstSent)
		return (
			<div className="flex flex-col items-center gap-3 p-6 text-center">
				<SuccessMark tone="muted" />
				<p className="text-xl font-semibold">
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
			<p className="text-2xl font-semibold">
				<Trans>
					<bdi>{name}</bdi>, party of {partySize}
				</Trans>
			</p>
			<p className="text-muted-foreground text-base">{when}</p>
			{table ? (
				<p className="text-base font-semibold">
					<Trans>Table {table}</Trans>
				</p>
			) : null}
			{code ? (
				<div className="flex flex-col items-center gap-1">
					<span className="text-muted-foreground text-sm font-medium">
						<Trans>Confirmation code</Trans>
					</span>
					<span
						className="mono text-3xl font-semibold tracking-widest"
						dir="ltr"
					>
						{code}
					</span>
				</div>
			) : null}
		</div>
	)
}
