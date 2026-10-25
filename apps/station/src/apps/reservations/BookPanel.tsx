import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type WaitlistEntry } from '@repo/reservations'
import {
	BadgeCheck,
	BellRing,
	Cake,
	CalendarPlus,
	ChevronDown,
	Clock3,
	CreditCard,
	Crown,
	Globe,
	Info,
	Search,
	Smartphone,
	StickyNote,
	TriangleAlert,
	UserX,
	Users,
	X,
} from 'lucide-react'
import { useState, type ComponentType, type ReactNode } from 'react'
import { coversOf, partyStatus, type BookList } from './book.ts'
import {
	hasNotes,
	isVip,
	OCCASION_LABEL,
	shortName,
	type DayReservation,
} from './feed.ts'
import { depositState, showsAllergyMark } from './guest.ts'
import { highlightRanges } from './lookup.ts'
import { placingKey, type Placing } from './placing.ts'
import { stayOf } from './stay.ts'
import {
	joinedOnline,
	minutesWaited,
	textedState,
	toldHow,
} from './waitlist.ts'
import { SoftText } from '~/ui/motion.tsx'
import { Button, cn, fieldClass, IconButton, Reveal } from '~/ui/primitives.tsx'

type SectionId =
	'waitlist' | 'toSeat' | 'awaiting' | 'seated' | 'missed' | 'finished'

/**
 * The left of the host stand: a search over everything, then the day in
 * sections the host works top to bottom: the waitlist, the bookings still to
 * seat (by scheduled time), who is seated (longest first), who never came and
 * who has left. A row is one tap to pick the party up (the floor then shows
 * where they fit); its info button opens the details.
 */
