import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Ban, Users } from 'lucide-react'
import { useMemo } from 'react'
import {
	isDrawn,
	placeTables,
	shortName,
	takesParty,
	tableState,
	type DayArea,
	type DayElement,
	type DayFeed,
	type DayTable,
	type TableState,
} from './feed.ts'
import { SoftText } from '~/ui/motion.tsx'
import { cn } from '~/ui/primitives.tsx'

/**
 * One room of the floor, as the manager drew it (or as a tidy grid when nobody
 * has yet). Each table shows its state at a glance: open, a party due within
 * half an hour, seated (and for how long), or blocked. While the host is
 * placing a party, tables that seat it lift and the rest step back.
 */
export function Floor({
	area,
	feed,
	now,
	picking,
	onTable,
	formatTime,
}: {
	area: DayArea
	feed: DayFeed
	now: number
	/** The party being placed, if any: how many, for how long, and its own booking. */
	picking: {
		partySize: number
		durationMin: number
		reservationId?: string
	} | null
	onTable: (table: DayTable, state: TableState) => void
	formatTime: (epochMs: number) => string
}) {
	const roomTables = useMemo(
		() => feed.tables.filter((table) => table.areaId === area.id),
		[area.id, feed.tables],
	)
	const placed = useMemo(
		() => placeTables(area, roomTables),
		[area, roomTables],
	)
	const elements = feed.elements.filter(
		(element) => !element.areaId || element.areaId === area.id,
	)
	// A drawn room keeps its proportions; an undrawn one is a grid that fills the space.
	const drawn = isDrawn(roomTables)

	return (
		<div
			className="floor floor-room relative min-h-0 flex-1 overflow-hidden"
			data-picking={picking ? 'true' : 'false'}
		>
			{/* The plan keeps its proportions and sits centred in whatever space it has. */}
			<div className="floor-frame absolute inset-4 sm:inset-6">
				{drawn ? (
					// Only where the room is wider than the screen (a phone): it scrolls.
					<p className="floor-hint" aria-hidden>
						<Trans>Swipe to see the whole room</Trans>
					</p>
				) : null}
				<div
					className={cn(
						'relative mx-auto',
						drawn ? 'floor-plan' : 'h-full w-full',
					)}
					style={
						drawn
							? ({
									'--plan-w': Math.max(area.canvasW, 1),
									'--plan-h': Math.max(area.canvasH, 1),
								} as React.CSSProperties)
							: undefined
					}
				>
					{drawn
						? elements.map((element) => (
								<FloorElement key={element.id} element={element} area={area} />
							))
						: null}
					{placed.map(({ table, left, top, width, height }) => {
						const state = tableState(table, feed, now)
						return (
							<TableButton
								key={table.id}
								table={table}
								state={state}
								now={now}
								fits={picking ? takesParty(table, state, picking, now) : null}
								onClick={() => onTable(table, state)}
								formatTime={formatTime}
								style={{
									left: `${left * 100}%`,
									top: `${top * 100}%`,
									width: `${width * 100}%`,
									height: `${height * 100}%`,
								}}
							/>
						)
					})}
				</div>
			</div>
		</div>
	)
}

