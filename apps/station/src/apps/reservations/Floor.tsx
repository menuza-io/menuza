import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { coversHere } from './arrival.ts'
import { type JoinVerdict } from './combine.ts'
import {
	bestFit,
	fitVerdict,
	freeUntil,
	isDrawn,
	isFreeKind,
	placeTables,
	shortName,
	tableState,
	type DayArea,
	type DayElement,
	type DayFeed,
	type DayTable,
	type FitVerdict,
	type PartyToPlace,
	type TableState,
} from './feed.ts'
import { fitRoom, type PlacedPx } from './floorfit.ts'
import { tileSignals, type TileSignal } from './guest.ts'
import { coversText, formatCount } from './labels.ts'
import { initialsOf, type FloorSection } from './sections.ts'
import { stayOf } from './stay.ts'
import { SoftText } from '~/ui/motion.tsx'
import { cn } from '~/ui/primitives.tsx'

/** Room kept under the plan for the names that hang below its last row of tables. */
const CAPTION_ROOM_PX = 30

/** An element's size, kept current (zero before it is measured). */
function useSize(ref: React.RefObject<HTMLElement | null>) {
	const [size, setSize] = useState({ w: 0, h: 0 })
	useLayoutEffect(() => {
		const el = ref.current
		if (!el) return
		const measure = () =>
			setSize((previous) =>
				previous.w === el.clientWidth && previous.h === el.clientHeight
					? previous
					: { w: el.clientWidth, h: el.clientHeight },
			)
		measure()
		if (typeof ResizeObserver === 'undefined') return
		const observer = new ResizeObserver(measure)
		observer.observe(el)
		return () => observer.disconnect()
	}, [ref])
	return size
}

/**
 * One room of the floor, as the manager drew it (or as a tidy grid when nobody
 * has yet). The plan is scaled to fill the pane, with every table at least a
 * fingertip wide; only a room too big for that pans. Each table shows its
 * state at a glance: open (and until when, if it is booked soon), a party due
 * within half an hour, seated (and for how long), or blocked. While the host
 * is placing a party, tables that seat it lift, the best one says so, and the
 * rest step back with the reason under them.
 */