export function BookPanel({
	list,
	query,
	onQuery,
	placing,
	now,
	formatTime,
	isToday,
	waitlistOn,
	single,
	fresh,
	canReadGuest,
	textedBy,
	onPick,
	onDetails,
	onWaitlistDetails,
	onAddWaitlist,
	onBookFor,
	onWaitlistFor,
	onClose,
}: {
	list: BookList
	query: string
	onQuery: (query: string) => void
	placing: Placing | null
	now: number
	formatTime: (epochMs: number) => string
	/** Seating is today's: another day's rows open their details instead. */
	isToday: boolean
	waitlistOn: boolean
	/** The panel is the whole screen (a phone's List tab). */
	single: boolean
	/** Bookings that came in while the host was looking and have not been opened since: they carry a dot. */
	fresh: ReadonlySet<string>
	/** Whether guest details are readable: an allergy mark needs more than the server's flag then. */
	canReadGuest: boolean
	/** What each told party's notify answer said about a text (by waitlist entry id). */
	textedBy: ReadonlyMap<string, boolean>
	onPick: (placing: Placing | null) => void
	onDetails: (reservation: DayReservation) => void
	onWaitlistDetails: (entry: WaitlistEntry) => void
	onAddWaitlist: () => void
	/** A search found no one: book what was typed (a name, or a number). */
	onBookFor: (typed: string) => void
	/** The same, onto the waitlist. */
	onWaitlistFor: (typed: string) => void
	/** The panel is a drawer over the floor (a narrow tablet): how to put it away. */
	onClose?: () => void
}) {
	const { _ } = useLingui()
	const [closed, setClosed] = useState<Record<SectionId, boolean>>({
		waitlist: false,
		toSeat: false,
		awaiting: false,
		seated: false,
		missed: true,
		finished: true,
	})
	const typed = query.trim()
	const searching = typed.length > 0
	const selected = placingKey(placing)
	const open = (id: SectionId) => searching || !closed[id]
	const toggle = (id: SectionId) =>
		setClosed((previous) => ({ ...previous, [id]: !previous[id] }))
	// Everything the search finds, in every section (not only the ones open by default).
	const found =
		list.toSeat.length +
		list.awaiting.length +
		list.seated.length +
		list.missed.length +
		list.finished.length +
		list.waitlist.length
	const nothing = found === 0
	// While searching, a section with no match steps aside instead of saying "nobody".
	const show = (count: number) => !searching || count > 0

	return (
		<section
			aria-label={_(msg`Parties to seat`)}
			className="bk-panel"
			data-single={single}
		>
			<div className="border-border flex shrink-0 items-center gap-2 border-b p-3">
				{onClose ? (
					<IconButton label={_(msg`Close the list`)} onClick={onClose}>
						<X className="size-5" />
					</IconButton>
				) : null}
				<label className="relative block min-w-0 flex-1">
					<span className="sr-only">
						<Trans>Search parties</Trans>
					</span>
					<Search
						aria-hidden
						className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2"
					/>
					<input
						type="search"
						value={query}
						onChange={(event) => onQuery(event.target.value)}
						placeholder={_(msg`Name, phone, table or code`)}
						autoComplete="off"
						enterKeyHint="search"
						className={cn(
							fieldClass,
							'ps-10 pe-11 [&::-webkit-search-cancel-button]:hidden',
						)}
					/>
					{query ? (
						<IconButton
							label={_(msg`Clear search`)}
							onClick={() => onQuery('')}
							className="absolute end-0.5 top-1/2 -translate-y-1/2"
						>
							<X className="size-4" />
						</IconButton>
					) : null}
				</label>
			</div>

			<div className="bk-scroll">
				<p role="status" className="sr-only">
					{searching
						? nothing
							? _(msg`No one matches the search.`)
							: _(msg`${found} found`)
						: ''}
				</p>
				{searching && nothing ? (
					<div className="flex flex-col items-center gap-3 p-6 text-center">
						<p className="text-muted-foreground">
							<Trans>
								No one matches “<bdi>{typed}</bdi>”.
							</Trans>
						</p>
						<div className="flex w-full max-w-xs flex-col gap-2">
							<Button
								variant="primary"
								size="lg"
								className="h-auto min-h-14 py-2 leading-tight"
								onClick={() => onBookFor(typed)}
							>
								<CalendarPlus aria-hidden className="size-5 shrink-0" />
								<span className="min-w-0 truncate">
									<Trans>
										Book “<bdi>{typed}</bdi>”
									</Trans>
								</span>
							</Button>
							{waitlistOn && isToday ? (
								<Button
									variant="outline"
									size="lg"
									className="h-auto min-h-14 py-2 leading-tight"
									onClick={() => onWaitlistFor(typed)}
								>
									<Users aria-hidden className="size-5 shrink-0" />
									<span className="min-w-0 truncate">
										<Trans>
											Add “<bdi>{typed}</bdi>” to the waitlist
										</Trans>
									</span>
								</Button>
							) : null}
						</div>
					</div>
				) : null}

				{waitlistOn && isToday && show(list.waitlist.length) ? (
					<Section
						title={_(msg`Waitlist`)}
						count={list.waitlist.length}
						covers={coversOf(list.waitlist)}
						open={open('waitlist')}
						onToggle={() => toggle('waitlist')}
						action={
							<IconButton
								label={_(msg`Add a party to the waitlist`)}
								onClick={onAddWaitlist}
							>
								<Users className="size-5" />
								<span aria-hidden className="-ms-1 text-lg leading-none">
									+
								</span>
							</IconButton>
						}
					>
						{list.waitlist.length === 0 ? (
							<Empty>
								<Trans>Nobody is waiting.</Trans>
							</Empty>
						) : (
							<ul>
								{list.waitlist.map((entry, index) => (
									<WaitlistRow
										key={entry.id}
										entry={entry}
										index={index}
										now={now}
										query={typed}
										formatTime={formatTime}
										textQueued={textedBy.get(entry.id)}
										selected={selected === `w:${entry.id}`}
										onPick={() =>
											onPick(
												selected === `w:${entry.id}`
													? null
													: { kind: 'waitlist', entry },
											)
										}
										onDetails={() => onWaitlistDetails(entry)}
									/>
								))}
							</ul>
						)}
					</Section>
				) : null}

				{show(list.toSeat.length) ? (
					<Section
						title={_(msg`Reservations`)}
						subtitle={
							isToday
								? _(msg`still to seat, by time`)
								: _(msg`by scheduled time`)
						}
						count={list.toSeat.length}
						covers={coversOf(list.toSeat)}
						open={open('toSeat')}
						onToggle={() => toggle('toSeat')}
					>
						{list.toSeat.length === 0 ? (
							<Empty>
								{isToday ? (
									<Trans>No more bookings today.</Trans>
								) : (
									<Trans>No bookings this day.</Trans>
								)}
							</Empty>
						) : (
							<ul>
								{list.toSeat.map((reservation, index) => (
									<ReservationRow
										key={reservation.id}
										reservation={reservation}
										index={index}
										now={now}
										query={typed}
										fresh={fresh.has(reservation.id)}
										canReadGuest={canReadGuest}
										formatTime={formatTime}
										mode="toSeat"
										canPick={isToday}
										selected={selected === `r:${reservation.id}`}
										onPick={() =>
											onPick(
												selected === `r:${reservation.id}`
													? null
													: { kind: 'reservation', reservation },
											)
										}
										onDetails={() => onDetails(reservation)}
									/>
								))}
							</ul>
						)}
					</Section>
				) : null}

				{list.awaiting.length > 0 ? (
					<Section
						title={_(msg`Awaiting payment`)}
						subtitle={_(msg`held until the deposit is paid`)}
						count={list.awaiting.length}
						covers={coversOf(list.awaiting)}
						open={open('awaiting')}
						onToggle={() => toggle('awaiting')}
					>
						<ul>
							{list.awaiting.map((reservation, index) => (
								<ReservationRow
									key={reservation.id}
									reservation={reservation}
									index={index}
									now={now}
									query={typed}
									fresh={fresh.has(reservation.id)}
									canReadGuest={canReadGuest}
									formatTime={formatTime}
									mode="awaiting"
									canPick={false}
									selected={false}
									onPick={() => onDetails(reservation)}
									onDetails={() => onDetails(reservation)}
								/>
							))}
						</ul>
					</Section>
				) : null}

				{show(list.seated.length) && (isToday || list.seated.length > 0) ? (
					<Section
						title={_(msg`Seated`)}
						subtitle={_(msg`longest first`)}
						count={list.seated.length}
						covers={coversOf(list.seated)}
						open={open('seated')}
						onToggle={() => toggle('seated')}
					>
						{list.seated.length === 0 ? (
							<Empty>
								<Trans>Nobody is seated.</Trans>
							</Empty>
						) : (
							<ul>
								{list.seated.map((reservation, index) => (
									<ReservationRow
										key={reservation.id}
										reservation={reservation}
										index={index}
										now={now}
										query={typed}
										fresh={fresh.has(reservation.id)}
										canReadGuest={canReadGuest}
										formatTime={formatTime}
										mode="seated"
										canPick={false}
										selected={false}
										onPick={() => onDetails(reservation)}
										onDetails={() => onDetails(reservation)}
									/>
								))}
							</ul>
						)}
					</Section>
				) : null}

				{list.missed.length > 0 ? (
					<Section
						title={_(msg`Didn’t arrive`)}
						count={list.missed.length}
						covers={coversOf(list.missed)}
						open={open('missed')}
						onToggle={() => toggle('missed')}
					>
						<ul>
							{list.missed.map((reservation, index) => (
								<ReservationRow
									key={reservation.id}
									reservation={reservation}
									index={index}
									now={now}
									query={typed}
									fresh={fresh.has(reservation.id)}
									canReadGuest={canReadGuest}
									formatTime={formatTime}
									mode="missed"
									canPick={false}
									selected={false}
									onPick={() => onDetails(reservation)}
									onDetails={() => onDetails(reservation)}
								/>
							))}
						</ul>
					</Section>
				) : null}

				{list.finished.length > 0 ? (
					<Section
						title={_(msg`Finished`)}
						count={list.finished.length}
						covers={coversOf(list.finished)}
						open={open('finished')}
						onToggle={() => toggle('finished')}
					>
						<ul>
							{list.finished.map((reservation, index) => (
								<ReservationRow
									key={reservation.id}
									reservation={reservation}
									index={index}
									now={now}
									query={typed}
									fresh={fresh.has(reservation.id)}
									canReadGuest={canReadGuest}
									formatTime={formatTime}
									mode="finished"
									canPick={false}
									selected={false}
									onPick={() => onDetails(reservation)}
									onDetails={() => onDetails(reservation)}
								/>
							))}
						</ul>
					</Section>
				) : null}
			</div>
		</section>
	)
}

