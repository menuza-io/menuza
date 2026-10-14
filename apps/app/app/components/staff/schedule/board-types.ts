import { type Forecast } from '#app/utils/staffing/labor-types.ts'
import { type UpdateShiftInput } from '#app/utils/staffing/schedule-api.ts'
import {
	type SchedulePositionRow,
	type ScheduleShiftRow,
	type ScheduleWeek,
} from '#app/utils/staffing/schedule-types.ts'
import {
	type DemandSummary,
	type ScheduleGroup,
	type ShiftClip,
	type WeekGrid,
} from '#app/utils/staffing/schedule-view.ts'

export type CellRef = { rowKey: string; date: string }

/** What every schedule view (week grid, day timeline, day list) is handed. */
export type BoardProps = {
	week: ScheduleWeek
	/** The scope's name, for the printed heading. */
	scopeName: string
	grid: WeekGrid
	positions: ReadonlyMap<string, SchedulePositionRow>
	locale: string
	rtl: boolean
	today: string
	group: ScheduleGroup
	canWrite: boolean
	showConflicts: boolean
	/** Costs show when the token carries the labor grant. */
	showCost: boolean
	demand: DemandSummary[] | null
	/** Coverage against expected orders; null without the labor grant. */
	forecast: Forecast | null
	clip: ShiftClip | null
	/** A shift whose change is in flight. */
	busyShiftId: string | null
	onOpenShift: (shift: ScheduleShiftRow) => void
	onAddShift: (cell: CellRef) => void
	onPaste: (cell: CellRef) => void
	onCopyShift: (shift: ScheduleShiftRow) => void
	onChangeShift: (shift: ScheduleShiftRow, body: UpdateShiftInput) => void
	/** Open the week view on a date (from the month view or a day heading). */
	onPickDate: (date: string, view: 'week' | 'day') => void
}