export function Floor({
	area,
	feed,
	now,
	picking,
	join = null,
	canReadGuest = false,
	sections = null,
	rank,
	onTable,
	formatTime,
	formatShort,
}: {
	area: DayArea
	feed: DayFeed
	now: number
	/** The party being placed, if any: how many, for how long, and its own booking. */
	picking: PartyToPlace | null
	/**
	 * Joining tables for the party in hand: how each table reads (chosen, free
	 * beside the group, or why not). Without it, each table is judged alone.
	 */
	join?: ((table: DayTable, state: TableState) => JoinVerdict) | null
	/** Whether guest details are readable: an allergy mark needs more than the server's flag then. */
	canReadGuest?: boolean
	/** Server sections, by table: drawn on the tables while the host shows them. */
	sections?: ReadonlyMap<string, FloorSection> | null
	/** The rotation: among tables of the same size, the lower rank is suggested first. */
	rank?: (tableId: string) => number
	onTable: (table: DayTable, state: TableState) => void
	formatTime: (epochMs: number) => string
	/** The same without "AM" or "PM": for a table, where there is no room for it. */
	formatShort: (epochMs: number) => string
}) {
	const roomTables = useMemo(
		() => feed.tables.filter((table) => table.areaId === area.id),
		[area.id, feed.tables],
	)
	const live = useMemo(
		() => roomTables.filter((table) => !table.archivedAt),
		[roomTables],
	)
	const placed = useMemo(
		() => placeTables(area, roomTables),
		[area, roomTables],
	)
	const elements = useMemo(
		() =>
			feed.elements.filter(
				(element) => !element.areaId || element.areaId === area.id,
			),
		[feed.elements, area.id],
	)
	// A drawn room is fitted to the pane; an undrawn one is a grid that fills it.
	const drawn = isDrawn(roomTables)
	const frame = useRef<HTMLDivElement>(null)
	const size = useSize(frame)
	const fit = useMemo(
		() =>
			drawn
				? fitRoom({
						tables: live.map((t) => ({
							id: t.id,
							x: t.x,
							y: t.y,
							w: t.w,
							h: t.h,
							rotation: t.rotation,
						})),
						extras: elements.map((e) => ({
							x: e.x,
							y: e.y,
							w: e.w,
							h: e.h,
							rotation: e.rotation,
						})),
						frame: { w: size.w, h: Math.max(0, size.h - CAPTION_ROOM_PX) },
					})
				: null,
		[drawn, live, elements, size.w, size.h],
	)
	const states = useMemo(
		() =>
			new Map(
				live.map((table) => [table.id, tableState(table, feed, now)] as const),
			),
		[live, feed, now],
	)
	const best = useMemo(
		() =>
			picking && !join
				? bestFit(
						live.map((table) => ({ table, state: states.get(table.id)! })),
						picking,
						now,
						feed,
						rank,
					)
				: null,
		[picking, join, live, states, now, feed, rank],
	)

	return (
		<div
			className="floor floor-room relative min-h-0 flex-1 overflow-hidden"
			data-picking={picking ? 'true' : 'false'}
		>
			{fit?.scrolls ? (
				// Only where the room cannot fit at a usable size: it pans.
				<p
					className="text-muted-foreground pointer-events-none absolute inset-x-0 top-1.5 z-2 text-center text-sm font-medium"
					aria-hidden
				>
					<Trans>Swipe to see the whole room</Trans>
				</p>
			) : null}
			{/* The plan is fitted to whatever space the pane has. */}
			<div
				ref={frame}
				className="floor-frame bk-floor-frame absolute inset-3 sm:inset-5"
				data-scroll={fit?.scrolls ?? false}
			>
				<div
					className={cn(
						'bk-plan relative m-auto shrink-0',
						!drawn && 'h-full w-full',
					)}
					data-grid={!drawn}
					style={
						{
							'--plan-w':
								fit && fit.tables.size > 0 ? `${fit.width}px` : undefined,
							'--plan-h':
								fit && fit.tables.size > 0
									? `${fit.height + CAPTION_ROOM_PX}px`
									: undefined,
						} as React.CSSProperties
					}
				>
					{fit
						? elements.map((element, index) => (
								<FloorElement
									key={element.id}
									element={element}
									box={fit.extras[index]}
								/>
							))
						: null}
					{(drawn
						? live.flatMap((table) => {
								const px = fit?.tables.get(table.id)
								return px ? [{ table, px, percent: null }] : []
							})
						: placed.map(({ table, left, top, width, height }) => ({
								table,
								px: null,
								percent: { left, top, width, height },
							}))
					).map(({ table, px, percent }) => {
						const state = states.get(table.id) ?? tableState(table, feed, now)
						const joined = join ? join(table, state) : null
						const verdict = joined
							? joinedAsVerdict(joined)
							: picking
								? fitVerdict(table, state, picking, now, feed)
								: null
						return (
							<TableButton
								key={table.id}
								table={table}
								state={state}
								now={now}
								verdict={verdict}
								chosen={joined?.kind === 'selected'}
								best={best === table.id}
								section={sections?.get(table.id) ?? null}
								canReadGuest={canReadGuest}
								onClick={() => onTable(table, state)}
								formatTime={formatTime}
								formatShort={formatShort}
								box={
									px
										? pxBox(px)
										: {
												l: `${percent!.left * 100}%`,
												t: `${percent!.top * 100}%`,
												w: `${percent!.width * 100}%`,
												h: `${percent!.height * 100}%`,
											}
								}
							/>
						)
					})}
				</div>
			</div>
		</div>
	)
}

const SIGNAL_ICON = {
	allergy: 'alert-triangle',
	vip: 'crown',
	occasion: 'cake',
	deposit: 'badge-check',
} as const