function Empty({ children }: { children: ReactNode }) {
	return <p className="text-muted-foreground px-4 py-4 text-sm">{children}</p>
}

/** A collapsible section: its title, how many parties and covers it holds, and what is in it. */
function Section({
	title,
	subtitle,
	count,
	covers,
	open,
	onToggle,
	action,
	children,
}: {
	title: string
	subtitle?: string
	count: number
	covers: number
	open: boolean
	onToggle: () => void
	action?: ReactNode
	children: ReactNode
}) {
	const { _ } = useLingui()
	return (
		<div>
			<div className="bk-section-head">
				<button
					type="button"
					aria-expanded={open}
					onClick={onToggle}
					className="bk-section-toggle"
				>
					<ChevronDown aria-hidden className="bk-chevron size-4" />
					<span className="min-w-0">
						<span className="block truncate text-sm leading-tight font-semibold">
							{title}
						</span>
						{subtitle ? (
							<span className="text-muted-foreground block truncate text-xs leading-tight">
								{subtitle}
							</span>
						) : null}
					</span>
					<span className="ms-auto flex shrink-0 items-center gap-2">
						<span
							className="bg-background tnum rounded-full px-2 py-0.5 text-xs font-semibold"
							aria-label={_(
								plural(count, { one: '# party', other: '# parties' }),
							)}
						>
							{count}
						</span>
						<span
							className="text-muted-foreground tnum inline-flex items-center gap-1 text-xs font-semibold"
							aria-label={_(
								plural(covers, { one: '# cover', other: '# covers' }),
							)}
						>
							<Users aria-hidden className="size-3.5" />
							{covers}
						</span>
					</span>
				</button>
				{action}
			</div>
			<Reveal open={open}>{children}</Reveal>
		</div>
	)
}

