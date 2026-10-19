import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { cn } from '@repo/ui'
import { Icon, type IconName } from '@repo/ui/icon'
import { memo, type DragEvent } from 'react'
import { GuestFlags } from '#app/components/reservations/guest-flags.tsx'
import {
	TABLE_STATE_STYLES,
	type TableStateKey,
} from '#app/components/reservations/status-style.tsx'
import {
	type ComputedTableFloorState,
	type FloorLiveStatus,
	type FloorPlacement,
	floorTileLayout,
} from '#app/utils/reservations/floor-state.ts'
import {
	COURSE_STAGE_LABELS,
	enumLabel,
} from '#app/utils/reservations/labels.ts'

export const FLOOR_STATUS_ICONS: Record<FloorLiveStatus, IconName> = {
	available: 'check',
	reserved_soon: 'calendar',
	arrived_waiting: 'circle-check',
	seated: 'users',
	dessert_check: 'tag',
	finishing: 'clock',
	overtime: 'alert-triangle',
	blocked: 'ban',
}

/**
 * Stronger borders and fills for a bright room or a washed-out tablet. Same
 * semantic tokens as the normal look, never raw colors: contrast comes from
 * weight (thicker border, rings, dashed edge), and the state word is always
 * printed on the tile.
 */
const HIGH_CONTRAST_SURFACE: Record<FloorLiveStatus, string> = {
	available: 'border-foreground/70 bg-card',
	reserved_soon: 'border-primary bg-primary/20 ring-2 ring-primary/40',
	arrived_waiting: 'border-primary bg-primary/25 ring-2 ring-primary/50',
	seated: 'border-success bg-success/25',
	dessert_check: 'border-success border-dashed bg-success/25',
	finishing: 'border-success bg-success/30 ring-2 ring-success/50',
	overtime: 'border-destructive bg-destructive/25 ring-2 ring-destructive/50',
	blocked: 'border-foreground/60 border-dashed bg-muted',
}

export function floorTableSurface(
	status: FloorLiveStatus,
	highContrast: boolean,
): string {
	return highContrast
		? HIGH_CONTRAST_SURFACE[status]
		: TABLE_STATE_STYLES[status].surface
}

/** "Amal Khan" becomes "Amal K."; one-word names stay as they are. */
export function formatShortGuestName(fullName: string): string {
	const parts = fullName.trim().split(/\s+/)
	if (parts.length <= 1) return fullName
	return `${parts[0]} ${parts[parts.length - 1]?.[0] ?? ''}.`
}

export type FloorTableProps = {
	state: ComputedTableFloorState
	placement: FloorPlacement
	isRound: boolean
	selected: boolean
	dragOver: boolean
	highContrast: boolean
	canManage: boolean
	/** Section color shown as a dot when the overlay is on. */
	sectionColor: string | null
	showSection: boolean
	onSelect: (tableId: string) => void
	onDragOverTable: (
		event: DragEvent<HTMLButtonElement>,
		tableId: string,
	) => void
	onDragLeaveTable: (tableId: string) => void
	onDropOnTable: (
		event: DragEvent<HTMLButtonElement>,
		state: ComputedTableFloorState,
	) => void
}

/**
 * One short word per state for the tile's status line. The long label
 * ("Arrived, waiting") stays in the aria-label, the title and the side panel.
 */
const FREE_TABLE = msg({ message: 'Free', context: 'Table is free' })

export const FLOOR_COMPACT_STATUS: Partial<
	Record<TableStateKey, MessageDescriptor>
> = {
	available: FREE_TABLE,
	open: FREE_TABLE,
	reserved_soon: msg`Held`,
	arrived_waiting: msg`Waiting`,
	seated: msg`Seated`,
	entree: msg`Entree`,
	dessert: msg`Dessert`,
	dessert_check: msg`Dessert`,
	check_dropped: msg`Check`,
	finishing: msg`Ending`,
	overtime: msg`Over`,
	bussing: msg`Bussing`,
	blocked: msg`Blocked`,
}

