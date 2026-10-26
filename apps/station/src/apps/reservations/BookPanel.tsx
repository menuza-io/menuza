import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type WaitlistEntry } from '@repo/reservations'
import { Icon, type IconName } from '@repo/ui/icon'
import { ScrollArea } from '@repo/ui/scroll-area'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import {
	coversHere,
	latePrompt,
	standWait,
	type EarlyArrival,
} from './arrival.ts'
import { coversOf, partyStatus, stripeOf, type BookList } from './book.ts'
import { isLargeParty } from './combine.ts'
import {
	hasNotes,
	isVip,
	OCCASION_LABEL,
	shortName,
	type DayReservation,
} from './feed.ts'
import { depositState, showsAllergyMark } from './guest.ts'
import { coversText, formatCount } from './labels.ts'
import {
	applyFilters,
	filterCounts,
	groupByHour,
	LIST_FILTERS,
	nextDue,
	readFilters,
	writeFilters,
	type HourPressure,
	type ListFilter,
} from './listView.ts'
import { highlightRanges } from './lookup.ts'
import { placingKey, reservationPlacing, type Placing } from './placing.ts'
import { stayOf } from './stay.ts'
import { minutesFormatter } from './timeline.ts'
import {
	COMPACT_WAITLIST_OVER,
	isNoResponse,
	joinedOnline,
	minutesWaited,
	QUOTE_SIZES,
	textedState,
	toldHow,
	waitlistSummary,
} from './waitlist.ts'
import { shortDuration } from '~/lib/duration.ts'
import { SoftText } from '~/ui/motion.tsx'
import {
	Input,
	Button,
	Chip,
	cn,
	IconButton,
	Reveal,
} from '~/ui/primitives.tsx'