/** What a table says about the party in hand: a fit verdict, or (joining tables) that it is far or the group is full. */
type TableVerdict = FitVerdict | { fits: false; why: 'far' | 'full' }

/** The join verdict as the floor words a table's reason. */
function joinedAsVerdict(joined: JoinVerdict): TableVerdict {
	switch (joined.kind) {
		case 'selected':
		case 'addable':
			return { fits: true }
		case 'far':
			return { fits: false, why: 'far' }
		case 'full':
			return { fits: false, why: 'full' }
		default:
			return joined.verdict
	}
}

/** Where a box sits on the plan: CSS lengths (the `.bk-box` rule places it from them). */
type Box = { l: string; t: string; w: string; h: string }

const pxBox = (px: PlacedPx): Box => ({
	l: `${px.left}px`,
	t: `${px.top}px`,
	w: `${px.width}px`,
	h: `${px.height}px`,
})

function FloorElement({
	element,
	box,
}: {
	element: DayElement
	box: PlacedPx | undefined
}) {
	if (!box) return null
	const at = pxBox(box)
	return (
		<div
			aria-hidden
			style={
				{
					'--l': at.l,
					'--t': at.t,
					'--w': at.w,
					'--h': at.h,
					'--turn': element.rotation ? `${element.rotation}deg` : undefined,
				} as React.CSSProperties
			}
			className={cn(
				'bk-box floor-turn pointer-events-none flex items-center justify-center overflow-hidden text-xs font-medium',
				element.kind === 'wall' && 'bg-foreground/25 rounded-sm',
				element.kind === 'bar' &&
					'bg-foreground/8 text-muted-foreground border-foreground/15 rounded-lg border',
				element.kind === 'zone' &&
					'border-foreground/15 text-muted-foreground rounded-2xl border-2 border-dashed',
				(element.kind === 'door' || element.kind === 'window') &&
					'bg-background/80 rounded-sm',
				element.kind === 'plant' && 'bg-success/20 rounded-full',
				element.kind === 'label' && 'text-muted-foreground',
			)}
		>
			{element.label && element.kind !== 'wall' ? element.label : null}
		</div>
	)
}

