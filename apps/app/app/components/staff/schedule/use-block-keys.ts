import { type KeyboardEvent, useCallback } from 'react'
import { type UpdateShiftInput } from '#app/utils/staffing/schedule-api.ts'
import { type ScheduleShiftRow } from '#app/utils/staffing/schedule-types.ts'
import {
	OPEN_ROW,
	resizeTimes,
	TIME_STEP_MINUTES,
} from '#app/utils/staffing/schedule-view.ts'
import { type CellRef } from './board-types.ts'

/**
 * Keyboard commands on a focused shift, shared by every schedule view:
 * Ctrl or Cmd plus C copies it, Ctrl or Cmd plus V pastes the copy into this
 * shift's person and day, and Shift plus the arrow keys changes the end by one
 * step (add Alt for the start). Up and right are later, down and left earlier.
 */
export function useBlockKeys(options: {
	canWrite: boolean
	onCopyShift: (shift: ScheduleShiftRow) => void
	onPaste: (cell: CellRef) => void
	onChangeShift: (shift: ScheduleShiftRow, body: UpdateShiftInput) => void
}) {
	const { canWrite, onCopyShift, onPaste, onChangeShift } = options
	return useCallback(
		(event: KeyboardEvent<HTMLButtonElement>, shift: ScheduleShiftRow) => {
			const mod = event.metaKey || event.ctrlKey
			const key = event.key
			if (mod && key.toLowerCase() === 'c') {
				event.preventDefault()
				onCopyShift(shift)
				return
			}
			if (!canWrite) return
			if (mod && key.toLowerCase() === 'v') {
				event.preventDefault()
				onPaste({ rowKey: shift.staffId ?? OPEN_ROW, date: shift.localDate })
				return
			}
			if (!event.shiftKey || mod) return
			const later = key === 'ArrowRight' || key === 'ArrowUp'
			const earlier = key === 'ArrowLeft' || key === 'ArrowDown'
			if (!later && !earlier) return
			event.preventDefault()
			const times = resizeTimes(
				shift,
				event.altKey ? 'start' : 'end',
				(later ? 1 : -1) * TIME_STEP_MINUTES,
			)
			if (times)
				onChangeShift(shift, { expectedVersion: shift.version, ...times })
		},
		[canWrite, onCopyShift, onPaste, onChangeShift],
	)
}
