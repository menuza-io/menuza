import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	Armchair,
	Cake,
	CircleCheck,
	Clock3,
	Crown,
	Footprints,
	LocateFixed,
	StickyNote,
	TriangleAlert,
	Users,
} from 'lucide-react'
import {
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	type ComponentType,
} from 'react'
import { partyStatus } from './book.ts'
import {
	hasNotes,
	isVip,
	shortName,
	takesParty,
	tableState,
	type DayFeed,
	type DayReservation,
	type DayTable,
	type TableState,
} from './feed.ts'
import { statusText } from './labels.ts'
import {
	dayOrigin,
	layoutTimeline,
	minuteAt,
	minutesFormatter,
	nowOffset,
	SLOT_MIN,
	slotTotals,
	timelineRange,
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
		finished: CircleCheck,
		booked: null,
		no_show: null,
	}

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
	formatTime,
	onBar,
	onTable,
	onEmpty,
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
	picking: {
		partySize: number
		durationMin: number
		reservationId?: string
	} | null
	/** The pane is on screen (it opens at "now" when it first is). */
	active: boolean
	formatTime: (epochMs: number) => string
	onBar: (reservation: DayReservation) => void
	/** A table's name tapped: seat the picked-up party, or look at the table. */
	onTable: (table: DayTable, state: TableState) => void
	/** An empty stretch tapped: a booking for this table (null: no table) at this time. */
	onEmpty: (table: DayTable | null, startMin: number) => void
}) {
	const { _, i18n } = useLingui()
	const scroller = useRef<HTMLDivElement>(null)
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
	const slots = (range.endMin - range.startMin) / SLOT_MIN
	const hours = Math.ceil((range.endMin - range.startMin) / 60)
	const nowMin = isToday ? nowOffset(now, feed, range) : null
	const absoluteNow = (now - dayOrigin(feed)) / 60_000
	const count = totals.parties
	const totalCovers = totals.covers

	/** Brings "now" (or the first booking's hour on another day) into view. */
	const scrollToNow = useCallback(
		(smooth: boolean) => {
			const el = scroller.current
			const track = el?.querySelector<HTMLElement>('.tl-track')
			if (!el || !track) return
			const slotPx = track.getBoundingClientRect().width / slots
			const rtl = getComputedStyle(el).direction === 'rtl'
			const label =
				el.querySelector<HTMLElement>('.tl-corner')?.offsetWidth ?? 0
			const from = nowMin !== null ? (nowMin / SLOT_MIN) * slotPx : 0
			// Now sits about a quarter of the way in, with an hour of the past before it.
			const px = Math.max(
				0,
				nowMin !== null ? from - (el.clientWidth - label) * 0.25 : 0,
			)
			const reduced = window.matchMedia(
				'(prefers-reduced-motion: reduce)',
			).matches
			el.scrollTo({
				left: rtl ? -px : px,
				behavior: smooth && !reduced ? 'smooth' : 'auto',
			})
		},
		[slots, nowMin],
	)
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

	const tapEmpty =
		(table: DayTable | null) => (event: React.MouseEvent<HTMLDivElement>) => {
			if (!bookable || event.target !== event.currentTarget) return
			const rect = event.currentTarget.getBoundingClientRect()
			const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
			const offset = rtl
				? rect.right - event.clientX
				: event.clientX - rect.left
			const minute = minuteAt(offset, rect.width / slots, range)
			// A stretch that has already gone by cannot be booked.
			if (isToday && minute + SLOT_MIN <= absoluteNow) return
			onEmpty(table, minute)
		}

	return (
		<div className="tl">
			<div className="border-border bg-card flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-2">
				<p className="text-muted-foreground text-xs">
					{bookable ? (
						<Trans>
							Tap a booking for details, or an empty stretch to book it.
						</Trans>
					) : (
						<Trans>Tap a booking for details.</Trans>
					)}
				</p>
				{nowMin !== null ? (
					<Button
						className="ms-auto"
						variant="outline"
						onClick={() => scrollToNow(true)}
					>
						<LocateFixed className="size-4" />
						<Trans>Now</Trans>
					</Button>
				) : null}
			</div>
			<div
				ref={scroller}
				className="tl-scroll"
				role="region"
				aria-label={_(msg`Timeline`)}
				tabIndex={0}
			>
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
									formatTime={formatTime}
									onBar={onBar}
									onTable={onTable}
									tapEmpty={tapEmpty}
								/>
							))}
						</div>
					))}

					<div className="tl-foot">
						<div className="tl-foot-label">
							<span className="font-semibold">
								<Trans>{count} parties</Trans>
							</span>
							<span className="text-muted-foreground">
								<Trans>{totalCovers} covers</Trans>
							</span>
						</div>
						<div
							className="tl-cells"
							role="group"
							aria-label={_(msg`Covers by time`)}
						>
							{totals.cells.map((cell) => {
								const covers = cell.covers
								const cap = cell.cap
								const at = fmt(cell.startMin)
								return (
									<span
										key={cell.startMin}
										className="tl-cell"
										style={
											{
												'--span': cell.spanMin,
												'--fill':
													cap === null
														? 0
														: Math.min(1, covers / Math.max(cap, 1)),
											} as React.CSSProperties
										}
										data-zero={covers === 0}
										data-full={cap !== null && covers >= cap}
										title={
											cap !== null
												? _(msg`${at}: ${covers} of ${cap} covers`)
												: _(msg`${at}: ${covers} covers`)
										}
									>
										<span dir="ltr" className="flex flex-col items-center">
											<span className="font-semibold">{covers}</span>
											{cap !== null ? (
												<span className="tl-cell-cap">/{cap}</span>
											) : null}
										</span>
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
	formatTime,
	onBar,
	onTable,
	tapEmpty,
}: {
	row: TimelineRow
	range: { startMin: number; endMin: number }
	feed: DayFeed
	now: number
	bookable: boolean
	matchIds: Set<string> | null
	picking: {
		partySize: number
		durationMin: number
		reservationId?: string
	} | null
	formatTime: (epochMs: number) => string
	onBar: (reservation: DayReservation) => void
	onTable: (table: DayTable, state: TableState) => void
	tapEmpty: (
		table: DayTable | null,
	) => (event: React.MouseEvent<HTMLDivElement>) => void
}) {
	const { _ } = useLingui()
	const table = row.table
	const state = table ? tableState(table, feed, now) : null
	const fits =
		picking && table && state ? takesParty(table, state, picking, now) : null
	const covers = table?.maxCovers ?? 0
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
	formatTime,
	dim,
	match,
	onClick,
}: {
	bar: TimelineBar
	range: { startMin: number; endMin: number }
	now: number
	formatTime: (epochMs: number) => string
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
	return (
		<button
			type="button"
			className="tl-bar"
			data-tone={status.kind}
			data-overrun={bar.overrun}
			data-dim={dim}
			data-match={match}
			onClick={onClick}
			aria-label={_(msg`${time}, ${who}, party of ${size}, ${standing}`)}
			style={
				{
					'--from': bar.startMin - range.startMin,
					'--span': bar.endMin - bar.startMin,
					'--lane': bar.lane,
				} as React.CSSProperties
			}
		>
			<span className="tl-bar-in">
				{Icon ? <Icon aria-hidden className="size-4 shrink-0" /> : null}
				<bdi className="min-w-0 truncate font-semibold">{who}</bdi>
				{isVip(r) ? (
					<Crown aria-hidden className="text-primary size-3.5 shrink-0" />
				) : null}
				{r.hasAllergy ? (
					<TriangleAlert
						aria-hidden
						className="text-warning size-3.5 shrink-0"
					/>
				) : null}
				{r.occasion ? (
					<Cake aria-hidden className="text-primary size-3.5 shrink-0" />
				) : null}
				{hasNotes(r) ? (
					<StickyNote
						aria-hidden
						className="text-muted-foreground size-3.5 shrink-0"
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