function FloorElement({
	element,
	area,
}: {
	element: DayElement
	area: DayArea
}) {
	const style = {
		left: `${(element.x / Math.max(area.canvasW, 1)) * 100}%`,
		top: `${(element.y / Math.max(area.canvasH, 1)) * 100}%`,
		width: `${(element.w / Math.max(area.canvasW, 1)) * 100}%`,
		height: `${(element.h / Math.max(area.canvasH, 1)) * 100}%`,
		'--turn': element.rotation ? `${element.rotation}deg` : undefined,
	} as React.CSSProperties
	return (
		<div
			aria-hidden
			style={style}
			className={cn(
				'floor-turn pointer-events-none absolute flex items-center justify-center overflow-hidden text-xs font-medium',
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
	fits,
	onClick,
	formatTime,
	style,
}: {
	table: DayTable
	state: TableState
	now: number
	fits: boolean | null
	onClick: () => void
	formatTime: (epochMs: number) => string
	style: React.CSSProperties
}) {
	const { _ } = useLingui()
	const round = table.shape === 'round' || table.shape === 'oval'
	const covers =
		table.minCovers > 0 && table.minCovers < table.maxCovers
			? `${table.minCovers}–${table.maxCovers}`
			: String(table.maxCovers)
	const seatedFor =
		state.kind === 'seated' && state.party.seatedAt
			? Math.max(0, Math.floor((now - state.party.seatedAt) / 60_000))
			: null
	// How far through the booked stay they are: a thin bar that turns amber past the end.
	const stay =
		state.kind === 'seated' && seatedFor !== null
			? seatedFor / Math.max(1, state.party.durationMin)
			: null
	/** Who is there (or due), under the table: a small table has no room for a name inside. */
	const caption =
		state.kind === 'seated'
			? shortName(state.party, _(msg`Guest`))
			: state.kind === 'soon'
				? shortName(state.next, _(msg`Guest`))
				: null

	let label: string
	switch (state.kind) {
		case 'seated':
			label = _(
				msg`Table ${table.label}, seated: ${shortName(state.party, _(msg`Guest`))}, party of ${state.party.partySize}`,
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
		default:
			label = _(msg`Table ${table.label}, open, seats ${covers}`)
	}
	// While a party is being placed, say whether this table takes it.
	if (fits !== null)
		label = fits
			? _(msg`${label}. Takes this party.`)
			: _(msg`${label}. Not a fit for this party.`)

	return (
		<div
			className="bk-table min-h-14 min-w-14"
			style={style}
			data-state={state.kind}
		>
			<button
				type="button"
				onClick={onClick}
				aria-label={label}
				data-state={state.kind}
				data-fits={fits === null ? undefined : String(fits)}
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
				)}
			>
				{/* Counter-rotate the words so a turned table still reads upright. */}
				<span className="floor-unturn flex flex-col items-center gap-0.5">
					<span className="mono text-base leading-none font-bold sm:text-lg">
						{table.label}
					</span>
					<span
						className={cn(
							'flex items-center gap-1 text-xs leading-none font-medium',
							state.kind === 'seated'
								? 'text-primary-foreground/85'
								: 'text-muted-foreground',
						)}
						aria-hidden
					>
						{state.kind === 'seated' ? (
							<>
								<Users className="size-3" />
								<span className="tnum">{state.party.partySize}</span>
							</>
						) : state.kind === 'soon' ? (
							<span className="tnum text-warning max-w-full text-center leading-tight font-semibold whitespace-normal">
								{formatTime(state.next.startAt)}
							</span>
						) : state.kind === 'blocked' ? (
							<Ban className="size-3.5" />
						) : (
							<>
								<Users className="size-3" />
								{/* "1–4" keeps its order right to left. */}
								<span className="tnum" dir="ltr">
									{covers}
								</span>
							</>
						)}
					</span>
					{/* How long they have been seated, on its own line so a small round table never crops it. */}
					{state.kind === 'seated' && seatedFor !== null ? (
						<span
							className="text-primary-foreground/85 relative z-1 text-xs leading-none font-medium"
							aria-hidden
						>
							<SoftText value={_(msg`${seatedFor}m`)} />
						</span>
					) : null}
				</span>
			</button>
			{caption || stay !== null ? (
				<span className="bk-under" aria-hidden>
					{stay !== null ? (
						<span
							className="bk-elapsed"
							data-over={stay > 1}
							style={{ '--p': Math.min(1, stay) } as React.CSSProperties}
						/>
					) : null}
					{caption ? <bdi className="bk-caption">{caption}</bdi> : null}
				</span>
			) : null}
		</div>
	)
}

/** "3 of 12 tables free" over the room. */
export function freeTables(feed: DayFeed, areaId: string, now: number) {
	const tables = feed.tables.filter((t) => t.areaId === areaId && !t.archivedAt)
	const free = tables.filter((table) => {
		const kind = tableState(table, feed, now).kind
		return kind === 'open' || kind === 'soon'
	}).length
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