/**
 * A time or a wait in a narrow column: "7:20" over "PM", "14" over "min". A
 * time with no spaced suffix (a 24 hour clock) stays on one line.
 */
function Stacked({ text, className }: { text: string; className?: string }) {
	const parts = /^(.+)[\s\u202f\u00a0]+(\S+)$/.exec(text)
	if (!parts)
		return (
			<span
				className={cn('tnum text-sm leading-tight font-semibold', className)}
			>
				{text}
			</span>
		)
	return (
		<span className="flex flex-col leading-tight">
			<span className={cn('tnum text-sm font-semibold', className)}>
				{parts[1]}
			</span>
			<span className="text-muted-foreground text-xs font-medium">
				{parts[2]}
			</span>
		</span>
	)
}

/** A name with the typed words marked (accents and case ignored, as the search is). */
function Highlight({ text, query }: { text: string; query: string }) {
	const ranges = highlightRanges(text, query)
	if (ranges.length === 0) return <>{text}</>
	const parts: ReactNode[] = []
	let at = 0
	ranges.forEach(([from, to], i) => {
		if (from > at) parts.push(text.slice(at, from))
		parts.push(
			<mark key={i} className="bk-hit">
				{text.slice(from, to)}
			</mark>,
		)
		at = to
	})
	if (at < text.length) parts.push(text.slice(at))
	return <>{parts}</>
}

