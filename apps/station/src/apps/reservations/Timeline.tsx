import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	Armchair,
	Cake,
	CircleCheck,
	Clock3,
	CreditCard,
	Crown,
	Footprints,
	History,
	LocateFixed,
	Plus,
	StickyNote,
	TriangleAlert,
	Users,
} from 'lucide-react'
import {
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ComponentType,
	type ReactNode,
} from 'react'
import { partyStatus } from './book.ts'
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
import { statusText } from './labels.ts'
import {
	layoutTimeline,
	minuteAt,
	minutesFormatter,
	minutesShortFormatter,
	nowOffset,
	SLOT_MIN,
	slotTotals,
	timelineRange,
	wallMinutes,
	type TimelineBar,
	type TimelineRow,
} from './timeline.ts'
import { Button } from '~/ui/primitives.tsx'

const TONE_ICON: Record<string, ComponentType<{ className?: string }> | null> =
	{
		seated: Armchair,
		here: Footprints,
		late: Clock3,
		running: Clock3,
		confirmed: CircleCheck,
		awaiting: CreditCard,
		finished: CircleCheck,
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
}) {
	const { _, i18n } = useLingui()
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
			const offset = rtl
				? rect.right - event.clientX
				: event.clientX - rect.left
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
			<div className="bk-toolbar">
				{summary ? (
					<div className="bk-toolbar-stats xl:hidden">{summary}</div>
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
				<div className="ms-auto flex items-center gap-2">
					<Button variant="outline" onClick={scrollEarlier}>
						<History className="size-4" />
						<Trans>Earlier</Trans>
					</Button>
					{nowMin !== null ? (
						<Button variant="outline" onClick={() => scrollToNow(true)}>
							<LocateFixed className="size-4" />
							<Trans>Now</Trans>
						</Button>
					) : null}
				</div>
			</div>
			<div
				ref={scroller}
				className="tl-scroll"
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
					className="tl-grid"
					style={{ '--tl-slots': slots } as React.CSSProperties}
				>
					<div className="tl-head">
						<div className="tl-corner">
							<Trans>Table</Trans>
						</div>
						<div className="tl-hours" aria-hidden>
							{Array.from({ length: hours }, (_unused, index) => (
								<span
									key={index}
									className="tl-hour"
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
						</div>
					</div>

					{nowMin !== null ? (
						<>
							<div
								aria-hidden
								className="tl-past"
								style={{ '--now': nowMin } as React.CSSProperties}
							/>
							<div
								aria-hidden
								className="tl-now"
								style={{ '--now': nowMin } as React.CSSProperties}
							/>
						</>
					) : null}

					{groups.length === 0 ? (
						<p className="text-muted-foreground p-6 text-sm">
							<Trans>No tables yet.</Trans>
						</p>
					) : null}

					{groups.map((group) => (
						<div key={group.key}>
							{group.area ? (
								<div className="tl-group">
									<span className="tl-group-label">{group.area.name}</span>
								</div>
							) : null}
							{group.rows.map((row) => (
								<Row
									key={row.key}
									row={row}
									range={range}
									feed={feed}
									now={now}
									bookable={bookable}
									matchIds={matchIds}
									picking={picking}
									canReadGuest={canReadGuest}
									formatTime={formatTime}
									formatShort={formatShort}
									onBar={onBar}
									onTable={onTable}
									tapEmpty={tapEmpty}
									onBook={bookKey}
								/>
							))}
						</div>
					))}

					<div className="tl-foot">
						<div
							className="tl-foot-label"
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
							className="tl-cells"
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
										className="tl-cell"
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
										<span dir="ltr" className="tl-cell-text">
											<span className="tl-cell-n">{covers}</span>
											{sayCap ? (
												<span className="tl-cell-cap">/{cap}</span>
											) : null}
										</span>
										{/* The time under the cell at each :00 and :30, so a number is never guessed at. */}
										{cell.startMin % 30 === 0 ? (
											<span aria-hidden className="tl-cell-tick" dir="ltr">
												{fmtShort(cell.startMin)}
											</span>
										) : null}
										{cap !== null ? <span className="tl-cell-fill" /> : null}
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
}: {
	row: TimelineRow
	range: { startMin: number; endMin: number }
	feed: DayFeed
	now: number
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
}) {
	const { _ } = useLingui()
	const table = row.table
	const state = table ? tableState(table, feed, now) : null
	const verdict =
		picking && table && state ? fitVerdict(table, state, picking, now) : null
	const fits = verdict ? verdict.fits : null
	const covers = table?.maxCovers ?? 0
	const label = table?.label ?? ''
	return (
		<div
			className="tl-row"
			style={{ '--lanes': row.lanes } as React.CSSProperties}
		>
			{table && state ? (
				<button
					type="button"
					className="tl-label"
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
					<span className="mono max-w-[3.25rem] truncate text-base font-bold">
						{table.label}
					</span>
					<span
						aria-hidden
						className="text-muted-foreground inline-flex items-center gap-0.5 text-xs font-semibold"
					>
						<Users className="size-3" />
						<span className="tnum">{covers}</span>
					</span>
				</button>
			) : (
				<div className="tl-label">
					<span className="text-sm font-bold">
						<Trans>No table</Trans>
					</span>
				</div>
			)}
			<div
				className="tl-track"
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
						<Plus aria-hidden className="size-4" />
						<Trans>Book table {label}</Trans>
					</button>
				) : null}
				{row.blocks.map((block) => (
					<div
						key={block.id}
						className="tl-block"
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
	const Icon = TONE_ICON[status.kind]
	const size = r.partySize
	const standing = statusText(_, status)
	const time = formatTime(r.startAt)
	// A stay that began before the grid starts has no start to show: how long they have sat.
	const elapsed =
		bar.clippedStart && isOnFloor(r) && typeof r.seatedAt === 'number'
			? Math.max(0, Math.floor((now - r.seatedAt) / 60_000))
			: null
	const where = tableLabel
		? _(msg`table ${tableLabel}`)
		: bar.tableRemoved
			? _(msg`table removed`)
			: _(msg`no table`)
	return (
		<button
			type="button"
			className="tl-bar"
			data-tone={status.kind}
			data-overrun={bar.overrun}
			data-dim={dim}
			data-match={match}
			onClick={onClick}
			aria-label={_(
				msg`${time}, ${who}, party of ${size}, ${standing}, ${where}`,
			)}
			style={
				{
					'--from': bar.startMin - range.startMin,
					'--span': bar.endMin - bar.startMin,
					'--lane': bar.lane,
				} as React.CSSProperties
			}
		>
			<span className="tl-bar-in">
				{Icon ? (
					<Icon aria-hidden className="tl-extra size-4 shrink-0" />
				) : null}
				{/* "7:45 · Elena V.": the start time leads, so a row reads as a schedule. */}
				<span aria-hidden className="tl-bar-time tnum">
					{elapsed !== null ? _(msg`${elapsed}m`) : formatShort(r.startAt)}
				</span>
				<bdi className="min-w-0 truncate font-semibold">{who}</bdi>
				{bar.tableRemoved ? (
					<span className="tl-bar-note">
						<Trans>Table removed</Trans>
					</span>
				) : null}
				{isVip(r) ? (
					<Crown
						aria-hidden
						className="tl-extra text-primary size-3.5 shrink-0"
					/>
				) : null}
				{showsAllergyMark(r, canReadGuest) ? (
					<TriangleAlert
						aria-hidden
						className="text-warning size-3.5 shrink-0"
					/>
				) : null}
				{r.occasion ? (
					<Cake
						aria-hidden
						className="tl-extra text-primary size-3.5 shrink-0"
					/>
				) : null}
				{hasNotes(r) ? (
					<StickyNote
						aria-hidden
						className="tl-extra text-muted-foreground size-3.5 shrink-0"
					/>
				) : null}
				<span aria-hidden className="tl-bar-size tnum">
					<Users className="size-3" />
					{size}
				</span>
			</span>
		</button>
	)
}
