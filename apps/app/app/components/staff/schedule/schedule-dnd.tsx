import {
	closestCenter,
	type CollisionDetection,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	KeyboardSensor,
	type KeyboardCoordinateGetter,
	PointerSensor,
	pointerWithin,
	TouchSensor,
	useSensor,
	useSensors,
	type Announcements,
} from '@dnd-kit/core'
import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { type UpdateShiftInput } from '#app/utils/staffing/schedule-api.ts'
import {
	type SchedulePositionRow,
	type ScheduleShiftRow,
} from '#app/utils/staffing/schedule-types.ts'
import {
	formatShiftRange,
	movePatch,
	moveTimes,
	parseCellDropId,
	parseShiftDragId,
	TIME_STEP_MINUTES,
} from '#app/utils/staffing/schedule-view.ts'
import { blockClassName, ShiftBlockFace } from './shift-block.tsx'

const collision: CollisionDetection = (args) => {
	const within = args.pointerCoordinates ? pointerWithin(args) : []
	return within.length > 0 ? within : closestCenter(args)
}

type Direction = 'left' | 'right' | 'up' | 'down'
const DIRECTION_BY_CODE: Record<string, Direction> = {
	ArrowLeft: 'left',
	ArrowRight: 'right',
	ArrowUp: 'up',
	ArrowDown: 'down',
}

/**
 * Arrow keys while a shift is lifted: jump to the neighboring cell. On the day
 * timeline, left and right slide the shift by one time step instead.
 */
export function makeCoordinateGetter(
	pxPerMinute: number | undefined,
): KeyboardCoordinateGetter {
	return (event, { context, currentCoordinates }) => {
		const direction = DIRECTION_BY_CODE[event.code]
		if (!direction) return undefined
		event.preventDefault()
		const { collisionRect, droppableRects, droppableContainers } = context
		if (!collisionRect) return undefined
		if (pxPerMinute && (direction === 'left' || direction === 'right')) {
			const step =
				pxPerMinute * TIME_STEP_MINUTES * (direction === 'right' ? 1 : -1)
			return { x: currentCoordinates.x + step, y: currentCoordinates.y }
		}
		const cx = collisionRect.left + collisionRect.width / 2
		const cy = collisionRect.top + collisionRect.height / 2
		const containers = droppableContainers.getEnabled()
		// The cell the lifted shift is in. A neighbour is "ahead" only when it
		// lies wholly beyond this cell's edge: judging by centres alone lets a
		// cell taller than the shift (or a cell in the same row) count as ahead,
		// so the arrow key would go nowhere.
		const current = containers
			.map((container) => droppableRects.get(container.id))
			.find(
				(rect) =>
					rect &&
					cx >= rect.left &&
					cx <= rect.right &&
					cy >= rect.top &&
					cy <= rect.bottom,
			)
		let best: { x: number; y: number; score: number } | null = null
		for (const container of containers) {
			const rect = droppableRects.get(container.id)
			if (!rect || rect === current) continue
			const rx = rect.left + rect.width / 2
			const ry = rect.top + rect.height / 2
			const dx = rx - cx
			const dy = ry - cy
			const ahead = current
				? direction === 'right'
					? rect.left >= current.right - 1
					: direction === 'left'
						? rect.right <= current.left + 1
						: direction === 'down'
							? rect.top >= current.bottom - 1
							: rect.bottom <= current.top + 1
				: direction === 'right'
					? dx > 4
					: direction === 'left'
						? dx < -4
						: direction === 'down'
							? dy > 4
							: dy < -4
			if (!ahead) continue
			const along =
				direction === 'left' || direction === 'right'
					? Math.abs(dx)
					: Math.abs(dy)
			const across =
				direction === 'left' || direction === 'right'
					? Math.abs(dy)
					: Math.abs(dx)
			// Prefer the nearest cell in line with the lifted shift.
			const score = along + across * 4
			if (!best || score < best.score) {
				best = { x: rect.left, y: rect.top, score }
			}
		}
		return best ? { x: best.x, y: best.y } : undefined
	}
}