/** A small icon that says what it means to a screen reader too. */
function Mark({
	icon: Icon,
	label,
	className,
}: {
	icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
	label: string
	className?: string
}) {
	return (
		<span className="inline-flex shrink-0" title={label}>
			<Icon aria-hidden className={cn('size-3.5', className)} />
			<span className="sr-only">{label}</span>
		</span>
	)
}

function ReservationRow({
	reservation: r,
	index,
	now,
	query,
	fresh,
	canReadGuest,
	formatTime,
	mode,
	canPick,
	selected,
	onPick,
	onDetails,
}: {
	reservation: DayReservation
	index: number
	now: number
	/** What is typed in the search: marked in the name. */
	query: string
	/** Came in since the host last looked, and not opened yet: a dot. */
	fresh: boolean
	canReadGuest: boolean
	formatTime: (epochMs: number) => string
	mode: 'toSeat' | 'awaiting' | 'seated' | 'missed' | 'finished'
	canPick: boolean
	selected: boolean
	onPick: () => void
	onDetails: () => void
}) {
	const { _ } = useLingui()
	const status = partyStatus(r, now)
	const { late, said: runningLate } = status
	const who = shortName(r, _(msg`Guest`))
	const occasionLabel = r.occasion
		? OCCASION_LABEL[r.occasion]
			? _(OCCASION_LABEL[r.occasion]!)
			: r.occasion
		: ''
	const stay = mode === 'seated' ? stayOf(r, now) : null
	const seatedFor = stay?.seatedMin ?? null
	const leftMin = stay?.leftMin ?? 0
	const overMin = stay?.overMin ?? 0
	const tables = r.tableLabels.join(' + ')
	const marked = r.status === 'no_show'
	const deposit = depositState(r)
	const source =
		r.channel === 'online'
			? 'online'
			: r.channel === 'native' || r.channel === 'voice_agent'
				? 'app'
				: null

	let line: ReactNode
	if (mode === 'seated' && seatedFor !== null)
		line = (
			<span className={cn('tnum', stay?.over && 'text-warning font-semibold')}>
				<SoftText value={_(msg`${seatedFor} min`)} />
				{' · '}
				{stay?.over ? _(msg`${overMin}m over`) : _(msg`~${leftMin}m left`)}
			</span>
		)
	else if (mode === 'missed')
		line = (
			<span className="text-warning font-medium">
				{marked ? (
					r.canUndo === false ? (
						<Trans>No-show</Trans>
					) : (
						<Trans>Not a no-show</Trans>
					)
				) : (
					<Trans>Mark as no-show</Trans>
				)}
			</span>
		)
	else if (status.kind === 'awaiting')
		line = (
			<span className="text-warning font-semibold">
				<Trans>Awaiting payment</Trans>
			</span>
		)
	else if (status.kind === 'seated')
		// Seated with no time recorded: say so, never "Booked".
		line = (
			<span>
				<Trans>Seated</Trans>
			</span>
		)
	else if (status.kind === 'here')
		line = (
			<span className="text-success font-semibold">
				<Trans>At the stand</Trans>
			</span>
		)
	else if (status.kind === 'late' && status.said > 0)
		line = (
			<span className="text-warning font-semibold">
				<Trans>
					{late} min late (said {runningLate})
				</Trans>
			</span>
		)
	else if (status.kind === 'late')
		line = (
			<span className="text-warning font-semibold">
				<Trans>{late} min late</Trans>
			</span>
		)
	else if (status.kind === 'running')
		line = (
			<span className="text-warning font-semibold">
				<Trans>Running {runningLate} min late</Trans>
			</span>
		)
	else if (status.kind === 'confirmed')
		line = (
			<span>
				<Trans>Confirmed</Trans>
			</span>
		)
	else if (status.kind === 'finished')
		line = (
			<span>
				<Trans>Finished</Trans>
			</span>
		)
	else
		line = (
			<span>
				<Trans>Booked</Trans>
			</span>
		)

	const clock = mode === 'seated' && r.seatedAt ? r.seatedAt : r.startAt
	return (
		<li
			className="bk-row"
			data-tone={
				mode === 'missed' ? 'no_show' : stay?.over ? 'late' : status.kind
			}
			data-selected={selected}
			data-muted={mode === 'finished' || mode === 'missed'}
			style={{ '--bk-i': index } as React.CSSProperties}
		>
			<button
				type="button"
				className="bk-row-main"
				aria-pressed={canPick ? selected : undefined}
				onClick={onPick}
			>
				<span className="bk-stripe" aria-hidden />
				<Stacked
					text={formatTime(clock)}
					className={mode === 'missed' ? 'line-through' : undefined}
				/>
				<span className="min-w-0 py-2">
					<span className="flex min-w-0 items-center gap-1.5">
						{fresh ? (
							<span className="bk-new" title={_(msg`New`)}>
								<span className="sr-only">
									<Trans>New</Trans>
								</span>
							</span>
						) : null}
						<bdi className="truncate font-semibold">
							<Highlight text={who} query={query} />
						</bdi>
						{showsAllergyMark(r, canReadGuest) ? (
							<Mark
								icon={TriangleAlert}
								label={_(msg`Allergy noted`)}
								className="text-warning"
							/>
						) : null}
						{isVip(r) ? (
							<Mark icon={Crown} label={_(msg`VIP`)} className="text-primary" />
						) : null}
						{r.occasion ? (
							<Mark
								icon={Cake}
								label={_(msg`Occasion: ${occasionLabel}`)}
								className="text-primary"
							/>
						) : null}
						{hasNotes(r) ? (
							<Mark
								icon={StickyNote}
								label={_(msg`Has notes`)}
								className="text-muted-foreground"
							/>
						) : null}
						{source && mode !== 'finished' && mode !== 'missed' ? (
							<Mark
								icon={source === 'online' ? Globe : Smartphone}
								label={
									source === 'online'
										? _(msg`Booked online`)
										: _(msg`Booked in the app`)
								}
								className="text-muted-foreground"
							/>
						) : null}
						{deposit === 'paid' && mode !== 'finished' && mode !== 'missed' ? (
							<Mark
								icon={BadgeCheck}
								label={_(msg`Deposit paid`)}
								className="text-success"
							/>
						) : null}
						{status.said > 0 && mode === 'toSeat' && status.kind !== 'here' ? (
							<Mark
								icon={Clock3}
								label={_(msg`Running late`)}
								className="text-warning"
							/>
						) : null}
					</span>
					<span className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1.5 text-xs leading-tight">
						<span className="inline-flex shrink-0 items-center gap-1">
							<Users aria-hidden className="size-3.5" />
							<span className="tnum font-semibold">{r.partySize}</span>
							<span className="sr-only">
								<Trans>guests</Trans>
							</span>
						</span>
						<span aria-hidden>·</span>
						<span className="truncate">{line}</span>
					</span>
				</span>
				{mode === 'missed' ? (
					<UserX aria-hidden className="text-muted-foreground size-4" />
				) : mode === 'awaiting' ? (
					// The row already says "Awaiting payment": the tag is a mark, so the words keep their room.
					<span className="bk-pay-tag" title={_(msg`Deposit`)}>
						<CreditCard aria-hidden className="size-3.5" />
						<span className="sr-only">
							<Trans>Deposit</Trans>
						</span>
					</span>
				) : tables ? (
					<span className="bk-badge">
						<span className="sr-only">
							<Trans>Table</Trans>{' '}
						</span>
						{tables}
					</span>
				) : mode === 'toSeat' && canPick ? (
					<span className="bk-seat" aria-hidden={false}>
						<Trans>Seat</Trans>
					</span>
				) : (
					<span />
				)}
			</button>
			<button
				type="button"
				className="bk-row-info"
				onClick={onDetails}
				aria-label={_(msg`Details for ${who}`)}
			>
				<Info aria-hidden className="size-4" />
			</button>
		</li>
	)
}

