import { useDraggable } from '@dnd-kit/core'
import { plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Icon } from '@repo/ui/icon'
import { positionBlockClass, PositionDot } from '@repo/ui/position-color'
import { memo, type KeyboardEvent, type MouseEvent } from 'react'
import { describeConflict } from '#app/utils/staffing/schedule-errors.ts'
import {
	type SchedulePositionRow,
	type ScheduleShiftRow,
} from '#app/utils/staffing/schedule-types.ts'
import {
	formatDuration,
	formatShiftRange,
	isOvernight,
	positionName,
	shiftDragId,
} from '#app/utils/staffing/schedule-view.ts'
import { formatMoneyMinor } from '#app/utils/staffing/staff-format.ts'

/** What a block says about itself to a screen reader. */
export function useShiftLabel() {
	const { _, i18n } = useLingui()
	return (
		shift: ScheduleShiftRow,
		position: SchedulePositionRow | undefined,
		showConflicts: boolean,
	) => {
		const range = formatShiftRange(shift, i18n.locale)
		const state =
			shift.state === 'draft'
				? _(t`Draft`)
				: shift.state === 'changed'
					? _(t`Edited, not published`)
					: shift.state === 'cancel_pending'
						? _(t`Removal not published`)
						: _(t`Published`)
		const parts = [
			state,
			range,
			positionName(position, i18n.locale),
			formatDuration(shift.paidMinutes),
		].filter(Boolean)
		if (isOvernight(shift)) parts.push(_(t`Ends the next day`))
		if (showConflicts && shift.conflicts.length > 0) {
			parts.push(
				plural(shift.conflicts.length, {
					one: '# warning',
					other: '# warnings',
				}),
				...shift.conflicts.map((conflict) =>
					describeConflict(conflict.code, _),
				),
			)
		}
		return parts.join(', ')
	}
}

type VisualProps = {
	shift: ScheduleShiftRow
	position: SchedulePositionRow | undefined
	showConflicts: boolean
	/** The position is already the group heading, so the block leaves it out. */
	hidePosition?: boolean
	showCost: boolean
	className?: string
}

/** What a shift block shows. Used on the grid, in the drag overlay and in lists. */
export function ShiftBlockFace({
	shift,
	position,
	showConflicts,
	hidePosition,
	showCost,
}: Omit<VisualProps, 'className'>) {
	const { _, i18n } = useLingui()
	const flagged = showConflicts && shift.conflicts.length > 0
	const removing = shift.state === 'cancel_pending'
	return (
		<>
			<span className="flex w-full items-center gap-1">
				<bdi
					className={cn(
						'truncate text-sm leading-5 font-medium tabular-nums',
						removing && 'line-through',
					)}
				>
					{formatShiftRange(shift, i18n.locale)}
				</bdi>
				{isOvernight(shift) ? (
					<span
						className="text-muted-foreground shrink-0 text-xs"
						title={_(t`Ends the next day`)}
					>
						<span aria-hidden="true">+1</span>
					</span>
				) : null}
				<span className="ms-auto flex shrink-0 items-center gap-1">
					{shift.state === 'changed' ? (
						<span
							className="bg-primary size-1.5 rounded-full"
							title={_(t`Edited, not published`)}
						/>
					) : null}
					{flagged ? (
						<span
							className="text-destructive"
							title={shift.conflicts
								.map((conflict) => describeConflict(conflict.code, _))
								.join('. ')}
						>
							<Icon
								name="alert-triangle"
								className="size-3.5"
								aria-hidden="true"
							/>
						</span>
					) : null}
				</span>
			</span>
			<span className="text-muted-foreground flex w-full items-center gap-1.5 text-xs">
				{!hidePosition && position ? (
					<>
						<PositionDot colorKey={position.colorKey} className="size-2" />
						<span className="truncate">
							{positionName(position, i18n.locale)}
						</span>
						<span aria-hidden="true">·</span>
					</>
				) : null}
				<span className="shrink-0 tabular-nums">
					{formatDuration(shift.paidMinutes)}
				</span>
				{showCost && shift.costMinor != null && shift.currency ? (
					<span className="ms-auto shrink-0 tabular-nums">
						{formatMoneyMinor(shift.costMinor, shift.currency, i18n.locale)}
					</span>
				) : null}
			</span>
		</>
	)
}

export function blockClassName(
	shift: ScheduleShiftRow,
	position: SchedulePositionRow | undefined,
	flagged: boolean,
) {
	return cn(
		'flex min-h-11 w-full flex-col items-start justify-center gap-0.5 rounded-md border px-2 py-1 text-start',
		'focus-visible:ring-ring/60 outline-none focus-visible:ring-2',
		positionBlockClass(position?.colorKey, shift.state === 'draft'),
		shift.state === 'cancel_pending' && 'opacity-60',
		flagged && 'border-destructive/70',
	)
}

type Props = VisualProps & {
	draggable: boolean
	selected?: boolean
	onOpen: (shift: ScheduleShiftRow) => void
	onKeyAction?: (
		event: KeyboardEvent<HTMLButtonElement>,
		shift: ScheduleShiftRow,
	) => void
	busy?: boolean
}

/**
 * One shift on the week grid. The button opens the editor (Enter or click);
 * Space lifts it for a keyboard move, and a pointer or touch drag moves it.
 */
export const ShiftBlock = memo(function ShiftBlock({
	shift,
	position,
	showConflicts,
	hidePosition,
	showCost,
	draggable,
	selected,
	onOpen,
	onKeyAction,
	busy,
	className,
}: Props) {
	const label = useShiftLabel()
	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id: shiftDragId(shift.id),
		disabled: !draggable || busy,
	})
	const flagged = showConflicts && shift.conflicts.length > 0
	return (
		<button
			ref={setNodeRef}
			type="button"
			data-shift-id={shift.id}
			data-state={shift.state}
			aria-label={label(shift, position, showConflicts)}
			data-selected={selected || undefined}
			{...attributes}
			// The library sets role="button" and a roledescription for drag.
			{...listeners}
			onClick={(event: MouseEvent) => {
				event.stopPropagation()
				onOpen(shift)
			}}
			onKeyDown={(event) => {
				listeners?.onKeyDown?.(event)
				onKeyAction?.(event, shift)
			}}
			className={cn(
				blockClassName(shift, position, flagged),
				'touch-manipulation',
				draggable && !busy && 'cursor-grab active:cursor-grabbing',
				isDragging && 'opacity-40',
				busy && 'animate-pulse',
				selected && 'ring-primary ring-2',
				className,
			)}
		>
			<ShiftBlockFace
				shift={shift}
				position={position}
				showConflicts={showConflicts}
				hidePosition={hidePosition}
				showCost={showCost}
			/>
		</button>
	)
})