function TableButton({
	table,
	state,
	now,
	verdict,
	chosen,
	best,
	section,
	canReadGuest,
	onClick,
	formatTime,
	formatShort,
	box,
}: {
	table: DayTable
	state: TableState
	now: number
	/** While a party is being placed: whether this table takes them, and if not why. */
	verdict: TableVerdict | null
	/** Joining tables: this one is already in the group. */
	chosen: boolean
	/** The one table to suggest for the party in hand. */
	best: boolean
	/** Its server section, while the floor shows them. */
	section: FloorSection | null
	canReadGuest: boolean
	onClick: () => void
	formatTime: (epochMs: number) => string
	formatShort: (epochMs: number) => string
	box: Box
}) {
	const { _, i18n } = useLingui()
	const arabic = i18n.locale.startsWith('ar')
	const count = (n: number) => formatCount(n, i18n.locale)
	const round = table.shape === 'round' || table.shape === 'oval'
	const covers =
		table.minCovers > 0 && table.minCovers < table.maxCovers
			? `${table.minCovers}–${table.maxCovers}`
			: String(table.maxCovers)
	// How long they have sat, and how long until the table is expected to clear.
	const sitting = state.kind === 'seated' ? stayOf(state.party, now) : null
	const partly = state.kind === 'seated' ? coversHere(state.party) : null
	const seatedFor = sitting?.seatedMin ?? null
	const leftMin = sitting?.leftMin ?? 0
	const overMin = sitting?.overMin ?? 0
	// What the booking on the table (the party seated, or the one due soon) has to flag.
	const signals: TileSignal[] =
		state.kind === 'seated'
			? tileSignals(state.party, canReadGuest)
			: state.kind === 'soon'
				? tileSignals(state.next, canReadGuest)
				: []
	// How far through the booked stay they are: a thin bar that turns amber past the end.
	const stay = sitting ? sitting.ratio : null
	// A table being cleared after a party left: minutes until it is ready again.
	const resetLeft =
		state.kind === 'resetting'
			? Math.max(1, Math.ceil((state.readyAt - now) / 60_000))
			: 0
	const resetLeftText = count(resetLeft)
	const leftText = count(leftMin)
	const overText = count(overMin)
	// An open table that is booked later says until when it is free.
	const until = freeUntil(state, now)
	const untilFull = until ? formatTime(until.until) : ''
	const untilShort = until ? formatShort(until.until) : ''
	const fits = verdict ? verdict.fits : null
	/**
	 * Why a table does not take the party in hand, for under the table and for
	 * a screen reader; `short` is what a phone has room for (a time, a word).
	 */
	let reason: string | null = null
	let reasonShort: React.ReactNode = null
	if (verdict && !verdict.fits) {
		if (verdict.why === 'booked') {
			const at = formatTime(verdict.at)
			reason = _(msg`Booked ${at}`)
			reasonShort = (
				<span className="inline-flex items-center gap-0.5">
					<Icon name="clock-3" aria-hidden className="size-3" />
					{formatShort(verdict.at)}
				</span>
			)
		} else if (verdict.why === 'blocked') {
			const at = formatTime(verdict.at)
			reason = _(msg`Blocked ${at}`)
			reasonShort = (
				<span className="inline-flex items-center gap-0.5">
					<Icon name="ban" aria-hidden className="size-3" />
					{formatShort(verdict.at)}
				</span>
			)
		} else if (verdict.why === 'far') {
			reason = _(msg`Not next to it`)
			reasonShort = _(msg`Far`)
		} else if (verdict.why === 'full') {
			reason = _(msg`Group is full`)
			reasonShort = _(msg`Full`)
		} else if (verdict.why === 'small') {
			reason = _(msg`Too small`)
			reasonShort = _(msg`Small`)
		} else if (verdict.why === 'resetting') {
			// While a party is in hand the reason is said under the tile (it explains why it steps back).
			reason = _(msg`Resetting ${resetLeft}m`)
			reasonShort = (
				<span className="inline-flex items-center gap-0.5">
					<Icon name="refresh-cw" aria-hidden className="size-3" />
					{_(msg`${resetLeftText}m`)}
				</span>
			)
		} else {
			reason = _(msg`Taken`)
			reasonShort = null
		}
	}
	/** Who is there (or due), or why the party in hand does not fit, under the table. */
	// A resetting tile says its minutes inside; under it only a reason (a party in hand) is said, never the minutes twice.
	const caption =
		state.kind === 'resetting' && reason === null
			? null
			: (reason ??
				(chosen ? _(msg`Chosen`) : null) ??
				(state.kind === 'seated'
					? shortName(state.party, _(msg`Guest`))
					: state.kind === 'soon'
						? shortName(state.next, _(msg`Guest`))
						: null))

	let label: string
	switch (state.kind) {
		case 'seated':
			label = sitting?.over
				? _(
						msg`Table ${table.label}, seated: ${shortName(state.party, _(msg`Guest`))}, party of ${state.party.partySize}, ${overMin} min over`,
					)
				: _(
						msg`Table ${table.label}, seated: ${shortName(state.party, _(msg`Guest`))}, party of ${state.party.partySize}, about ${leftMin} min left`,
					)
			break
		case 'soon':
			label = _(
				msg`Table ${table.label}, booked at ${formatTime(state.next.startAt)}, seats ${covers}`,
			)
			break
		case 'blocked':
			label = _(msg`Table ${table.label}, blocked`)
			break
		case 'resetting':
			label = _(
				msg`Table ${table.label}, being reset, ready in ${resetLeft} min`,
			)
			break
		default:
			label = until
				? _(
						msg`Table ${table.label}, open, seats ${covers}, free until ${untilFull}`,
					)
				: _(msg`Table ${table.label}, open, seats ${covers}`)
	}
	// Whose table it is, while the floor shows sections.
	if (section) {
		const sectionName = section.name
		const server = section.server?.name
		label = server
			? _(msg`${label}. ${sectionName}, ${server}.`)
			: _(msg`${label}. ${sectionName}, no server.`)
	}
	const initials = section?.server ? initialsOf(section.server.name) : ''
	// Only some of the party sit here: said, so a screen reader hears it too.
	if (partly) {
		const partlyText = coversText(_, partly)
		label = _(msg`${label}. ${partlyText}.`)
	}
	// While a party is being placed, say whether this table takes it, and why not.
	if (verdict)
		label = chosen
			? _(msg`${label}. Chosen for this party.`)
			: verdict.fits
				? best
					? _(msg`${label}. Best fit for this party.`)
					: _(msg`${label}. Takes this party.`)
				: _(msg`${label}. ${reason ?? ''}.`)

	return (
		<div
			className="bk-table bk-box @container"
			style={
				{
					'--l': box.l,
					'--t': box.t,
					'--w': box.w,
					'--h': box.h,
					'--section': section?.color,
				} as React.CSSProperties
			}
			data-state={state.kind}
			data-round={round}
			data-section={section ? section.id : undefined}
		>
			<button
				type="button"
				onClick={onClick}
				aria-label={label}
				data-state={state.kind}
				data-fits={fits === null ? undefined : String(fits)}
				data-best={best || undefined}
				data-chosen={chosen || undefined}
				aria-pressed={chosen || undefined}
				style={
					{
						'--turn': table.rotation ? `${table.rotation}deg` : undefined,
					} as React.CSSProperties
				}
				className={cn(
					'floor-table floor-turn flex flex-col items-center justify-center gap-0.5 p-0 text-center',
					round ? 'rounded-full' : 'rounded-(--station-panel-radius)',
					(state.kind === 'open' || state.kind === 'soon') && 'text-foreground',
					(state.kind === 'blocked' || state.kind === 'resetting') &&
						'text-muted-foreground',
				)}
			>
				{/* A VIP, an allergy, an occasion, a paid deposit: up to two marks in the corner. */}
				{signals.length > 0 ? (
					<span
						className="bk-signals pointer-events-none absolute z-3 flex flex-col gap-0.5"
						aria-hidden
					>
						{signals.map((signal) => (
							<span
								key={signal}
								className="bk-signal bg-card inline-flex h-4.5 w-4.5 items-center justify-center p-0.5"
								data-signal={signal}
							>
								<Icon name={SIGNAL_ICON[signal]} className="size-full" />
							</span>
						))}
					</span>
				) : null}
				{/* The server's initials, in the section's colour. */}
				{initials ? (
					<span
						aria-hidden
						className={cn(
							'bg-card text-foreground pointer-events-none absolute z-3 inline-flex h-5 min-w-6 items-center justify-center rounded-full border-2 border-(--section) px-0.5 text-xs leading-none font-semibold',
							// Just outside the corner, like a badge: never over the table's own words.
							round ? '-start-1 -top-1' : '-start-2 -top-2',
						)}
					>
						{initials}
					</span>
				) : null}
				{/* Outside the counter-rotated words: those would become the corner it sits in. */}
				{chosen ? (
					<span
						aria-hidden
						className="bk-chosen-mark bg-primary text-primary-foreground absolute end-1 top-1 z-3 inline-flex size-4 rounded-full p-0.75"
					>
						<Icon name="check" className="size-full" />
					</span>
				) : null}
				{/* Counter-rotate the words so a turned table still reads upright. */}
				<span className="bk-table-words floor-unturn relative z-2 flex max-w-full flex-col items-center gap-0.5 [overflow-wrap:anywhere]">
					<span className="bk-t-num tnum text-base leading-none font-semibold">
						{table.label}
					</span>
					<span
						className={cn(
							'bk-t-sub flex items-center gap-1',
							state.kind === 'seated'
								? 'text-foreground'
								: 'text-muted-foreground',
						)}
						aria-hidden
					>
						{state.kind === 'seated' ? (
							<>
								<Icon name="users" className="size-3.5" />
								{partly ? (
									// Partly seated: how many sit here of how many are coming.
									<span className="tnum" dir="ltr">
										{partly.here}/{partly.of}
									</span>
								) : (
									<span className="tnum">{state.party.partySize}</span>
								)}
							</>
						) : state.kind === 'soon' ? (
							// "12:55", no AM or PM: the full time is in the table's name.
							<span className="tnum text-warning font-semibold">
								{formatShort(state.next.startAt)}
							</span>
						) : state.kind === 'blocked' ? (
							<Icon name="ban" className="size-4" />
						) : state.kind === 'resetting' ? (
							<>
								<Icon name="refresh-cw" aria-hidden className="size-3.5" />
								<bdi className="tnum font-semibold">
									{_(msg`${resetLeftText}m`)}
								</bdi>
							</>
						) : until ? (
							<span className="tnum text-foreground font-semibold">
								{_(msg`till ${untilShort}`)}
							</span>
						) : (
							<>
								<Icon name="users" className="size-3.5" />
								{/* "1–4" keeps its order right to left. */}
								<span className="tnum" dir="ltr">
									{covers}
								</span>
							</>
						)}
					</span>
					{/* How long until the table clears (past the end: how long over), on its own line so a small round table never crops it. */}
					{state.kind === 'seated' && seatedFor !== null ? (
						<span
							className="bk-t-sub bk-left relative z-1 rounded-full px-1"
							data-over={sitting?.over ?? false}
							aria-hidden
						>
							{sitting?.over ? (
								<bdi>
									<SoftText value={_(msg`+${overText}m`)} />
								</bdi>
							) : arabic ? (
								// "٢٥ د": the number, then the short unit; "left" is in the table's name for a screen reader.
								<bdi>
									<SoftText value={_(msg`${leftText}m`)} />
								</bdi>
							) : (
								<>
									<SoftText value={_(msg`~${leftText}m`)} />
									{/* A small round table has no room for the word: the number says it. */}
									<span className="bk-left-word whitespace-nowrap">
										{' '}
										{_(msg`left`)}
									</span>
								</>
							)}
						</span>
					) : null}
				</span>
			</button>
			{best ? (
				<span
					className="bk-bestfit bg-success text-background pointer-events-none absolute start-1/2 -top-3.5 z-3 rounded-full px-2 py-0.25 text-xs leading-5 font-semibold whitespace-nowrap"
					aria-hidden
				>
					<Trans>Best fit</Trans>
				</span>
			) : null}
			{caption || stay !== null ? (
				<span
					className="bk-under pointer-events-none absolute -inset-x-3 z-2 flex flex-col items-center gap-0.5"
					aria-hidden
				>
					{stay !== null ? (
						<span
							className="bk-elapsed h-1 max-w-18 overflow-hidden"
							data-over={stay > 1}
							style={{ '--p': Math.min(1, stay) } as React.CSSProperties}
						/>
					) : null}
					{caption ? (
						<bdi
							className="bk-caption overflow-hidden leading-5 text-ellipsis whitespace-nowrap"
							data-reason={reason !== null}
						>
							{reasonShort !== null ? (
								<>
									<span className="bk-reason-long">{caption}</span>
									<span className="bk-reason-short">{reasonShort}</span>
								</>
							) : (
								caption
							)}
						</bdi>
					) : null}
				</span>
			) : null}
		</div>
	)
}

/** "3 of 12 tables free" over the room. */
export function freeTables(feed: DayFeed, areaId: string, now: number) {
	const tables = feed.tables.filter((t) => t.areaId === areaId && !t.archivedAt)
	const free = tables.filter((table) =>
		isFreeKind(tableState(table, feed, now).kind),
	).length
	return { free, total: tables.length }
}

export function FreeCount({ free, total }: { free: number; total: number }) {
	return (
		<span className="text-muted-foreground tnum text-sm">
			<Trans>
				{free} of {total} free
			</Trans>
		</span>
	)
}