function WaitlistRow({
	entry,
	index,
	now,
	query,
	formatTime,
	textQueued,
	selected,
	onPick,
	onDetails,
}: {
	entry: WaitlistEntry
	index: number
	now: number
	query: string
	formatTime: (epochMs: number) => string
	/** What the notify answer said about a text, when this tablet told them. */
	textQueued: boolean | undefined
	selected: boolean
	onPick: () => void
	onDetails: () => void
}) {
	const { _ } = useLingui()
	const waited = minutesWaited(entry, now)
	const quoted = entry.quotedMin
	const texted = textedState(entry, now)
	const over = quoted !== null && waited > quoted
	const name = entry.firstName || entry.displayName
	const heldFor = texted?.minutesLeft ?? 0
	const textedAt = texted ? formatTime(texted.notifiedAt) : ''
	const textSent = toldHow(entry, textQueued) === 'text_sent'
	const online = joinedOnline(entry)
	return (
		<li
			className="bk-row"
			data-tone={
				texted?.urgent
					? 'late'
					: entry.status === 'notified'
						? 'here'
						: over
							? 'late'
							: 'booked'
			}
			data-selected={selected}
			style={{ '--bk-i': index } as React.CSSProperties}
		>
			<button
				type="button"
				className="bk-row-main"
				aria-pressed={selected}
				onClick={onPick}
			>
				<span className="bk-stripe" aria-hidden />
				<Stacked
					text={_(plural(waited, { one: '# min', other: '# min' }))}
					className={over ? 'text-warning' : undefined}
				/>
				<span className="min-w-0 py-2">
					<span className="flex min-w-0 items-center gap-1.5">
						<bdi className="truncate font-semibold">
							<Highlight text={name} query={query} />
						</bdi>
						{online ? (
							<Mark
								icon={Smartphone}
								label={_(msg`Joined online`)}
								className="text-primary"
							/>
						) : null}
						{entry.status === 'notified' ? (
							<Mark
								icon={BellRing}
								label={_(msg`Told their table is ready`)}
								className={texted?.urgent ? 'text-warning' : 'text-success'}
							/>
						) : null}
						{entry.notes ? (
							<Mark
								icon={StickyNote}
								label={_(msg`Has notes`)}
								className="text-muted-foreground"
							/>
						) : null}
					</span>
					<span className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1.5 text-xs leading-tight">
						<span className="inline-flex shrink-0 items-center gap-1">
							<Users aria-hidden className="size-3.5" />
							<span className="tnum font-semibold">{entry.partySize}</span>
							<span className="sr-only">
								<Trans>guests</Trans>
							</span>
						</span>
						<span aria-hidden>·</span>
						<span
							className={cn(
								'truncate',
								texted?.urgent && 'text-warning font-semibold',
							)}
						>
							{texted ? (
								texted.expired ? (
									textSent ? (
										<Trans>Texted, no response</Trans>
									) : (
										<Trans>Told, no response</Trans>
									)
								) : texted.minutesLeft !== null ? (
									_(
										textSent
											? plural(heldFor, {
													one: 'Texted, holds # min',
													other: 'Texted, holds # min',
												})
											: plural(heldFor, {
													one: 'Told, holds # min',
													other: 'Told, holds # min',
												}),
									)
								) : textSent ? (
									<Trans>Texted {textedAt}</Trans>
								) : (
									<Trans>Told {textedAt}</Trans>
								)
							) : quoted !== null ? (
								_(
									plural(quoted, {
										one: 'Quoted # min',
										other: 'Quoted # min',
									}),
								)
							) : (
								<Trans>No quote</Trans>
							)}
						</span>
					</span>
				</span>
				<span className="bk-seat" aria-hidden={false}>
					<Trans>Seat</Trans>
				</span>
			</button>
			<button
				type="button"
				className="bk-row-info"
				onClick={onDetails}
				aria-label={_(msg`Details for ${name}`)}
			>
				<Info aria-hidden className="size-4" />
			</button>
		</li>
	)
}