/** From this many bookings still to seat the list is a dense day's: filters, hour headers, "Now". */
export const DENSE_FROM = 20

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
	earlyOf,
	onPick,
	onDetails,
	onWaitlistDetails,
	onAddWaitlist,
	onBookFor,
	onWaitlistFor,
	onClose,
	writesBlocked = null,
	tags,
	pressure,
	onlyIds = null,
	onClearOnly,
	quotes,
	onQuoteJoin,
	columns = false,
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
	/** How early a party at the stand is, and when a table is free for them (null: on time, or not there). */
	earlyOf: (reservation: DayReservation) => EarlyArrival | null
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
	/** Why picking a party up to seat is not possible now (offline): said on the rows, and they do nothing. */
	writesBlocked?: string | null
	/** The tag a booking carries for a minute after it changed ("New" or "Changed"). */
	tags?: ReadonlyMap<string, 'new' | 'changed'>
	/** The hours with a slot near its cap, for the hour headers' cover totals. */
	pressure?: ReadonlyMap<number, HourPressure>
	/** Only these bookings (what the last update changed): the host tapped the toast. */
	onlyIds?: ReadonlySet<string> | null
	onClearOnly?: () => void
	/** What each party size would be quoted on the waitlist now (minutes; null when there is no estimate). */
	quotes?: ReadonlyMap<number, number | null>
	/** A size on the quote strip was tapped: add a party that size to the waitlist. */
	onQuoteJoin?: (partySize: number) => void
	/** The whole book side by side (the List view of a wide screen), not one column beside the floor. */
	columns?: boolean
}) {
	const { _, i18n } = useLingui()
	const locale = i18n.locale
	const count = (n: number) => formatCount(n, locale)
	const scroller = useRef<HTMLDivElement>(null)
	const formatHour = useMemo(() => minutesFormatter(locale), [locale])
	const [filters, setFilters] = useState<ReadonlySet<ListFilter>>(readFilters)
	const toggleFilter = (filter: ListFilter) => {
		const next = new Set(filters)
		if (next.has(filter)) next.delete(filter)
		else next.add(filter)
		setFilters(next)
		writeFilters(next)
	}
	/** A long waitlist is one row until the host opens it. */
	const [waitlistAll, setWaitlistAll] = useState(false)
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
		list.waitlist.length +
		list.noResponse.length
	const nothing = found === 0
	// While searching, a section with no match steps aside instead of saying "nobody".
	const show = (n: number) => !searching || n > 0
	// A day with many bookings: filter chips, hour headers, and "Now".
	const dense = isToday && list.toSeat.length >= DENSE_FROM
	const counts = useMemo(
		() => filterCounts(list.toSeat, now),
		[list.toSeat, now],
	)
	const narrowed = onlyIds !== null || filters.size > 0
	const rows = useMemo(
		() =>
			onlyIds
				? list.toSeat.filter((r) => onlyIds.has(r.id))
				: applyFilters(list.toSeat, filters, now),
		[list.toSeat, onlyIds, filters, now],
	)
	const groups = useMemo(
		() => (dense || narrowed ? groupByHour(rows, pressure) : null),
		[dense, narrowed, rows, pressure],
	)
	const due = nextDue(rows, now)
	const goNow = () => {
		if (!due) return
		const row = [
			...(scroller.current?.querySelectorAll<HTMLElement>('[data-rid]') ?? []),
		].find((el) => el.dataset.rid === due.id)
		const reduced = window.matchMedia(
			'(prefers-reduced-motion: reduce)',
		).matches
		row?.scrollIntoView({
			block: 'start',
			behavior: reduced ? 'auto' : 'smooth',
		})
	}
	const summary = useMemo(
		() => waitlistSummary(list.waitlist, now),
		[list.waitlist, now],
	)
	const nextName = summary.next?.firstName || summary.next?.displayName || ''
	// A column of its own (the List view) has the room to show the whole line.
	const compactWaitlist =
		!columns &&
		!searching &&
		!waitlistAll &&
		list.waitlist.length > COMPACT_WAITLIST_OVER
	const filterLabel: Record<ListFilter, string> = {
		toSeat: _(msg`To seat`),
		late: _(msg`Late`),
		vip: _(msg`VIP`),
		large: _(msg`Large`),
		online: _(msg`Online`),
		noTable: _(msg`No table`),
	}

	const toSeatRow = (reservation: DayReservation, index: number) => (
		<ReservationRow
			key={reservation.id}
			reservation={reservation}
			index={index}
			now={now}
			query={typed}
			fresh={fresh.has(reservation.id)}
			tag={tags?.get(reservation.id) ?? null}
			canReadGuest={canReadGuest}
			formatTime={formatTime}
			mode="toSeat"
			early={earlyOf(reservation)}
			canPick={isToday}
			blocked={writesBlocked}
			selected={selected === `r:${reservation.id}`}
			onPick={() =>
				onPick(
					selected === `r:${reservation.id}`
						? null
						: reservationPlacing(reservation),
				)
			}
			onDetails={() => onDetails(reservation)}
		/>
	)

	const noMatchBlock = (
		<>
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
							<Icon
								name="calendar-plus"
								aria-hidden
								className="size-5 shrink-0"
							/>
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
								<Icon name="users" aria-hidden className="size-5 shrink-0" />
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
		</>
	)
	const waitlistBlock = (
		<>
			{waitlistOn &&
			isToday &&
			show(list.waitlist.length + list.noResponse.length) ? (
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
							<Icon name="users" className="size-5" />
							<span aria-hidden className="-ms-1 text-base leading-none">
								<Icon name="plus" className="size-3.5" />
							</span>
						</IconButton>
					}
				>
					{quotes && quotes.size > 0 && onQuoteJoin && !searching ? (
						<QuoteStrip
							quotes={quotes}
							blocked={writesBlocked}
							onJoin={onQuoteJoin}
						/>
					) : null}
					{list.waitlist.length === 0 ? (
						<Empty>
							<Trans>Nobody is waiting.</Trans>
						</Empty>
					) : compactWaitlist ? (
						<div className="bk-wl-summary border-border/70 flex flex-col flex-wrap items-stretch gap-1.5 border-b px-3 py-2">
							<div className="min-w-0 flex-1">
								<p
									className={cn(
										'tnum text-xs',
										summary.longestOver
											? 'text-warning font-semibold'
											: 'text-muted-foreground',
									)}
								>
									{_(
										plural(summary.longestMin, {
											one: 'Longest wait # min',
											other: 'Longest wait # min',
										}),
									)}
								</p>
							</div>
							<div className="flex min-w-0 flex-none flex-wrap items-center justify-between gap-1.5">
								{summary.next ? (
									<Button
										variant="outline"
										className={cn(
											'h-auto min-h-11 min-w-0 flex-1 px-3 py-1 text-sm',
											writesBlocked && 'cursor-not-allowed opacity-55',
										)}
										aria-disabled={writesBlocked ? true : undefined}
										title={writesBlocked ?? undefined}
										onClick={() => {
											if (writesBlocked || !summary.next) return
											onPick({ kind: 'waitlist', entry: summary.next })
										}}
									>
										<span className="min-w-0 text-center leading-tight">
											<Trans>
												Seat next: <bdi>{nextName}</bdi>
											</Trans>
										</span>
									</Button>
								) : null}
								<Button
									variant="ghost"
									aria-expanded={false}
									onClick={() => setWaitlistAll(true)}
									className="shrink-0"
								>
									<Trans>Show all</Trans>
									<Icon name="chevron-down" aria-hidden className="size-4" />
								</Button>
							</div>
						</div>
					) : (
						<>
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
										blocked={writesBlocked}
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
							{!columns &&
							list.waitlist.length > COMPACT_WAITLIST_OVER &&
							!searching ? (
								<button
									type="button"
									className="bk-wl-less flex min-h-11 w-full items-center justify-center text-sm font-semibold"
									onClick={() => setWaitlistAll(false)}
								>
									<Trans>Show less</Trans>
								</button>
							) : null}
						</>
					)}
					{list.noResponse.length > 0 ? (
						<>
							<p className="text-muted-foreground bg-muted/40 px-4 py-1.5 text-xs font-semibold">
								<Trans>Did not respond</Trans>
								{' · '}
								<Trans>tap to put back in line</Trans>
							</p>
							<ul>
								{list.noResponse.map((entry, index) => (
									<WaitlistRow
										key={entry.id}
										entry={entry}
										index={index}
										now={now}
										query={typed}
										formatTime={formatTime}
										textQueued={textedBy.get(entry.id)}
										selected={false}
										onPick={() => onWaitlistDetails(entry)}
										onDetails={() => onWaitlistDetails(entry)}
									/>
								))}
							</ul>
						</>
					) : null}
				</Section>
			) : null}
		</>
	)
	const toSeatBlock = (
		<>
			{show(list.toSeat.length) ? (
				<Section
					title={_(msg`Reservations`)}
					subtitle={
						isToday ? _(msg`still to seat, by time`) : _(msg`by scheduled time`)
					}
					count={list.toSeat.length}
					covers={coversOf(list.toSeat)}
					open={open('toSeat')}
					onToggle={() => toggle('toSeat')}
					sticky
					action={
						dense && due ? (
							<button
								type="button"
								className="bk-now me-1 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-(--radius-lg) px-2 text-xs font-semibold"
								onClick={goNow}
								title={_(msg`Go to the next party due`)}
							>
								<Icon name="locate-fixed" aria-hidden className="size-4" />
								<Trans>Now</Trans>
							</button>
						) : undefined
					}
				>
					{list.toSeat.length === 0 ? (
						<Empty>
							{isToday ? (
								<Trans>No more bookings today.</Trans>
							) : (
								<Trans>No bookings this day.</Trans>
							)}
						</Empty>
					) : rows.length === 0 ? (
						<Empty>
							<Trans>Nothing matches these filters.</Trans>
						</Empty>
					) : groups ? (
						<ul>
							{groups.map((group) => {
								const parties = group.parties
								const covers = group.covers
								const hot = group.pressure
								const at = formatHour(group.startMin)
								const peak = hot?.covers ?? 0
								const cap = hot?.cap ?? 0
								return (
									<li key={group.hour} className="bk-hour-group">
										<div
											className="bk-hour border-border/70 sticky z-1 flex items-center gap-1.5 border-b px-3 py-1 text-xs"
											role="presentation"
										>
											<span className="tnum font-semibold">{at}</span>
											<span aria-hidden>·</span>
											<span className="tnum">
												{_(
													plural(parties, {
														one: '# party',
														other: '# parties',
													}),
												)}
											</span>
											<span aria-hidden>·</span>
											<span
												className="bk-hour-covers tnum"
												data-level={hot?.level}
												title={
													hot
														? _(msg`Busiest slot: ${peak} of ${cap} covers`)
														: undefined
												}
											>
												{_(
													plural(covers, {
														one: '# cover',
														other: '# covers',
													}),
												)}
												{hot ? (
													<span className="sr-only">
														{' '}
														<Trans>
															{peak} of {cap} in the busiest slot
														</Trans>
													</span>
												) : null}
											</span>
										</div>
										<ul>
											{group.rows.map((reservation, index) =>
												toSeatRow(reservation, index),
											)}
										</ul>
									</li>
								)
							})}
						</ul>
					) : (
						<ul>
							{rows.map((reservation, index) => toSeatRow(reservation, index))}
						</ul>
					)}
				</Section>
			) : null}
		</>
	)
	const awaitingBlock = (
		<>
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
								tag={tags?.get(reservation.id) ?? null}
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
		</>
	)
	const seatedBlock = (
		<>
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
									tag={tags?.get(reservation.id) ?? null}
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
		</>
	)
	const missedBlock = (
		<>
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
								tag={tags?.get(reservation.id) ?? null}
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
		</>
	)
	const finishedBlock = (
		<>
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
								tag={tags?.get(reservation.id) ?? null}
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
		</>
	)

	return (
		<section
			aria-label={_(msg`Parties to seat`)}
			className="bk-panel bg-card flex min-h-0"
			data-single={single}
			data-columns={columns}
		>
			<div className="border-border flex shrink-0 items-center gap-2 border-b p-3">
				{onClose ? (
					<IconButton label={_(msg`Close the list`)} onClick={onClose}>
						<Icon name="x" className="size-5" />
					</IconButton>
				) : null}
				<label className="relative block min-w-0 flex-1">
					<span className="sr-only">
						<Trans>Search parties</Trans>
					</span>
					<Icon
						name="search"
						aria-hidden
						className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2"
					/>
					<Input
						type="search"
						value={query}
						onChange={(event) => onQuery(event.target.value)}
						placeholder={_(msg`Name, phone, table or code`)}
						autoComplete="off"
						enterKeyHint="search"
						className={cn(
							'ps-10 pe-11 [&::-webkit-search-cancel-button]:hidden',
						)}
					/>
					{query ? (
						<IconButton
							label={_(msg`Clear search`)}
							onClick={() => onQuery('')}
							className="absolute end-0.5 top-1/2 -translate-y-1/2"
						>
							<Icon name="x" className="size-4" />
						</IconButton>
					) : null}
				</label>
			</div>

			{/* What the search found, said where it can be seen (and to a screen reader). */}
			<p
				role="status"
				className={cn(
					'text-muted-foreground shrink-0 px-4 text-xs font-medium',
					searching ? 'border-border border-b pb-2' : 'sr-only',
				)}
			>
				{searching
					? nothing
						? _(msg`No one matches the search.`)
						: _(plural(found, { one: '# result', other: '# results' }))
					: ''}
			</p>
			{(dense || narrowed) && isToday && !searching ? (
				<div
					className="bk-filters border-border flex shrink-0 items-start gap-2 border-b px-3 py-2"
					role="group"
					aria-label={_(msg`Show only`)}
				>
					<div className="bk-filter-chips flex min-w-0 flex-1 flex-wrap gap-1.5">
						{LIST_FILTERS.map((filter) => {
							const on = filters.has(filter)
							const n = counts[filter]
							return (
								<Chip
									look="outlined"
									key={filter}
									selected={on && onlyIds === null}
									aria-pressed={on}
									disabled={n === 0 && !on}
									onClick={() => toggleFilter(filter)}
									className="h-11 gap-1.5 px-2.5 text-sm tabular-nums"
								>
									<span>{filterLabel[filter]}</span>
									<span className="bk-chip-n min-w-4.5 rounded-full px-1.25 text-center text-xs leading-4.5">
										{count(n)}
									</span>
								</Chip>
							)
						})}
						{onlyIds !== null ? (
							<Chip
								look="outlined"
								selected
								aria-pressed
								onClick={onClearOnly}
								className="h-11 gap-1.5 px-2.5 text-sm"
							>
								<span>
									<Trans>Just changed</Trans>
								</span>
								<Icon name="x" aria-hidden className="size-3.5" />
								<span className="sr-only">
									<Trans>Show everything again</Trans>
								</span>
							</Chip>
						) : null}
					</div>
				</div>
			) : null}

			{columns ? (
				// The book side by side (wide screens): the line, who is still to come, who is here.
				<div className="bk-columns flex min-h-0 flex-1">
					{waitlistOn && isToday ? (
						<ScrollArea className="min-h-0 flex-1 overflow-hidden">
							{waitlistBlock}
						</ScrollArea>
					) : null}
					<ScrollArea
						className="min-h-0 flex-1 overflow-hidden"
						viewportRef={scroller}
						viewportClassName="overscroll-contain"
					>
						{noMatchBlock}
						{toSeatBlock}
						{awaitingBlock}
						{missedBlock}
					</ScrollArea>
					<ScrollArea className="min-h-0 flex-1 overflow-hidden">
						{seatedBlock}
						{finishedBlock}
					</ScrollArea>
				</div>
			) : (
				<ScrollArea
					className="min-h-0 flex-1 overflow-hidden"
					viewportRef={scroller}
					viewportClassName="overscroll-contain"
				>
					{noMatchBlock}
					{waitlistBlock}
					{toSeatBlock}
					{awaitingBlock}
					{seatedBlock}
					{missedBlock}
					{finishedBlock}
				</ScrollArea>
			)}
		</section>
	)
}

