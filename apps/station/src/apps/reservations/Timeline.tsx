import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon, type IconName } from '@repo/ui/icon'
import {
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react'
import { partyStatus } from './book.ts'
import { isLargeParty } from './combine.ts'
import {
	fitVerdict,
	isOnFloor,
	hasNotes,
	isVip,
	shortName,
	tableState,
	type DayFeed,
	type DayReservation,
	type DayTable,
	type PartyToPlace,
	type TableState,
} from './feed.ts'
import { showsAllergyMark } from './guest.ts'
import { formatCount, statusText } from './labels.ts'
import { stayOf } from './stay.ts'
import {
	capLanes,
	layoutTimeline,
	minuteAt,
	minutesFormatter,
	minutesShortFormatter,
	NO_TABLE_LANES,
	nowOffset,
	SLOT_MIN,
	slotTotals,
	timelineRange,
	trackOffset,
	wallMinutes,
	type TimelineBar,
	type TimelineRow,
} from './timeline.ts'
import { Button } from '~/ui/primitives.tsx'

const TONE_ICON: Record<string, IconName | null> = {
	seated: 'armchair',
	here: 'footprints',
	late: 'clock-3',
	running: 'clock-3',
	confirmed: 'circle-check',
	awaiting: 'credit-card',
	finished: 'circle-check',
	booked: null,
	no_show: null,
}

const HINT_KEY = 'station.hostStand.timelineHintSeen'

/** Whether this device has been told how the grid works already (it is said once). */
function hintSeen() {
	try {
		return localStorage.getItem(HINT_KEY) === '1'
	} catch {
		return false
	}
}

/** Why a tap on the grid started nothing. */
export type TimelineRefusal = 'past' | 'closed' | 'readOnly'

/**
 * The book as a grid, the way a reservation book reads: tables down the side
 * grouped by room (with how many each seats), time across the top in
 * quarter-hours, a booking as a bar from its start to its end, taped-off tables
 * hatched, a line for now, and along the bottom what each slot holds against
 * what it can take. A tap on a bar opens the party; a tap on an empty stretch
 * starts a booking for that table and time. The grid scrolls sideways inside
 * its frame; the list beside it holds the same bookings for anyone who would
 * rather not use the grid.
 */
export function Timeline({
	feed,
	now,
	isToday,
	bookable,
	serviceId,
	matchIds,
	picking,
	active,
	canReadGuest,
	formatTime,
	formatShort,
	summary,
	onBar,
	onTable,
	onEmpty,
	onRefused,
	onPlace,
	noTables,
}: {
	feed: DayFeed
	now: number
	isToday: boolean
	/** New bookings can start here: today or a day to come. */
	bookable: boolean
	serviceId: string | null
	/** A search is on: the bookings it finds stand out, the rest step back. */
	matchIds: Set<string> | null
	/** The party being placed, if any (tables that take it light up). */
	picking: PartyToPlace | null
	/** The pane is on screen (it opens at "now" when it first is). */
	active: boolean
	/** Whether guest details are readable: the allergy mark needs more than the server's flag then. */
	canReadGuest: boolean
	formatTime: (epochMs: number) => string
	/** The same without "AM" or "PM": for a bar, where there is no room for it. */
	formatShort: (epochMs: number) => string
	/** The day's figures, for the toolbar when the header has no room for them. */
	summary?: ReactNode
	onBar: (reservation: DayReservation) => void
	/** A table's name tapped: seat the picked-up party, or look at the table. */
	onTable: (table: DayTable, state: TableState) => void
	/** An empty stretch tapped: a booking for this table (null: no table) at this time. */
	onEmpty: (table: DayTable | null, startMin: number) => void
	/** A tap that starts nothing (a past stretch, a closed day): say why. */
	onRefused: (why: TimelineRefusal) => void
	/**
	 * A booking in the "No table" strip tapped: straight into choosing a table
	 * for it (without this, a tap opens the booking like any other bar).
	 */
	onPlace?: (reservation: DayReservation) => void
	/** What to say when the location has no tables (names the location). */
	noTables?: ReactNode
}) {
	const { _, i18n } = useLingui()
	/** The "No table" strip shows all its lines instead of the first few. */
	const [noneOpen, setNoneOpen] = useState(false)
	const scroller = useRef<HTMLDivElement>(null)
	// How the grid works is said once per device, then never again.
	const [showHint] = useState(() => !hintSeen())
	useLayoutEffect(() => {
		if (!showHint || !active) return
		try {
			localStorage.setItem(HINT_KEY, '1')
		} catch {
			/* said again next time */
		}
	}, [showHint, active])
	const range = useMemo(() => timelineRange(feed, serviceId), [feed, serviceId])
	const groups = useMemo(
		() =>
			layoutTimeline(feed, range, {
				serviceId,
				now: isToday ? now : null,
			}),
		[feed, range, serviceId, isToday, now],
	)
	const totals = useMemo(
		() => slotTotals(feed, range, serviceId),
		[feed, range, serviceId],
	)
	// What each table is doing, once per look and tick (not on each keystroke of a search).
	const states = useMemo(
		() =>
			new Map(
				feed.tables.map(
					(table) => [table.id, tableState(table, feed, now)] as const,
				),
			),
		[feed, now],
	)
	const fmt = useMemo(() => minutesFormatter(i18n.locale), [i18n.locale])
	/** "1:30" without "PM": the tick under a cell, where there is no room for the rest. */
	const fmtShort = useMemo(
		() => minutesShortFormatter(i18n.locale),
		[i18n.locale],
	)
	const slots = (range.endMin - range.startMin) / SLOT_MIN
	const hours = Math.ceil((range.endMin - range.startMin) / 60)
	const nowMin = isToday ? nowOffset(now, feed, range) : null
	// Wall-clock minutes from the day's midnight, like the bars (not minutes elapsed).
	const absoluteNow = wallMinutes(now, feed)
	const count = totals.parties
	const totalCovers = totals.covers
	const partiesText = _(plural(count, { one: '# party', other: '# parties' }))
	const coversText = _(
		plural(totalCovers, { one: '# cover', other: '# covers' }),
	)

	/** Moves the grid so the time `fromMin` (minutes into the range) is at its left edge. */
	const scrollToMinute = useCallback(
		(fromMin: number, smooth: boolean) => {
			const el = scroller.current
			const track = el?.querySelector<HTMLElement>('.tl-track')
			if (!el || !track) return
			const slotPx = track.getBoundingClientRect().width / slots
			const rtl = getComputedStyle(el).direction === 'rtl'
			const px = Math.max(0, (fromMin / SLOT_MIN) * slotPx)
			const reduced = window.matchMedia(
				'(prefers-reduced-motion: reduce)',
			).matches
			el.scrollTo({
				left: rtl ? -px : px,
				behavior: smooth && !reduced ? 'smooth' : 'auto',
			})
		},
		[slots],
	)
	/** Today opens half an hour before now; another day at its first booking's hour. */
	const scrollToNow = useCallback(
		(smooth: boolean) =>
			scrollToMinute(nowMin !== null ? nowMin - 30 : 0, smooth),
		[scrollToMinute, nowMin],
	)
	/** Back two hours: the parties that have come and gone. */
	const scrollEarlier = () => {
		const el = scroller.current
		const track = el?.querySelector<HTMLElement>('.tl-track')
		if (!el || !track) return
		const slotPx = track.getBoundingClientRect().width / slots
		const rtl = getComputedStyle(el).direction === 'rtl'
		const at = (rtl ? -el.scrollLeft : el.scrollLeft) / slotPx
		scrollToMinute(Math.max(0, at * SLOT_MIN - 120), true)
	}
	// Opens at now; again when the day, the service or the pane changes. Not on every tick.
	const opened = useRef<string | null>(null)
	useLayoutEffect(() => {
		if (!active) return
		const key = `${feed.businessDate}|${serviceId}|${range.startMin}|${isToday}`
		if (opened.current === key) return
		opened.current = key
		scrollToNow(false)
	}, [
		active,
		feed.businessDate,
		serviceId,
		range.startMin,
		isToday,
		scrollToNow,
	])

	/** Whether a booking may start at this minute here; says why not when it may not. */
	const mayBook = (minute: number) => {
		if (!bookable) {
			onRefused('readOnly')
			return false
		}
		if (feed.dayState !== 'open') {
			onRefused('closed')
			return false
		}
		// A stretch that has already gone by cannot be booked.
		if (isToday && minute + SLOT_MIN <= absoluteNow) {
			onRefused('past')
			return false
		}
		return true
	}
	const tapEmpty =
		(table: DayTable | null) => (event: React.MouseEvent<HTMLDivElement>) => {
			if (event.target !== event.currentTarget) return
			const rect = event.currentTarget.getBoundingClientRect()
			const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
			const offset = trackOffset(rect, event.clientX, rtl)
			const minute = minuteAt(offset, rect.width / slots, range)
			if (mayBook(minute)) onEmpty(table, minute)
		}
	/** The keyboard's way to book a table: the next free slot from now (or the day's first). */
	const bookKey = (table: DayTable | null) => {
		const first = isToday
			? Math.max(range.startMin, Math.ceil(absoluteNow / SLOT_MIN) * SLOT_MIN)
			: range.startMin
		const minute = Math.min(first, range.endMin - SLOT_MIN)
		if (mayBook(minute)) onEmpty(table, minute)
	}

	return (
		<div className="tl">
			<div className="border-border bg-card flex min-w-0 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2">
				{summary ? (
					<div className="bk-toolbar-stats min-w-0 xl:hidden">{summary}</div>
				) : null}
				{showHint ? (
					<p className="text-muted-foreground text-sm" role="note">
						{bookable ? (
							<Trans>
								Tap a booking for details, or an empty stretch to book it.
							</Trans>
						) : (
							<Trans>Tap a booking for details.</Trans>
						)}
					</p>
				) : null}
				<ul
					aria-label={_(msg`Booking colours`)}
					className="bk-legend min-w-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto text-xs font-semibold whitespace-nowrap"
				>
					<li>
						<span className="bk-swatch h-3 w-4.5" data-kind="booked" />
						<Trans>Booked</Trans>
					</li>
					<li>
						<span className="bk-swatch h-3 w-4.5" data-kind="here" />
						<Trans>Here</Trans>
					</li>
					<li>
						<span className="bk-swatch h-3 w-4.5" data-kind="seated" />
						<Trans>Seated</Trans>
					</li>
					<li>
						<span className="bk-swatch h-3 w-4.5" data-kind="late" />
						<Trans>Late or over time</Trans>
					</li>
					<li>
						<span
							className="text-primary inline-flex w-4.5 justify-center"
							aria-hidden
						>
							<Icon name="users-round" className="size-3" />
						</span>
						<Trans>Large party</Trans>
					</li>
				</ul>
				<div className="ms-auto flex items-center gap-2">
					<Button variant="outline" onClick={scrollEarlier}>
						<Icon name="history" className="size-4" />
						<Trans>Earlier</Trans>
					</Button>
					{nowMin !== null ? (
						<Button variant="outline" onClick={() => scrollToNow(true)}>
							<Icon name="locate-fixed" className="size-4" />
							<Trans>Now</Trans>
						</Button>
					) : null}
				</div>
			</div>
			<div
				ref={scroller}
				className="tl-scroll relative min-h-0 flex-1 overflow-auto overscroll-contain"
				role="region"
				aria-label={_(msg`Timeline`)}
				aria-describedby="tl-keys"
				tabIndex={0}
				// Bars keep their words in view by the scrolled-away part (see book.css).
				onScroll={(event) =>
					event.currentTarget.style.setProperty(
						'--tl-scroll',
						`${Math.abs(event.currentTarget.scrollLeft)}px`,
					)
				}
			>
				<p id="tl-keys" className="sr-only">
					<Trans>
						Each booking is a button. Each table row has a Book this table
						button. The list beside the grid holds the same bookings.
					</Trans>
				</p>
				<div
					className="tl-grid relative min-h-full"
					style={{ '--tl-slots': slots } as React.CSSProperties}
				>
					<div className="tl-head border-border bg-card sticky top-0 z-6 flex border-b">
						<div className="tl-corner border-border bg-card sticky start-0 z-7 flex shrink-0 items-center border-e px-3 text-xs font-semibold">
							<Trans>Table</Trans>
						</div>
						<div className="tl-hours relative shrink-0" aria-hidden>
							{Array.from({ length: hours }, (_unused, index) => (
								<span
									key={index}
									className="tl-hour border-border absolute inset-y-0 flex items-start border-s ps-2 pt-1.25 whitespace-nowrap"
									data-now={
										nowMin !== null &&
										absoluteNow >= range.startMin + index * 60 &&
										absoluteNow < range.startMin + (index + 1) * 60
									}
									style={{ '--h': index } as React.CSSProperties}
								>
									{fmt(range.startMin + index * 60)}
								</span>
							))}
							{/* What time it is, flagged where the line starts. */}
							{nowMin !== null ? (
								<span
									className="tl-now-flag bg-destructive tnum pointer-events-none absolute bottom-0.75 z-3 px-1.25 text-xs leading-4 font-semibold whitespace-nowrap"
									dir="ltr"
									style={{ '--now': nowMin } as React.CSSProperties}
								>
									{fmtShort(absoluteNow)}
								</span>
							) : null}
						</div>
					</div>

					{nowMin !== null ? (
						<>
							<div
								aria-hidden
								className="tl-past bg-muted/60 pointer-events-none absolute z-1"
								style={{ '--now': nowMin } as React.CSSProperties}
							/>
							<div
								aria-hidden
								className="tl-now pointer-events-none z-1 ms-0"
								style={{ '--now': nowMin } as React.CSSProperties}
							/>
						</>
					) : null}

					{groups.length === 0 ||
					(groups.length === 1 && groups[0]!.key === 'none') ? (
						<p className="text-muted-foreground p-6 text-sm">
							{noTables ?? <Trans>No tables yet.</Trans>}
						</p>
					) : null}

					{groups.map((group) => (
						<div
							key={group.key}
							// The "No table" lines stay under the time header while the grid scrolls (opened, they scroll away).
							className={group.area ? undefined : 'tl-none bg-card z-6'}
							data-open={group.area ? undefined : noneOpen}
						>
							{group.area ? (
								<div className="bg-muted border-border relative flex h-8 items-center border-b">
									<span className="tl-group-label sticky start-0 z-3 px-3 text-xs font-semibold uppercase">
										{group.area.name}
									</span>
								</div>
							) : null}
							{group.rows.map((row) => {
								// The "No table" row shows its first lines, and what is behind them to be opened.
								const capped = row.table
									? null
									: capLanes(row, noneOpen ? Infinity : NO_TABLE_LANES)
								const shown = capped
									? { ...row, bars: capped.bars, lanes: capped.lanes }
									: row
								return (
									<Row
										key={row.key}
										row={shown}
										range={range}
										feed={feed}
										now={now}
										state={
											row.table ? (states.get(row.table.id) ?? null) : null
										}
										bookable={bookable}
										matchIds={matchIds}
										picking={picking}
										canReadGuest={canReadGuest}
										formatTime={formatTime}
										formatShort={formatShort}
										onBar={row.table || !onPlace ? onBar : onPlace}
										onTable={onTable}
										tapEmpty={tapEmpty}
										onBook={bookKey}
										toPlace={
											row.table
												? undefined
												: {
														hidden: capped?.hidden ?? 0,
														hiddenText: formatCount(
															capped?.hidden ?? 0,
															i18n.locale,
														),
														open: noneOpen && row.lanes > NO_TABLE_LANES,
														canPlace: Boolean(onPlace),
														onToggle: () => setNoneOpen((open) => !open),
													}
										}
									/>
								)
							})}
						</div>
					))}

					<div className="border-border bg-card sticky bottom-0 z-6 flex h-12 border-t">
						<div
							className="tl-foot-label border-border bg-card sticky start-0 z-7 flex shrink-0 flex-col justify-center overflow-hidden border-e ps-2 pe-1 whitespace-nowrap"
							title={`${partiesText} · ${coversText}`}
						>
							<span className="font-semibold">
								{totals.kind === 'slots' ? (
									<Trans>Covers / cap</Trans>
								) : (
									<Trans>Covers per hour</Trans>
								)}
							</span>
							<span className="text-muted-foreground">{coversText}</span>
						</div>
						<div
							className="tl-cells relative flex shrink-0"
							role="group"
							aria-label={_(msg`Covers by time`)}
						>
							{totals.cells.map((cell, index) => {
								const covers = cell.covers
								const cap = cell.cap
								const at = fmt(cell.startMin)
								const ratio = cap === null ? 0 : covers / Math.max(cap, 1)
								// The cap is said where it starts and where it changes, not in every cell.
								const sayCap =
									cap !== null &&
									(index === 0 || cap !== totals.cells[index - 1]?.cap)
								const current =
									nowMin !== null &&
									absoluteNow >= cell.startMin &&
									absoluteNow < cell.startMin + cell.spanMin
								return (
									<span
										key={cell.startMin}
										className="tl-cell relative flex shrink-0 items-start justify-center overflow-hidden pt-1.25 tabular-nums"
										style={
											{
												'--span': cell.spanMin,
												'--fill': Math.min(1, ratio),
											} as React.CSSProperties
										}
										data-zero={covers === 0}
										data-level={
											cap === null
												? undefined
												: ratio >= 1
													? 'full'
													: ratio >= 0.8
														? 'high'
														: undefined
										}
										data-hour={cell.startMin % 60 === 0}
										data-now={current}
										data-tick={cell.startMin % 30 === 0}
										title={
											cap !== null
												? _(msg`${at}: ${covers} of ${cap} covers`)
												: `${at}: ${_(plural(covers, { one: '# cover', other: '# covers' }))}`
										}
									>
										<span
											dir="ltr"
											className="inline-flex items-baseline gap-px"
										>
											<span className="tl-cell-n">{covers}</span>
											{sayCap ? (
												<span className="tl-cell-cap text-xs">/{cap}</span>
											) : null}
										</span>
										{/* The time under the cell at each :00 and :30, so a number is never guessed at. */}
										{cell.startMin % 30 === 0 ? (
											<span
												aria-hidden
												className="tl-cell-tick pointer-events-none absolute start-1 bottom-1 text-xs leading-none font-medium"
												dir="ltr"
											>
												{fmtShort(cell.startMin)}
											</span>
										) : null}
										{cap !== null ? (
											<span className="tl-cell-fill absolute inset-x-0 bottom-0 h-0.75" />
										) : null}
									</span>
								)
							})}
						</div>
					</div>
				</div>
			</div>
		</div>
	)
}

function Row({
	row,
	range,
	feed,
	now,
	state: knownState,
	bookable,
	matchIds,
	picking,
	canReadGuest,
	formatTime,
	formatShort,
	onBar,
	onTable,
	tapEmpty,
	onBook,
	toPlace,
}: {
	row: TimelineRow
	range: { startMin: number; endMin: number }
	feed: DayFeed
	now: number
	/** The table's state, worked out once for every row (null for the "No table" row). */
	state: TableState | null
	bookable: boolean
	matchIds: Set<string> | null
	picking: PartyToPlace | null
	canReadGuest: boolean
	formatTime: (epochMs: number) => string
	formatShort: (epochMs: number) => string
	onBar: (reservation: DayReservation) => void
	onTable: (table: DayTable, state: TableState) => void
	tapEmpty: (
		table: DayTable | null,
	) => (event: React.MouseEvent<HTMLDivElement>) => void
	onBook: (table: DayTable | null) => void
	/** The "No table" row: how many wait to be placed, how many are hidden, and the button that opens them. */
	toPlace?: {
		hidden: number
		hiddenText: string
		open: boolean
		canPlace: boolean
		onToggle: () => void
	}
}) {
	const { _ } = useLingui()
	const hiddenText = toPlace?.hiddenText ?? ''
	const table = row.table
	const state = table ? (knownState ?? tableState(table, feed, now)) : null
	const verdict =
		picking && table && state
			? fitVerdict(table, state, picking, now, feed)
			: null
	const fits = verdict ? verdict.fits : null
	const covers = table?.maxCovers ?? 0
	const label = table?.label ?? ''
	return (
		<div
			className="tl-row border-border/70 relative flex border-b"
			style={{ '--lanes': row.lanes } as React.CSSProperties}
		>
			{table && state ? (
				<button
					type="button"
					className="tl-label border-border sticky start-0 z-5 flex shrink-0 justify-between gap-1 border-e ps-3 pe-2 text-start"
					data-fits={fits === null ? undefined : String(fits)}
					onClick={() => onTable(table, state)}
					aria-label={
						fits === null
							? _(msg`Table ${table.label}, seats ${covers}`)
							: fits
								? _(
										msg`Table ${table.label}, seats ${covers}. Takes this party.`,
									)
								: _(
										msg`Table ${table.label}, seats ${covers}. Not a fit for this party.`,
									)
					}
				>
					<span className="mono max-w-[3.25rem] truncate text-base font-semibold">
						{table.label}
					</span>
					<span
						aria-hidden
						className="text-muted-foreground inline-flex items-center gap-0.5 text-xs font-semibold"
					>
						<Icon name="users" className="size-3" />
						<span className="tnum">{covers}</span>
					</span>
				</button>
			) : (
				<div className="tl-label border-border tl-label-none sticky start-0 z-5 flex shrink-0 justify-between gap-1 border-e py-1.5 ps-3 pe-2 text-start">
					<span className="flex min-w-0 flex-col items-start gap-0.5">
						<span className="text-sm leading-tight font-semibold">
							<Trans>No table</Trans>
						</span>
						{toPlace && toPlace.hidden > 0 ? (
							<button
								type="button"
								className="tl-more text-primary min-h-0 text-start font-semibold"
								aria-expanded={false}
								onClick={toPlace.onToggle}
							>
								<Trans>+{hiddenText} to place</Trans>
							</button>
						) : toPlace?.open ? (
							<button
								type="button"
								className="tl-more text-primary min-h-0 text-start font-semibold"
								aria-expanded
								onClick={toPlace.onToggle}
							>
								<Trans>Show fewer</Trans>
							</button>
						) : null}
					</span>
				</div>
			)}
			<div
				className="tl-track relative shrink-0"
				role="presentation"
				data-tappable={bookable}
				onClick={tapEmpty(table)}
			>
				{/* The keyboard's way to book this table: out of sight until it has focus. */}
				{table ? (
					<button
						type="button"
						className="tl-book-key"
						onClick={() => onBook(table)}
					>
						<Icon name="plus" aria-hidden className="size-4" />
						<Trans>Book table {label}</Trans>
					</button>
				) : null}
				{row.blocks.map((block) => (
					<div
						key={block.id}
						className="tl-block pointer-events-none absolute inset-y-0.5 z-1 flex items-center overflow-hidden rounded-(--station-inset-radius) px-2 text-xs font-medium"
						style={
							{
								'--from': block.startMin - range.startMin,
								'--span': block.endMin - block.startMin,
							} as React.CSSProperties
						}
					>
						{block.reason ?? _(msg`Blocked`)}
					</div>
				))}
				{row.bars.map((bar) => (
					<BarButton
						key={`${bar.reservation.id}:${row.key}`}
						bar={bar}
						range={range}
						now={now}
						tableLabel={table?.label ?? null}
						canReadGuest={canReadGuest}
						formatShort={formatShort}
						formatTime={formatTime}
						dim={matchIds !== null && !matchIds.has(bar.reservation.id)}
						match={matchIds !== null && matchIds.has(bar.reservation.id)}
						onClick={() => onBar(bar.reservation)}
					/>
				))}
			</div>
		</div>
	)
}

function BarButton({
	bar,
	range,
	now,
	tableLabel,
	canReadGuest,
	formatTime,
	formatShort,
	dim,
	match,
	onClick,
}: {
	bar: TimelineBar
	range: { startMin: number; endMin: number }
	now: number
	/** The table this row is (null: the "No table" row). */
	tableLabel: string | null
	canReadGuest: boolean
	formatTime: (epochMs: number) => string
	formatShort: (epochMs: number) => string
	dim: boolean
	match: boolean
	onClick: () => void
}) {
	const { _ } = useLingui()
	const r = bar.reservation
	const status = partyStatus(r, now)
	const who = shortName(r, _(msg`Guest`))
	const icon = TONE_ICON[status.kind]
	const size = r.partySize
	const standing = statusText(_, status)
	const time = formatTime(r.startAt)
	// A stay that began before the grid starts has no start to show: how long they have sat.
	const elapsed =
		bar.clippedStart && isOnFloor(r) && typeof r.seatedAt === 'number'
			? Math.max(0, Math.floor((now - r.seatedAt) / 60_000))
			: null
	// A seated party: how long until the table clears, or how far over (a bar can say it).
	const stay = isOnFloor(r) ? stayOf(r, now) : null
	const leftMin = stay?.leftMin ?? 0
	const overMin = stay?.overMin ?? 0
	const stayText = stay
		? stay.over
			? _(msg`${overMin}m over`)
			: _(msg`~${leftMin}m left`)
		: null
	// Late, or sitting past the booked end: the end of the bar is hatched in amber.
	const hatched = bar.overrun || status.kind === 'late' || stay?.over === true
	const where = tableLabel
		? _(msg`table ${tableLabel}`)
		: bar.tableRemoved
			? _(msg`table removed`)
			: _(msg`no table`)
	return (
		<button
			type="button"
			className="tl-bar block overflow-hidden text-start text-sm"
			data-tone={status.kind}
			data-overrun={bar.overrun}
			data-hatch={hatched || undefined}
			data-clip-start={bar.clippedStart || undefined}
			data-dim={dim}
			data-match={match}
			onClick={onClick}
			aria-label={
				isLargeParty(size)
					? _(
							msg`${time}, ${who}, large party of ${size}, ${standing}, ${where}`,
						)
					: _(msg`${time}, ${who}, party of ${size}, ${standing}, ${where}`)
			}
			style={
				{
					'--from': bar.startMin - range.startMin,
					'--span': bar.endMin - bar.startMin,
					'--lane': bar.lane,
				} as React.CSSProperties
			}
		>
			<span className="tl-bar-in @container flex h-full w-full items-center gap-1.5 overflow-hidden">
				{/* Begun before the visible edge: a chevron says the bar goes on to the left (see book.css). */}
				<span
					className="tl-clip pointer-events-none absolute inset-y-0 z-2 flex items-center overflow-hidden opacity-80"
					aria-hidden
				/>
				{icon ? (
					<span className="tl-extra inline-flex shrink-0" aria-hidden>
						<Icon name={icon} className="size-4" />
					</span>
				) : null}
				{/* "7:45 · Elena V.": the start time leads, so a row reads as a schedule. */}
				<span
					aria-hidden
					className="tl-bar-time tnum min-w-0 overflow-hidden text-sm font-semibold whitespace-nowrap"
				>
					{elapsed !== null ? _(msg`${elapsed}m`) : formatShort(r.startAt)}
				</span>
				<bdi className="min-w-0 truncate font-semibold">{who}</bdi>
				{bar.tableRemoved ? (
					<span className="bg-warning/16 text-warning shrink-0 rounded-(--station-inset-radius) px-1 text-xs font-semibold whitespace-nowrap">
						<Trans>Table removed</Trans>
					</span>
				) : null}
				{isVip(r) ? (
					<span
						className="tl-extra tl-ico-primary inline-flex shrink-0"
						aria-hidden
					>
						<Icon name="crown" className="size-3.5" />
					</span>
				) : null}
				{showsAllergyMark(r, canReadGuest) ? (
					<span className="tl-ico-warn inline-flex shrink-0" aria-hidden>
						<Icon name="alert-triangle" className="size-3.5" />
					</span>
				) : null}
				{r.occasion ? (
					<span
						className="tl-extra tl-ico-primary inline-flex shrink-0"
						aria-hidden
					>
						<Icon name="cake" className="size-3.5" />
					</span>
				) : null}
				{hasNotes(r) ? (
					<span
						className="tl-extra tl-ico-muted inline-flex shrink-0"
						aria-hidden
					>
						<Icon name="sticky-note" className="size-3.5" />
					</span>
				) : null}
				{isLargeParty(size) ? (
					<span
						className="tl-large inline-flex shrink-0 items-center"
						title={_(msg`Large party`)}
					>
						<span className="sr-only">
							<Trans>Large party</Trans>
						</span>
						<Icon name="users-round" aria-hidden className="size-3" />
					</span>
				) : null}
				{stayText ? (
					<span
						aria-hidden
						className="tl-bar-left tnum ms-auto min-w-0 overflow-hidden whitespace-nowrap"
						data-over={stay?.over}
					>
						{stayText}
					</span>
				) : null}
				<span
					aria-hidden
					className="tl-bar-size tnum inline-flex shrink-0 items-center gap-0.5 rounded-(--station-inset-radius) px-1 text-xs font-semibold"
				>
					<Icon name="users" className="size-3" />
					{size}
				</span>
			</span>
		</button>
	)
}
