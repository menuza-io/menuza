import { useLingui } from '@lingui/react/macro'
import { cn } from '@repo/ui'
import { Icon, type IconName } from '@repo/ui/icon'
import { memo, type DragEvent } from 'react'
import { TABLE_STATE_STYLES } from '#app/components/reservations/status-style.tsx'
import {
	type ComputedTableFloorState,
	type FloorLiveStatus,
	type FloorPlacement,
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

/** Width below which the capacity and section chip are left to the quick-actions panel. */
const COMPACT_WIDTH = 96

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
	const compact = placement.width < COMPACT_WIDTH

	const stateKey =
		liveStatus === 'dessert_check'
			? state.stage === 'check'
				? 'check_dropped'
				: state.stage === 'bussing'
					? 'bussing'
					: 'dessert'
			: liveStatus
	const baseLabel = i18n._(TABLE_STATE_STYLES[stateKey].label)
	const reservedAt = state.reservedAtHhmm
	const statusLabel =
		liveStatus === 'available' && reservedAt
			? t`Reserved ${reservedAt}`
			: baseLabel

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
	const tableLabel = table.label
	const ariaLabel = guestName
		? t`Table ${tableLabel}, ${statusLabel}, ${guestName}`
		: t`Table ${tableLabel}, ${statusLabel}`

	return (
		<button
			type="button"
			aria-label={ariaLabel}
			aria-pressed={selected}
			title={ariaLabel}
			data-testid={`floor-table-${table.id}`}
			data-table-label={table.label}
			data-live-status={liveStatus}
			data-section-id={state.sectionId ?? ''}
			onClick={() => onSelect(table.id)}
			onDragOver={(e) => {
				if (!canManage) return
				onDragOverTable(e, table.id)
			}}
			onDragLeave={() => onDragLeaveTable(table.id)}
			onDrop={(e) => onDropOnTable(e, state)}
			className={cn(
				'absolute flex flex-col justify-between overflow-hidden border-2 p-1.5 text-start shadow-xs transition-colors focus-visible:ring-2 focus-visible:outline-none',
				isRound ? 'rounded-full px-2.5 py-2' : 'rounded-xl',
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
			<div className="flex w-full items-center justify-between gap-1">
				<span className="flex min-w-0 items-center gap-1">
					{showSection && compact && sectionColor ? (
						<span
							aria-hidden="true"
							className="size-2 shrink-0 rounded-full"
							style={{ backgroundColor: sectionColor }}
						/>
					) : null}
					<span className="truncate text-xs font-semibold">{table.label}</span>
				</span>
				<span className="text-muted-foreground flex shrink-0 items-center gap-0.5 text-xs">
					<Icon name={FLOOR_STATUS_ICONS[liveStatus]} className="size-3.5" />
					{compact ? null : (
						<span>
							{table.minCovers}-{table.maxCovers}
						</span>
					)}
				</span>
			</div>

			{activeParty ? (
				<div className="flex items-center justify-between gap-1 overflow-hidden">
					<span
						className="truncate text-xs font-medium"
						data-testid={`floor-table-guest-${table.id}`}
					>
						{guestName}
					</span>
					<span
						className="text-muted-foreground shrink-0 text-xs tabular-nums"
						data-testid={`floor-table-party-size-${table.id}`}
					>
						{state.currentReservation ? null : `${activeParty.hhmm} · `}
						{activeParty.partySize}p
					</span>
				</div>
			) : (
				<div className="text-muted-foreground truncate text-xs">
					{statusLabel}
				</div>
			)}

			<div className="flex w-full items-center justify-between gap-1">
				{timerText ? (
					<span
						className={cn(
							'truncate text-xs font-medium tabular-nums',
							liveStatus === 'overtime' && 'text-warning',
						)}
						data-testid={`floor-table-timer-${table.id}`}
					>
						{timerText}
					</span>
				) : activeParty?.courseStage ? (
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
				) : (
					<span
						className="text-muted-foreground truncate text-xs"
						data-testid={`floor-table-status-text-${table.id}`}
					>
						{activeParty ? statusLabel : null}
					</span>
				)}

				{showSection && state.sectionName && !compact ? (
					<span
						className="bg-background/80 text-foreground inline-flex min-w-0 items-center gap-1 rounded-sm px-1 text-xs"
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
			</div>
		</button>
	)
}

/** One table on the live floor. Memoized so a poll that changes one party redraws one tile. */
export const FloorTable = memo(FloorTableBase)