/**
 * How long each party size would wait now, the answer a host gives most often
 * at the door. A tap starts adding a party that size to the waitlist.
 */
function QuoteStrip({
	quotes,
	blocked,
	onJoin,
}: {
	quotes: ReadonlyMap<number, number | null>
	blocked: string | null
	onJoin: (partySize: number) => void
}) {
	const { _ } = useLingui()
	return (
		<div className="bk-quotes border-border/70 border-b">
			<p className="bk-quotes-caption mb-1.5 text-xs">
				<Trans>Quoted wait by party size</Trans>
			</p>
			<div className="grid grid-cols-6 gap-1.5" role="group">
				{QUOTE_SIZES.map((size, index) => {
					const wait = quotes.get(size) ?? null
					const size_ =
						index === QUOTE_SIZES.length - 1 ? `${size}+` : String(size)
					const label =
						wait === null
							? _(msg`Add a party of ${size_} to the waitlist`)
							: _(
									msg`Add a party of ${size_} to the waitlist, about ${wait} min wait`,
								)
					return (
						<button
							key={size}
							type="button"
							className="bk-quote flex min-h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-(--station-control-radius)"
							aria-label={label}
							title={blocked ?? label}
							aria-disabled={blocked ? true : undefined}
							data-blocked={blocked ? true : undefined}
							onClick={blocked ? undefined : () => onJoin(size)}
						>
							<span
								className="tnum text-base leading-none font-semibold"
								dir="ltr"
							>
								{size_}
							</span>
							<span className="bk-quote-wait tnum text-xs leading-none">
								{wait === null
									? '–'
									: wait === 0
										? _(msg`Now`)
										: _(msg`${wait}m`)}
							</span>
						</button>
					)
				})}
			</div>
		</div>
	)
}