function FloorTableBase({
	state,
	placement,
	isRound,
	selected,
	dragOver,
	highContrast,
	canManage,
	sectionColor,
	showSection,
	onSelect,
	onDragOverTable,
	onDragLeaveTable,
	onDropOnTable,
}: FloorTableProps) {
	const { t, i18n } = useLingui()
	const { table, liveStatus } = state
	const activeParty = state.currentReservation ?? state.nextReservation
	const layout = floorTileLayout(placement.width, placement.height, isRound)
	const roomy = layout.tier === 'roomy'

	const stateKey: TableStateKey =
		liveStatus === 'dessert_check'
			? state.stage === 'check'
				? 'check_dropped'
				: state.stage === 'bussing'
					? 'bussing'
					: 'dessert'
			: liveStatus
	const style = TABLE_STATE_STYLES[stateKey]
	const baseLabel = i18n._(style.label)
	const reservedAt = state.reservedAtHhmm
	const statusLabel =
		liveStatus === 'available' && reservedAt
			? t`Reserved ${reservedAt}`
			: baseLabel
	const compactDescriptor = FLOOR_COMPACT_STATUS[stateKey]
	const compactWord = compactDescriptor
		? i18n._(
				liveStatus === 'available' && reservedAt
					? FLOOR_COMPACT_STATUS.reserved_soon!
					: compactDescriptor,
			)
		: baseLabel
	/** Time of the next booking, shown beside the status word when the tile has room. */
	const statusTime =
		liveStatus === 'available' && reservedAt
			? reservedAt
			: !state.currentReservation && activeParty
				? activeParty.hhmm
				: null

	let timerText: string | null = null
	if (state.elapsedMin !== null && state.remainingMin !== null) {
		const elapsed = state.elapsedMin
		const remaining = Math.abs(state.remainingMin)
		timerText =
			state.remainingMin < 0
				? t`${elapsed}m · +${remaining}m over`
				: t`${elapsed}m · ${remaining}m left`
	}

	const guestName = activeParty
		? formatShortGuestName(activeParty.guestName)
		: null
	const fullGuestName = activeParty?.guestName ?? null
	const tableLabel = table.label
	const ariaLabel = guestName
		? t`Table ${tableLabel}, ${statusLabel}, ${guestName}`
		: t`Table ${tableLabel}, ${statusLabel}`
	const partySize = activeParty?.partySize
	const titleParts = [
		fullGuestName && partySize
			? `${tableLabel}, ${statusLabel}, ${fullGuestName} (${partySize})`
			: ariaLabel,
		!state.currentReservation && activeParty ? activeParty.hhmm : null,
		timerText,
	].filter(Boolean)
	const title = titleParts.join(' · ')
	const showPartyLine = Boolean(activeParty) && layout.showParty

	return (
		<button
			type="button"
			aria-label={ariaLabel}
			aria-pressed={selected}
			title={title}
			data-testid={`floor-table-${table.id}`}
			data-table-label={table.label}
			data-live-status={liveStatus}
			data-tile-tier={layout.tier}
			data-section-id={state.sectionId ?? ''}
			onClick={() => onSelect(table.id)}
			onDragOver={(e) => {
				if (!canManage) return
				onDragOverTable(e, table.id)
			}}
			onDragLeave={() => onDragLeaveTable(table.id)}
			onDrop={(e) => onDropOnTable(e, state)}
			className={cn(
				'absolute flex min-w-0 flex-col justify-center gap-0.5 overflow-hidden border-2 p-1.5 text-start text-xs leading-tight shadow-xs transition-colors focus-visible:ring-2 focus-visible:outline-none',
				isRound ? 'items-center rounded-full p-1 text-center' : 'rounded-xl',
				floorTableSurface(liveStatus, highContrast),
				selected && 'ring-primary ring-2 ring-offset-2',
				dragOver && 'border-primary bg-primary/15 ring-2',
			)}
			style={{
				left: placement.x,
				top: placement.y,
				width: placement.width,
				height: placement.height,
				transform: placement.rotation
					? `rotate(${placement.rotation}deg)`
					: undefined,
			}}
		>
			<div
				className={cn(
					'flex w-full min-w-0 items-center gap-1',
					isRound ? 'justify-center' : 'justify-between',
				)}
			>
				<span className="flex min-w-0 items-center gap-1">
					{showSection && sectionColor ? (
						<span
							aria-hidden="true"
							className="size-2 shrink-0 rounded-full"
							style={{ backgroundColor: sectionColor }}
						/>
					) : null}
					<span
						className="truncate text-sm font-bold"
						data-testid={`floor-table-label-${table.id}`}
					>
						{table.label}
					</span>
				</span>
				{activeParty && !roomy && !isRound ? (
					<GuestFlags reservation={activeParty} tier="tight" />
				) : null}
				{isRound ? null : (
					<span className="text-muted-foreground flex shrink-0 items-center gap-0.5">
						<Icon name={FLOOR_STATUS_ICONS[liveStatus]} className="size-3.5" />
						{roomy ? (
							<span>
								{table.minCovers}-{table.maxCovers}
							</span>
						) : null}
					</span>
				)}
			</div>

			<div
				className={cn(
					'flex w-full min-w-0 items-center gap-1 text-xs font-medium',
					style.text,
					isRound && 'justify-center',
				)}
			>
				<span
					aria-hidden="true"
					className={cn('size-1.5 shrink-0 rounded-full', style.dot)}
				/>
				<span
					className="flex min-w-0 items-center gap-1 whitespace-nowrap"
					data-testid={`floor-table-status-text-${table.id}`}
				>
					<span>{compactWord}</span>
					{layout.showTime && statusTime ? (
						<span className="tabular-nums">{statusTime}</span>
					) : null}
				</span>
			</div>

			{showPartyLine && activeParty ? (
				<div
					className={cn(
						'min-w-0 text-xs font-medium',
						layout.partyLines === 2 ? 'line-clamp-2' : 'line-clamp-1',
					)}
				>
					<span data-testid={`floor-table-guest-${table.id}`}>{guestName}</span>{' '}
					<span
						className="text-muted-foreground font-normal tabular-nums"
						data-testid={`floor-table-party-size-${table.id}`}
					>
						{activeParty.partySize}p
					</span>
				</div>
			) : null}

			{roomy && !isRound && timerText ? (
				<span
					className={cn(
						'truncate text-xs font-medium tabular-nums',
						liveStatus === 'overtime' && 'text-warning',
					)}
					data-testid={`floor-table-timer-${table.id}`}
				>
					{timerText}
				</span>
			) : roomy && activeParty?.courseStage && !isRound ? (
				<span
					className="text-muted-foreground truncate text-xs"
					data-testid={`floor-table-course-${table.id}`}
				>
					{enumLabel(
						(d) => i18n._(d),
						COURSE_STAGE_LABELS,
						activeParty.courseStage,
					)}
				</span>
			) : null}

			{roomy && activeParty && !isRound ? (
				<GuestFlags
					reservation={activeParty}
					showOccasion={false}
					className="text-start"
				/>
			) : null}

			{roomy && !isRound && showSection && state.sectionName ? (
				<span
					className="bg-background/80 text-foreground mt-auto inline-flex min-w-0 items-center gap-1 self-start rounded-sm px-1"
					data-testid={`floor-table-section-badge-${table.id}`}
				>
					<span
						aria-hidden="true"
						className="size-2 shrink-0 rounded-full"
						style={{
							backgroundColor: sectionColor ?? 'var(--muted-foreground)',
						}}
					/>
					<span className="truncate">{state.sectionName}</span>
				</span>
			) : null}
		</button>
	)
}

/** One table on the live floor. Memoized so a poll that changes one party redraws one tile. */
export const FloorTable = memo(FloorTableBase)
