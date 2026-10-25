import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Ban, Clock3, RefreshCw, Users } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
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
	onTable,
	formatTime,
	formatShort,
}: {
	area: DayArea
	feed: DayFeed
	now: number
	/** The party being placed, if any: how many, for how long, and its own booking. */
	picking: PartyToPlace | null
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
			picking
				? bestFit(
						live.map((table) => ({ table, state: states.get(table.id)! })),
						picking,
						now,
					)
				: null,
		[picking, live, states, now],
	)

	return (
		<div
			className="floor floor-room relative min-h-0 flex-1 overflow-hidden"
			data-picking={picking ? 'true' : 'false'}
		>
			{fit?.scrolls ? (
				// Only where the room cannot fit at a usable size: it pans.
				<p className="bk-floor-hint" aria-hidden>
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
					className={cn('bk-plan relative', !drawn && 'h-full w-full')}
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
						const verdict = picking
							? fitVerdict(table, state, picking, now)
							: null
						return (
							<TableButton
								key={table.id}
								table={table}
								state={state}
								now={now}
								verdict={verdict}
								best={best === table.id}
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
	best,
	onClick,
	formatTime,
	formatShort,
	box,
}: {
	table: DayTable
	state: TableState
	now: number
	/** While a party is being placed: whether this table takes them, and if not why. */
	verdict: FitVerdict | null
	/** The one table to suggest for the party in hand. */
	best: boolean
	onClick: () => void
	formatTime: (epochMs: number) => string
	formatShort: (epochMs: number) => string
	box: Box
}) {
	const { _ } = useLingui()
	const round = table.shape === 'round' || table.shape === 'oval'
	const covers =
		table.minCovers > 0 && table.minCovers < table.maxCovers
			? `${table.minCovers}–${table.maxCovers}`
			: String(table.maxCovers)
	// How long they have sat, and how long until the table is expected to clear.
	const sitting = state.kind === 'seated' ? stayOf(state.party, now) : null
	const seatedFor = sitting?.seatedMin ?? null
	const leftMin = sitting?.leftMin ?? 0
	const overMin = sitting?.overMin ?? 0
	// How far through the booked stay they are: a thin bar that turns amber past the end.
	const stay = sitting ? sitting.ratio : null
	// A table being cleared after a party left: minutes until it is ready again.
	const resetLeft =
		state.kind === 'resetting'
			? Math.max(1, Math.ceil((state.readyAt - now) / 60_000))
			: 0
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
					<Clock3 aria-hidden className="size-3" />
					{formatShort(verdict.at)}
				</span>
			)
		} else if (verdict.why === 'small') {
			reason = _(msg`Too small`)
			reasonShort = _(msg`Small`)
		} else if (verdict.why === 'resetting') {
			reason = _(msg`Resetting ${resetLeft}m`)
			reasonShort = (
				<span className="inline-flex items-center gap-0.5">
					<RefreshCw aria-hidden className="size-3" />
					{_(msg`${resetLeft}m`)}
				</span>
			)
		} else {
			reason = _(msg`Taken`)
			reasonShort = null
		}
	}
	/** Who is there (or due), or why the party in hand does not fit, under the table. */
	const caption =
		reason ??
		(state.kind === 'seated'
			? shortName(state.party, _(msg`Guest`))
			: state.kind === 'soon'
				? shortName(state.next, _(msg`Guest`))
				: state.kind === 'resetting'
					? _(msg`Resetting ${resetLeft}m`)
					: null)
	// A phone has room for the word, not the minutes (the table says them).
	if (reasonShort === null && state.kind === 'resetting' && !reason)
		reasonShort = _(msg`Resetting`)

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
	// While a party is being placed, say whether this table takes it, and why not.
	if (verdict)
		label = verdict.fits
			? best
				? _(msg`${label}. Best fit for this party.`)
				: _(msg`${label}. Takes this party.`)
			: _(msg`${label}. ${reason ?? ''}.`)

	return (
		<div
			className="bk-table bk-box"
			style={
				{
					'--l': box.l,
					'--t': box.t,
					'--w': box.w,
					'--h': box.h,
				} as React.CSSProperties
			}
			data-state={state.kind}
			data-round={round}
		>
			<button
				type="button"
				onClick={onClick}
				aria-label={label}
				data-state={state.kind}
				data-fits={fits === null ? undefined : String(fits)}
				data-best={best || undefined}
				style={
					{
						'--turn': table.rotation ? `${table.rotation}deg` : undefined,
					} as React.CSSProperties
				}
				className={cn(
					'floor-table floor-turn flex flex-col items-center justify-center gap-0.5 overflow-hidden border-2 p-1 text-center',
					round ? 'rounded-full' : 'rounded-2xl',
					state.kind === 'open' && 'text-foreground',
					state.kind === 'soon' &&
						'border-warning bg-warning/10 text-foreground border-dashed',
					state.kind === 'seated' &&
						'border-primary bg-primary text-primary-foreground elevated-card',
					state.kind === 'blocked' &&
						'border-border bg-muted text-muted-foreground',
					state.kind === 'resetting' &&
						'border-border text-muted-foreground border-dashed',
				)}
			>
				{/* Counter-rotate the words so a turned table still reads upright. */}
				<span className="floor-unturn flex flex-col items-center gap-0.5">
					<span className="bk-t-num mono">{table.label}</span>
					<span
						className={cn(
							'bk-t-sub flex items-center gap-1',
							state.kind === 'seated'
								? 'text-primary-foreground/90'
								: 'text-muted-foreground',
						)}
						aria-hidden
					>
						{state.kind === 'seated' ? (
							<>
								<Users className="size-3.5" />
								<span className="tnum">{state.party.partySize}</span>
							</>
						) : state.kind === 'soon' ? (
							// "12:55", no AM or PM: the full time is in the table's name.
							<span className="tnum text-warning font-semibold">
								{formatShort(state.next.startAt)}
							</span>
						) : state.kind === 'blocked' ? (
							<Ban className="size-4" />
						) : state.kind === 'resetting' ? (
							<>
								<RefreshCw aria-hidden className="size-3.5" />
								<span className="tnum font-semibold">
									{_(msg`${resetLeft}m`)}
								</span>
							</>
						) : until ? (
							<span className="tnum text-foreground font-semibold">
								{_(msg`till ${untilShort}`)}
							</span>
						) : (
							<>
								<Users className="size-3.5" />
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
							className="bk-t-sub bk-left relative z-1"
							data-over={sitting?.over ?? false}
							aria-hidden
						>
							{sitting?.over ? (
								<SoftText value={_(msg`+${overMin}m`)} />
							) : (
								<>
									<SoftText value={_(msg`~${leftMin}m`)} />
									{/* A small round table has no room for the word: the number says it. */}
									<span className="bk-left-word"> {_(msg`left`)}</span>
								</>
							)}
						</span>
					) : null}
				</span>
			</button>
			{best ? (
				<span className="bk-bestfit" aria-hidden>
					<Trans>Best fit</Trans>
				</span>
			) : null}
			{caption || stay !== null ? (
				<span className="bk-under" aria-hidden>
					{stay !== null ? (
						<span
							className="bk-elapsed"
							data-over={stay > 1}
							style={{ '--p': Math.min(1, stay) } as React.CSSProperties}
						/>
					) : null}
					{caption ? (
						<bdi className="bk-caption" data-reason={reason !== null}>
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