function Empty({ children }: { children: ReactNode }) {
	return (
		<p className="text-muted-foreground px-4 py-5 text-sm leading-relaxed">
			{children}
		</p>
	)
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
	sticky = false,
	children,
}: {
	title: string
	subtitle?: string
	count: number
	covers: number
	open: boolean
	onToggle: () => void
	action?: ReactNode
	/** Its rows carry headers that stick under this one. */
	sticky?: boolean
	children: ReactNode
}) {
	const { _ } = useLingui()
	return (
		<div className={sticky ? 'bk-sticky' : undefined}>
			<div className="bk-section-head border-border/70 sticky top-0 z-2 flex items-center gap-1 border-b">
				<button
					type="button"
					aria-expanded={open}
					onClick={onToggle}
					className="bk-section-toggle flex min-h-11 min-w-0 flex-1 items-center gap-2 py-2 ps-3 pe-1 text-start"
				>
					<span className="bk-chevron inline-flex shrink-0" aria-hidden>
						<Icon name="chevron-down" className="size-4" />
					</span>
					<span className="min-w-0">
						<span className="block truncate text-base leading-tight font-semibold">
							{title}
						</span>
						{subtitle ? (
							<span className="text-muted-foreground block truncate text-xs leading-tight">
								{subtitle}
							</span>
						) : null}
					</span>
					<span className="text-muted-foreground ms-auto flex shrink-0 items-center gap-2 text-sm">
						<span
							className="text-foreground tnum font-semibold"
							aria-label={_(
								plural(count, { one: '# party', other: '# parties' }),
							)}
						>
							{count}
						</span>
						<span
							className="tnum inline-flex items-center gap-1"
							aria-label={_(
								plural(covers, { one: '# cover', other: '# covers' }),
							)}
						>
							<Icon name="users" aria-hidden className="size-3.5" />
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
			<mark key={i} className="bk-hit bg-primary/20 text-inherit">
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
	icon,
	label,
	className,
}: {
	icon: IconName
	label: string
	className?: string
}) {
	return (
		<span className="inline-flex shrink-0" title={label}>
			<Icon name={icon} aria-hidden className={cn('size-3.5', className)} />
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
	tag = null,
	canReadGuest,
	formatTime,
	mode,
	early = null,
	canPick,
	blocked = null,
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
	/** Made or changed in the last minute: a small word beside the name. */
	tag?: 'new' | 'changed' | null
	canReadGuest: boolean
	formatTime: (epochMs: number) => string
	mode: 'toSeat' | 'awaiting' | 'seated' | 'missed' | 'finished'
	/** An arrival before their time, and what the floor can do for them. */
	early?: EarlyArrival | null
	canPick: boolean
	/** Why picking up the party is not possible now (offline): it does nothing, and says so. */
	blocked?: string | null
	selected: boolean
	onPick: () => void
	onDetails: () => void
}) {
	const { _, i18n } = useLingui()
	const status = partyStatus(r, now)
	const { late, said: runningLate } = status
	const who = shortName(r, _(msg`Guest`))
	const occasionLabel = r.occasion
		? OCCASION_LABEL[r.occasion]
			? _(OCCASION_LABEL[r.occasion]!)
			: r.occasion
		: ''
	const stay = mode === 'seated' ? stayOf(r, now) : null
	// Only four things colour the accent bar: due soon, late, at the stand, seated.
	const stripe =
		mode === 'seated' && stay?.over
			? 'late'
			: mode === 'missed' || mode === 'finished'
				? null
				: stripeOf(r, now)
	const pickBlocked = canPick && Boolean(blocked)
	// How long a party at the stand has waited, and how many of them are here.
	const wait = mode === 'toSeat' ? standWait(r, now) : null
	const partly = coversHere(r)
	const prompt = mode === 'toSeat' ? latePrompt(r, now) : null
	const large = isLargeParty(r.partySize)
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
				<SoftText value={shortDuration(seatedFor, i18n.locale)} />
				{' · '}
				{stay?.over ? _(msg`${overMin}m over`) : _(msg`~${leftMin}m left`)}
				{/* Only some of the party sit here yet: how many. */}
				{partly ? ` · ${coversText(_, partly)}` : ''}
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
			<span
				className={cn(
					'font-semibold',
					wait?.warn ? 'text-warning' : 'text-success',
				)}
			>
				{wait
					? _(
							plural(wait.minutes, {
								one: 'At the stand · # min',
								other: 'At the stand · # min',
							}),
						)
					: _(msg`At the stand`)}
				{partly ? ` · ${coversText(_, partly)}` : ''}
			</span>
		)
	else if (status.kind === 'late' && prompt)
		// Late enough to act on: a text, or (a till may, from fifteen minutes) a no-show.
		line = (
			<span
				className={cn(
					'text-warning whitespace-normal',
					prompt.urgent ? 'font-semibold' : 'font-medium',
				)}
			>
				{_(msg`${late} min late: text or mark no-show`)}
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
			className="bk-row border-border/70 relative flex min-h-15 items-stretch border-b"
			data-rid={r.id}
			data-stripe={stripe ?? undefined}
			data-tone={
				mode === 'missed' ? 'no_show' : stay?.over ? 'late' : status.kind
			}
			data-selected={selected}
			data-muted={mode === 'finished' || mode === 'missed'}
			style={{ '--bk-i': index } as React.CSSProperties}
		>
			<button
				type="button"
				className="bk-row-main grid min-w-0 flex-1 items-center gap-x-2.5 ps-3 pe-2 text-start"
				aria-pressed={canPick ? selected : undefined}
				aria-disabled={pickBlocked ? true : undefined}
				title={pickBlocked ? (blocked ?? undefined) : undefined}
				data-blocked={pickBlocked || undefined}
				onClick={pickBlocked ? undefined : onPick}
			>
				<span className="bk-stripe hidden" aria-hidden />
				<Stacked
					text={formatTime(clock)}
					className={mode === 'missed' ? 'line-through' : undefined}
				/>
				<span className="min-w-0 py-2.5">
					<span className="flex min-w-0 items-center gap-1.5">
						{fresh ? (
							<span
								className="bg-primary inline-block h-2 w-2 shrink-0 rounded-full"
								title={_(msg`New`)}
							>
								<span className="sr-only">
									<Trans>New</Trans>
								</span>
							</span>
						) : null}
						<bdi className="truncate font-semibold">
							<Highlight text={who} query={query} />
						</bdi>
						{tag ? (
							<span
								className="bk-tag shrink-0 rounded-full px-1.5 py-0 text-xs leading-4.25 font-semibold"
								data-tag={tag}
							>
								{tag === 'new' ? <Trans>New</Trans> : <Trans>Changed</Trans>}
							</span>
						) : null}
						<span className="text-muted-foreground ms-auto inline-flex shrink-0 items-center gap-1 text-sm">
							<Icon name="users" aria-hidden className="size-3.5" />
							<span className="tnum font-semibold">{r.partySize}</span>
							<span className="sr-only">
								<Trans>guests</Trans>
							</span>
						</span>
					</span>
					<span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm leading-snug">
						<span className="bk-subline text-muted-foreground min-w-0 basis-full overflow-hidden [overflow-wrap:anywhere]">
							{line}
						</span>
						{large && mode !== 'finished' && mode !== 'missed' ? (
							<span className="bk-large bg-primary/12 text-primary inline-flex shrink-0 items-center rounded-full px-1.75 py-0 font-semibold whitespace-nowrap">
								<Trans>Large party</Trans>
							</span>
						) : null}
						{showsAllergyMark(r, canReadGuest) ? (
							<Mark
								icon={'alert-triangle'}
								label={_(msg`Allergy noted`)}
								className="text-warning"
							/>
						) : null}
						{isVip(r) ? (
							<Mark
								icon={'crown'}
								label={_(msg`VIP`)}
								className="text-primary"
							/>
						) : null}
						{r.occasion ? (
							<Mark
								icon={'cake'}
								label={_(msg`Occasion: ${occasionLabel}`)}
								className="text-primary"
							/>
						) : null}
						{hasNotes(r) ? (
							<Mark
								icon={'sticky-note'}
								label={_(msg`Has notes`)}
								className="text-muted-foreground"
							/>
						) : null}
						{source && mode !== 'finished' && mode !== 'missed' ? (
							<Mark
								icon={source === 'online' ? 'globe' : 'smartphone'}
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
								icon={'badge-check'}
								label={_(msg`Deposit paid`)}
								className="text-success"
							/>
						) : null}
						{status.said > 0 && mode === 'toSeat' && status.kind !== 'here' ? (
							<Mark
								icon={'clock-3'}
								label={_(msg`Running late`)}
								className="text-warning"
							/>
						) : null}
					</span>
					{early ? (
						<span className="text-muted-foreground mt-0.5 block text-xs leading-tight">
							{early.table === null ? (
								<Trans>{early.earlyMin} min early</Trans>
							) : early.table.kind === 'free_now' ? (
								<Trans>
									{early.earlyMin} min early · table {early.table.label} free
									now
								</Trans>
							) : early.table.label ? (
								<Trans>
									{early.earlyMin} min early · table {early.table.label} free in{' '}
									{early.table.minutes} min
								</Trans>
							) : (
								<Trans>
									{early.earlyMin} min early · table free in{' '}
									{early.table.minutes} min
								</Trans>
							)}
						</span>
					) : null}
				</span>
				{mode === 'missed' ? (
					<Icon
						name="user-x"
						aria-hidden
						className="text-muted-foreground size-4"
					/>
				) : mode === 'awaiting' ? (
					// The row already says "Awaiting payment": the tag is a mark, so the words keep their room.
					<span
						className="bk-pay-tag text-warning inline-flex items-center gap-1 rounded-(--station-inset-radius) px-2 py-1 text-sm font-semibold"
						title={_(msg`Deposit`)}
					>
						<Icon name="credit-card" aria-hidden className="size-3.5" />
						<span className="sr-only">
							<Trans>Deposit</Trans>
						</span>
					</span>
				) : tables ? (
					// Seated: a solid chip. Assigned but not seated yet: an outline.
					<span
						className="bk-badge inline-flex justify-center"
						data-solid={mode === 'seated' || status.kind === 'seated'}
					>
						<span className="sr-only">
							<Trans>Table</Trans>{' '}
						</span>
						{tables}
					</span>
				) : mode === 'toSeat' && canPick ? (
					<span
						className="bk-seat inline-flex items-center justify-center"
						aria-hidden={false}
					>
						<Trans>Seat</Trans>
					</span>
				) : (
					<span />
				)}
			</button>
			<button
				type="button"
				className="bk-row-info flex w-11 shrink-0 items-center justify-center"
				onClick={onDetails}
				aria-label={_(msg`Details for ${who}`)}
			>
				<Icon name="info" aria-hidden className="size-4" />
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
	blocked = null,
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
	/** Why picking them up to seat is not possible now (offline). */
	blocked?: string | null
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
	const textSent = toldHow(entry, textQueued) === 'text_queued'
	const outOfLine = isNoResponse(entry)
	const online = joinedOnline(entry)
	const pickBlocked = !outOfLine && Boolean(blocked)
	return (
		<li
			className="bk-row border-border/70 relative flex min-h-15 items-stretch border-b"
			data-stripe={
				outOfLine
					? undefined
					: texted?.urgent || over
						? 'late'
						: entry.status === 'notified'
							? 'here'
							: undefined
			}
			data-tone={
				outOfLine
					? 'no_show'
					: texted?.urgent
						? 'late'
						: entry.status === 'notified'
							? 'here'
							: over
								? 'late'
								: 'booked'
			}
			data-muted={outOfLine}
			data-selected={selected}
			style={{ '--bk-i': index } as React.CSSProperties}
		>
			<button
				type="button"
				className="bk-row-main grid min-w-0 flex-1 items-center gap-x-2.5 ps-3 pe-2 text-start"
				aria-pressed={outOfLine ? undefined : selected}
				aria-disabled={pickBlocked ? true : undefined}
				title={pickBlocked ? (blocked ?? undefined) : undefined}
				data-blocked={pickBlocked || undefined}
				onClick={pickBlocked ? undefined : onPick}
			>
				<span className="bk-stripe hidden" aria-hidden />
				<Stacked
					text={_(plural(waited, { one: '# min', other: '# min' }))}
					className={over ? 'text-warning' : undefined}
				/>
				<span className="min-w-0 py-2.5">
					<span className="flex min-w-0 items-center gap-1.5">
						<bdi className="truncate font-semibold">
							<Highlight text={name} query={query} />
						</bdi>
						<span className="text-muted-foreground ms-auto inline-flex shrink-0 items-center gap-1 text-sm">
							<Icon name="users" aria-hidden className="size-3.5" />
							<span className="tnum font-semibold">{entry.partySize}</span>
							<span className="sr-only">
								<Trans>guests</Trans>
							</span>
						</span>
					</span>
					<span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm leading-snug">
						<span
							className={cn(
								'text-muted-foreground min-w-0 basis-full',
								texted?.urgent && 'text-warning font-semibold',
							)}
						>
							{outOfLine ? (
								<Trans>Did not respond</Trans>
							) : texted ? (
								texted.expired ? (
									<Trans>Told, no response</Trans>
								) : texted.minutesLeft !== null ? (
									_(
										textSent
											? plural(heldFor, {
													one: 'Text on its way, holds # min',
													other: 'Text on its way, holds # min',
												})
											: plural(heldFor, {
													one: 'Told, holds # min',
													other: 'Told, holds # min',
												}),
									)
								) : textSent ? (
									<Trans>Told {textedAt}, text on its way</Trans>
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
						{online ? (
							<Mark
								icon={'smartphone'}
								label={_(msg`Joined online`)}
								className="text-primary"
							/>
						) : null}
						{entry.status === 'notified' ? (
							<Mark
								icon={'bell-ring'}
								label={_(msg`Told their table is ready`)}
								className={texted?.urgent ? 'text-warning' : 'text-success'}
							/>
						) : null}
						{entry.notes ? (
							<Mark
								icon={'sticky-note'}
								label={_(msg`Has notes`)}
								className="text-muted-foreground"
							/>
						) : null}
					</span>
				</span>
				{outOfLine ? (
					<Icon
						name="undo-2"
						aria-hidden
						className="text-muted-foreground size-4"
					/>
				) : (
					<span
						className="bk-seat inline-flex items-center justify-center"
						aria-hidden={false}
					>
						<Trans>Seat</Trans>
					</span>
				)}
			</button>
			<button
				type="button"
				className="bk-row-info flex w-11 shrink-0 items-center justify-center"
				onClick={onDetails}
				aria-label={_(msg`Details for ${name}`)}
			>
				<Icon name="info" aria-hidden className="size-4" />
			</button>
		</li>
	)
}