type Props = {
	shifts: ReadonlyMap<string, ScheduleShiftRow>
	positions: ReadonlyMap<string, SchedulePositionRow>
	rtl: boolean
	/** Day timeline only: pixels per minute, so a horizontal drag changes times. */
	pxPerMinute?: number
	showConflicts: boolean
	showCost: boolean
	/** "Rana Khalid, Tuesday March 3", spoken while a shift is carried. */
	describeCell: (rowKey: string, date: string) => string
	onChange: (shift: ScheduleShiftRow, body: UpdateShiftInput) => void
	children: ReactNode
}

/** Drag and drop for the schedule: pointer, touch and keyboard, with spoken updates. */
export function ScheduleDnd({
	shifts,
	positions,
	rtl,
	pxPerMinute,
	showConflicts,
	showCost,
	describeCell,
	onChange,
	children,
}: Props) {
	const { _, i18n } = useLingui()
	const [activeId, setActiveId] = useState<string | null>(null)
	const sensors = useSensors(
		// A short drag distance keeps a plain click free to open the editor.
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		// A short press-and-hold on touch screens, so scrolling still works.
		useSensor(TouchSensor, {
			activationConstraint: { delay: 220, tolerance: 8 },
		}),
		useSensor(KeyboardSensor, {
			// Enter opens the editor; Space lifts, Space drops, Escape cancels.
			keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
			coordinateGetter: makeCoordinateGetter(pxPerMinute),
		}),
	)

	const active = activeId ? shifts.get(activeId) : undefined

	const announcements: Announcements = useMemo(() => {
		const lookup = (id: unknown) => {
			const shiftId = parseShiftDragId(id)
			return shiftId ? shifts.get(shiftId) : undefined
		}
		const where = (id: unknown) => {
			const cell = parseCellDropId(id)
			return cell ? describeCell(cell.rowKey, cell.date) : ''
		}
		return {
			onDragStart({ active: a }) {
				const shift = lookup(a.id)
				if (!shift) return undefined
				const range = formatShiftRange(shift, i18n.locale)
				return _(t`Picked up the shift ${range}.`)
			},
			onDragOver({ active: a, over }) {
				const shift = lookup(a.id)
				const target = where(over?.id)
				if (!shift || !target) return undefined
				return _(t`Over ${target}.`)
			},
			onDragEnd({ active: a, over }) {
				const shift = lookup(a.id)
				const target = where(over?.id)
				if (!shift) return undefined
				if (!target) return _(t`Dropped. Nothing changed.`)
				return _(t`Dropped on ${target}.`)
			},
			onDragCancel() {
				return _(t`Move cancelled. Nothing changed.`)
			},
		}
	}, [_, describeCell, i18n.locale, shifts])

	const onDragStart = useCallback((event: DragStartEvent) => {
		setActiveId(parseShiftDragId(event.active.id))
	}, [])

	const onDragEnd = useCallback(
		(event: DragEndEvent) => {
			setActiveId(null)
			const shiftId = parseShiftDragId(event.active.id)
			const shift = shiftId ? shifts.get(shiftId) : undefined
			const target = parseCellDropId(event.over?.id)
			if (!shift || !target) return
			const patch = movePatch(shift, target)
			const times = pxPerMinute
				? moveTimes(shift, (event.delta.x / pxPerMinute) * (rtl ? -1 : 1))
				: null
			if (!patch && !times) return
			onChange(shift, { expectedVersion: shift.version, ...patch, ...times })
		},
		[onChange, pxPerMinute, rtl, shifts],
	)

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={collision}
			onDragStart={onDragStart}
			onDragEnd={onDragEnd}
			onDragCancel={() => setActiveId(null)}
			accessibility={{
				announcements,
				screenReaderInstructions: {
					draggable: _(
						t`To move this shift, press Space to pick it up, use the arrow keys to choose a person and day, then press Space to drop. Press Escape to cancel. Press Enter to open it instead.`,
					),
				},
				restoreFocus: true,
			}}
		>
			{children}
			<DragOverlay dropAnimation={null}>
				{active ? (
					<div
						className={cn(
							blockClassName(
								active,
								active.positionId
									? positions.get(active.positionId)
									: undefined,
								false,
							),
							'shadow-md',
						)}
					>
						<ShiftBlockFace
							shift={active}
							position={
								active.positionId ? positions.get(active.positionId) : undefined
							}
							showConflicts={showConflicts}
							showCost={showCost}
						/>
					</div>
				) : null}
			</DragOverlay>
		</DndContext>
	)
}
