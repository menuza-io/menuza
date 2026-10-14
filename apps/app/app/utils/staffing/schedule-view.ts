import {
	addDays,
	dayOfWeek,
	hhmmFromMinuteOfDay,
	localMinuteOfDay,
	weekStartFor,
} from '@repo/staffing'
import {
	type ScheduleDemand,
	type ScheduleOverlayRow,
	type SchedulePersonRow,
	type SchedulePositionRow,
	type ScheduleShiftRow,
	type ScheduleWeek,
} from './schedule-types.ts'
import { staffDisplayName } from './staff-format.ts'
import { isValidDate } from './timesheet-view.ts'

/**
 * Pure helpers behind the schedule screens: the address bar, how a week is laid
 * out as people by days, drag and resize arithmetic, copy and paste, the demand
 * strip and the backfill ranking. Nothing here touches the network, the DOM or
 * a clock, so each rule has a unit test.
 */

// ---------------------------------------------------------------------------
// Address bar state
// ---------------------------------------------------------------------------

export const SCHEDULE_VIEWS = ['week', 'day', 'month'] as const
export type ScheduleViewName = (typeof SCHEDULE_VIEWS)[number]

export const SCHEDULE_GROUPS = ['position', 'none'] as const
export type ScheduleGroup = (typeof SCHEDULE_GROUPS)[number]

export type ScheduleSearch = {
	view: ScheduleViewName
	/** Any date in the period on screen; the server snaps it to the workweek. */
	date: string
	/** A scope id, or empty until the first scope is chosen. */
	scopeId: string
	group: ScheduleGroup
	/** "Show conflicts": the red flags on shifts and the conflict summary. */
	conflicts: boolean
}

function pick<T extends string>(
	value: string | null,
	allowed: readonly T[],
	fallback: T,
): T {
	return value !== null && (allowed as readonly string[]).includes(value)
		? (value as T)
		: fallback
}

export function parseScheduleSearch(
	params: URLSearchParams,
	today: string,
	defaultScopeId: string,
): ScheduleSearch {
	const date = params.get('date')
	return {
		view: pick(params.get('view'), SCHEDULE_VIEWS, 'week'),
		date: isValidDate(date) ? date : today,
		scopeId: params.get('scope') || defaultScopeId,
		group: pick(params.get('group'), SCHEDULE_GROUPS, 'position'),
		// Conflicts show by default; the toggle is for a quieter, print-ready grid.
		conflicts: params.get('conflicts') !== 'off',
	}
}

/** Writes `patch` over the address bar, leaving defaults out of it. */
export function writeScheduleSearch(
	current: URLSearchParams,
	patch: Partial<ScheduleSearch>,
	today: string,
	defaultScopeId: string,
): URLSearchParams {
	const next = {
		...parseScheduleSearch(current, today, defaultScopeId),
		...patch,
	}
	const out = new URLSearchParams()
	if (next.view !== 'week') out.set('view', next.view)
	if (next.date !== today) out.set('date', next.date)
	if (next.scopeId && next.scopeId !== defaultScopeId) {
		out.set('scope', next.scopeId)
	}
	if (next.group !== 'position') out.set('group', next.group)
	if (!next.conflicts) out.set('conflicts', 'off')
	return out
}

// ---------------------------------------------------------------------------
// Dates and clocks
// ---------------------------------------------------------------------------

/** The step shifts snap to, in minutes. */
export const TIME_STEP_MINUTES = 15

export function snapMinutes(minutes: number, step = TIME_STEP_MINUTES): number {
	return Math.round(minutes / step) * step
}

/** Every start or end time offered in the editor: `00:00` to `23:45`. */
export function timeSteps(step = TIME_STEP_MINUTES): string[] {
	const out: string[] = []
	for (let minute = 0; minute < 1440; minute += step) {
		out.push(hhmmFromMinuteOfDay(minute))
	}
	return out
}

/** `HH:MM` for a minute of the day, wrapping 24:00 to 00:00 (the next day's midnight). */
export function hhmmWrapped(minute: number): string {
	return hhmmFromMinuteOfDay(((minute % 1440) + 1440) % 1440)
}

/** The first date of the workweek holding `date`. */
export function weekStartOf(date: string, weekStartsOn: number): string {
	return weekStartFor(date, weekStartsOn)
}

/** The seven dates of the week starting `weekStart`. */
export function sevenDays(weekStart: string): string[] {
	return Array.from({ length: 7 }, (ignored, index) =>
		addDays(weekStart, index),
	)
}

/** Shifts that cross midnight run into the next local date. */
export function isOvernight(shift: {
	startsAt: number
	endsAt: number
	timeZone: string
	localDate: string
}): boolean {
	return (
		localMinuteOfDay(shift.endsAt, shift.timeZone) <=
			localMinuteOfDay(shift.startsAt, shift.timeZone) ||
		shift.endsAt - shift.startsAt >= 24 * 3_600_000
	)
}

function clockFormat(locale: string, timeZone: string, minutes: boolean) {
	try {
		return new Intl.DateTimeFormat(locale, {
			hour: 'numeric',
			...(minutes ? { minute: '2-digit' } : {}),
			timeZone,
		})
	} catch {
		return new Intl.DateTimeFormat(locale, {
			hour: 'numeric',
			...(minutes ? { minute: '2-digit' } : {}),
			timeZone: 'UTC',
		})
	}
}

/** "9 AM" or "9:30 AM" in the workplace's time zone, in the viewer's language. */
export function formatClock(
	at: number,
	timeZone: string,
	locale: string,
): string {
	const minutes = localMinuteOfDay(at, timeZone) % 60 !== 0
	return clockFormat(locale, timeZone, minutes).format(at)
}

/** "6 PM" for the hour 18, in the viewer's language (a wall-clock hour, not an instant). */
export function formatHourOfDay(hour: number, locale: string): string {
	try {
		return new Intl.DateTimeFormat(locale, {
			hour: 'numeric',
			timeZone: 'UTC',
		}).format(Date.UTC(2000, 0, 1, hour))
	} catch {
		return `${hour}:00`
	}
}

/** "9:30 AM" for `09:30`, for a time picker's options (a wall-clock time, not an instant). */
export function formatHhmm(value: string, locale: string): string {
	const [h = 0, m = 0] = value.split(':').map(Number)
	try {
		return new Intl.DateTimeFormat(locale, {
			hour: 'numeric',
			minute: '2-digit',
			timeZone: 'UTC',
		}).format(Date.UTC(2000, 0, 1, h, m))
	} catch {
		return value
	}
}

/** "9 AM – 5 PM". The caller wraps it in `<bdi>` so Arabic layouts keep the order. */
export function formatShiftRange(
	shift: Pick<ScheduleShiftRow, 'startsAt' | 'endsAt' | 'timeZone'>,
	locale: string,
): string {
	return `${formatClock(shift.startsAt, shift.timeZone, locale)} – ${formatClock(shift.endsAt, shift.timeZone, locale)}`
}

/** "2h 30m" for 150, "8h" for 480, "45m" for 45. */
export function formatDuration(minutes: number): string {
	const total = Math.max(0, Math.round(minutes))
	const h = Math.floor(total / 60)
	const m = total % 60
	if (h === 0) return `${m}m`
	return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/** The local start and end a shift was entered with, as the editor shows them. */
export function shiftTimes(shift: {
	startsAt: number
	endsAt: number
	timeZone: string
}): { startTime: string; endTime: string } {
	return {
		startTime: hhmmFromMinuteOfDay(
			localMinuteOfDay(shift.startsAt, shift.timeZone),
		),
		endTime: hhmmFromMinuteOfDay(
			localMinuteOfDay(shift.endsAt, shift.timeZone),
		),
	}
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/** Where a drop lands: a person's day, or an open shift on a day. */
export const OPEN_ROW = 'open'

export type GridRow = {
	/** The staff id, or `open`. */
	key: string
	person: SchedulePersonRow | null
	/** Shifts by local date. */
	cells: Map<string, ScheduleShiftRow[]>
}

export type GridGroup = {
	key: string
	position: SchedulePositionRow | null
	rows: GridRow[]
}

export type WeekGrid = {
	open: GridRow
	groups: GridGroup[]
	/** People on the roster for this scope who are not shown (hidden from the schedule). */
	hiddenCount: number
}

function sortShifts(shifts: ScheduleShiftRow[]): ScheduleShiftRow[] {
	return shifts.sort(
		(a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id),
	)
}

function cellsOf(shifts: readonly ScheduleShiftRow[]) {
	const cells = new Map<string, ScheduleShiftRow[]>()
	for (const shift of shifts) {
		const list = cells.get(shift.localDate) ?? []
		list.push(shift)
		cells.set(shift.localDate, list)
	}
	for (const list of cells.values()) sortShifts(list)
	return cells
}

/**
 * Lay a week out as people by days. Everyone shown on the schedule gets a row,
 * even with no shifts (so a shift can be dropped on them); a person hidden from
 * the schedule or no longer working here appears only while they still hold a
 * shift this week. Groups follow the position order the server sends.
 */
export function buildGrid(
	week: ScheduleWeek,
	options: { group: ScheduleGroup; locale: string },
): WeekGrid {
	const byStaff = new Map<string, ScheduleShiftRow[]>()
	const openShifts: ScheduleShiftRow[] = []
	for (const shift of week.shifts) {
		if (shift.staffId === null) {
			openShifts.push(shift)
			continue
		}
		const list = byStaff.get(shift.staffId) ?? []
		list.push(shift)
		byStaff.set(shift.staffId, list)
	}

	const order = new Map(
		week.positions.map((position, index) => [position.id, index]),
	)
	const positionById = new Map(
		week.positions.map((position) => [position.id, position]),
	)
	let hiddenCount = 0
	const visible = week.people.filter((person) => {
		const holds = byStaff.has(person.id)
		const shown = person.showInSchedule && person.status !== 'terminated'
		if (!shown && !holds) hiddenCount += 1
		return shown || holds
	})

	const primaryPosition = (person: SchedulePersonRow): string | null => {
		let best: string | null = null
		let bestIndex = Number.POSITIVE_INFINITY
		for (const positionId of person.positionIds) {
			const index = order.get(positionId)
			if (index !== undefined && index < bestIndex) {
				best = positionId
				bestIndex = index
			}
		}
		return best
	}

	const nameOf = (person: SchedulePersonRow) =>
		staffDisplayName(person, options.locale)
	const rowOf = (person: SchedulePersonRow): GridRow => ({
		key: person.id,
		person,
		cells: cellsOf(byStaff.get(person.id) ?? []),
	})
	const compare = (a: GridRow, b: GridRow) =>
		nameOf(a.person!).localeCompare(nameOf(b.person!), options.locale) ||
		a.key.localeCompare(b.key)

	const groups: GridGroup[] = []
	if (options.group === 'none') {
		groups.push({
			key: 'all',
			position: null,
			rows: visible.map(rowOf).sort(compare),
		})
	} else {
		const buckets = new Map<string | null, GridRow[]>()
		for (const person of visible) {
			const key = primaryPosition(person)
			const list = buckets.get(key) ?? []
			list.push(rowOf(person))
			buckets.set(key, list)
		}
		for (const position of week.positions) {
			const rows = buckets.get(position.id)
			if (rows) {
				groups.push({
					key: position.id,
					position: positionById.get(position.id) ?? null,
					rows: rows.sort(compare),
				})
			}
		}
		const rest = buckets.get(null)
		if (rest)
			groups.push({ key: 'none', position: null, rows: rest.sort(compare) })
	}

	return {
		open: { key: OPEN_ROW, person: null, cells: cellsOf(openShifts) },
		groups: groups.filter((group) => group.rows.length > 0),
		hiddenCount,
	}
}

export type CellNotes = {
	timeOff: 'approved' | 'pending' | null
	/** An all-day "unavailable" window covers the date. */
	unavailable: boolean
}

/** What the person's time off and availability say about one date, for the cell background. */
export function cellNotes(
	overlay: ScheduleOverlayRow | undefined,
	date: string,
): CellNotes {
	const out: CellNotes = { timeOff: null, unavailable: false }
	if (!overlay) return out
	for (const entry of overlay.timeOff) {
		if (date < entry.startDate || date > entry.endDate) continue
		if (entry.status === 'approved') out.timeOff = 'approved'
		else if (out.timeOff === null) out.timeOff = 'pending'
	}
	const weekday = dayOfWeek(date)
	out.unavailable = overlay.availability.some((row) => {
		if (row.availability !== 'unavailable' || !row.allDay) return false
		if (row.kind === 'one_off') return row.date === date
		if (row.weekday !== weekday) return false
		if (row.effectiveFrom && date < row.effectiveFrom) return false
		if (row.effectiveTo && date > row.effectiveTo) return false
		return true
	})
	return out
}

/** Shifts with at least one warning, in time order. */
export function conflictedShifts(week: ScheduleWeek): ScheduleShiftRow[] {
	return sortShifts(week.shifts.filter((shift) => shift.conflicts.length > 0))
}

/** Shifts waiting to be published: drafts, edited and about to be removed. */
export function unpublishedShifts(week: ScheduleWeek): ScheduleShiftRow[] {
	return week.shifts.filter((shift) => shift.state !== 'published')
}

export type PublishSummary = {
	created: number
	changed: number
	removed: number
	/** Unpublished shifts that carry warnings (they never block publishing). */
	warned: number
	total: number
	/** Shifts that will be live after publishing (open shifts included). */
	liveShifts: number
	openShifts: number
	/** Scheduled minutes of the whole week as it will stand. */
	minutes: number
	/** Shifts with a warning anywhere in the week, published or not. */
	conflicted: number
	/** Estimated labor cost by currency; absent without the labor grant. */
	costMinorByCurrency?: Record<string, number>
}

export type RecipientEstimate = {
	/** People the chosen mode would tell. */
	people: number
}

/**
 * How many people a notify mode would tell, from the week on screen: with
 * `changed`, whoever has a new, edited or removed shift (and whoever loses one
 * to someone else); with `everyone`, also everyone else working the week.
 */
export function estimateRecipients(
	week: ScheduleWeek,
	mode: 'everyone' | 'changed' | 'nobody',
): RecipientEstimate {
	if (mode === 'nobody') return { people: 0 }
	const told = new Set<string>()
	for (const shift of week.shifts) {
		if (shift.state === 'published') {
			if (mode === 'everyone' && shift.staffId) told.add(shift.staffId)
			continue
		}
		if (shift.state === 'cancel_pending') {
			if (shift.staffId) told.add(shift.staffId)
			continue
		}
		if (shift.staffId) told.add(shift.staffId)
		const before = shift.published?.staffId
		if (before) told.add(before)
	}
	return { people: told.size }
}

/** What the Publish button is about to send, by kind. */
export function summarizePublish(week: ScheduleWeek): PublishSummary {
	const live = week.shifts.filter((shift) => shift.state !== 'cancel_pending')
	const out: PublishSummary = {
		created: 0,
		changed: 0,
		removed: 0,
		warned: 0,
		total: 0,
		liveShifts: live.length,
		openShifts: live.filter((shift) => !shift.staffId).length,
		minutes: week.totals.minutes,
		conflicted: week.shifts.filter((shift) => shift.conflicts.length > 0)
			.length,
		...(week.totals.costMinorByCurrency
			? { costMinorByCurrency: week.totals.costMinorByCurrency }
			: {}),
	}
	for (const shift of unpublishedShifts(week)) {
		out.total += 1
		if (shift.state === 'draft') out.created += 1
		else if (shift.state === 'changed') out.changed += 1
		else if (shift.state === 'cancel_pending') out.removed += 1
		if (shift.conflicts.length > 0) out.warned += 1
	}
	return out
}

/** The footer for a date, or zeros while the week loads. */
export function footerFor(week: ScheduleWeek, date: string) {
	return (
		week.footers.find((footer) => footer.date === date) ?? {
			date,
			minutes: 0,
			overtimeMinutes: 0,
			headcount: 0,
			openShifts: 0,
			openMinutes: 0,
		}
	)
}

// ---------------------------------------------------------------------------
// Drag, resize, copy and paste
// ---------------------------------------------------------------------------

export const shiftDragId = (shiftId: string) => `shift:${shiftId}`
export const cellDropId = (rowKey: string, date: string) =>
	`cell:${rowKey}:${date}`

export function parseShiftDragId(value: unknown): string | null {
	return typeof value === 'string' && value.startsWith('shift:')
		? value.slice('shift:'.length)
		: null
}

export function parseCellDropId(
	value: unknown,
): { rowKey: string; date: string } | null {
	if (typeof value !== 'string' || !value.startsWith('cell:')) return null
	const [rowKey, date] = value.slice('cell:'.length).split(':')
	return rowKey && date && isValidDate(date) ? { rowKey, date } : null
}

export type ShiftPatch = {
	expectedVersion: number
	date?: string
	staffId?: string | null
}

/**
 * What changes when `shift` is dropped on a cell: its day and its person. The
 * times stay as entered. Null when nothing would change.
 */
export function movePatch(
	shift: ScheduleShiftRow,
	target: { rowKey: string; date: string },
): ShiftPatch | null {
	const staffId = target.rowKey === OPEN_ROW ? null : target.rowKey
	const patch: ShiftPatch = { expectedVersion: shift.version }
	if (target.date !== shift.localDate) patch.date = target.date
	if (staffId !== shift.staffId) patch.staffId = staffId
	return patch.date === undefined && patch.staffId === undefined ? null : patch
}

/** The cell one step away from `from`, for keyboard moves. Null at an edge. */
export function neighborCell(
	from: { rowKey: string; date: string },
	direction: 'left' | 'right' | 'up' | 'down',
	context: {
		dates: readonly string[]
		rowKeys: readonly string[]
		rtl: boolean
	},
): { rowKey: string; date: string } | null {
	const dateIndex = context.dates.indexOf(from.date)
	const rowIndex = context.rowKeys.indexOf(from.rowKey)
	if (dateIndex < 0 || rowIndex < 0) return null
	// The grid mirrors in Arabic, so "right" on the keyboard is the earlier day.
	const step = direction === 'left' ? -1 : direction === 'right' ? 1 : 0
	const dayStep = context.rtl ? -step : step
	if (direction === 'left' || direction === 'right') {
		const date = context.dates[dateIndex + dayStep]
		return date ? { rowKey: from.rowKey, date } : null
	}
	const row = context.rowKeys[rowIndex + (direction === 'up' ? -1 : 1)]
	return row ? { rowKey: row, date: from.date } : null
}

/**
 * A shift's length on the wall clock, in minutes (an end at or before the start
 * is the next day). Edits are made in local times, so arithmetic must use this
 * and not the elapsed time: across a clock change the two differ by an hour,
 * and carrying the elapsed length over would move the end by that hour.
 */
export function wallLengthMinutes(shift: {
	startsAt: number
	endsAt: number
	timeZone: string
}): number {
	const start = localMinuteOfDay(shift.startsAt, shift.timeZone)
	const end = localMinuteOfDay(shift.endsAt, shift.timeZone)
	const span = (((end - start) % 1440) + 1440) % 1440
	return span === 0 ? 1440 : span
}

export type TimeEdge = 'start' | 'end'

/**
 * New local times after moving one edge of a shift by `deltaMinutes` (snapped to
 * the step). A shift keeps at least one step of length and may run past
 * midnight (an end at or before the start is the next day). Null when nothing
 * would change.
 */
export function resizeTimes(
	shift: Pick<ScheduleShiftRow, 'startsAt' | 'endsAt' | 'timeZone'>,
	edge: TimeEdge,
	deltaMinutes: number,
	step = TIME_STEP_MINUTES,
): { startTime: string; endTime: string } | null {
	const startMinute = localMinuteOfDay(shift.startsAt, shift.timeZone)
	const length = wallLengthMinutes(shift)
	const delta = snapMinutes(deltaMinutes, step)
	if (delta === 0) return null
	let nextStart = startMinute
	let nextLength = length
	if (edge === 'end') {
		nextLength = Math.max(step, snapMinutes(length + delta, step))
	} else {
		const moved = Math.min(delta, length - step)
		nextStart = startMinute + moved
		nextLength = length - moved
	}
	// A shift never runs past a day and an hour.
	nextLength = Math.min(nextLength, 24 * 60)
	const current = shiftTimes(shift)
	const times = {
		startTime: hhmmWrapped(nextStart),
		endTime: hhmmWrapped(nextStart + nextLength),
	}
	return times.startTime === current.startTime &&
		times.endTime === current.endTime
		? null
		: times
}

export type ShiftClip = {
	positionId: string | null
	startTime: string
	endTime: string
	unpaidBreakMinutes: number
	notes: string | null
	/** Who held the shift; paste keeps them unless a row is chosen. */
	staffId: string | null
}

export function clipFromShift(shift: ScheduleShiftRow): ShiftClip {
	return {
		positionId: shift.positionId,
		...shiftTimes(shift),
		unpaidBreakMinutes: shift.unpaidBreakMinutes,
		notes: shift.notes,
		staffId: shift.staffId,
	}
}

/** The create request that pastes `clip` onto a cell. */
export function pasteBody(
	clip: ShiftClip,
	target: { rowKey: string; date: string },
	scopeId: string,
) {
	return {
		scopeId,
		staffId: target.rowKey === OPEN_ROW ? null : target.rowKey,
		positionId: clip.positionId,
		dates: [target.date],
		startTime: clip.startTime,
		endTime: clip.endTime,
		unpaidBreakMinutes: clip.unpaidBreakMinutes,
		notes: clip.notes,
	}
}

/**
 * New local times after sliding a whole shift by `deltaMinutes` (snapped). The
 * start stays inside its day (0:00 to 23:45) and the length is kept, so a shift
 * dragged late in the day runs into the next morning rather than changing date.
 * Null when nothing would change.
 */
export function moveTimes(
	shift: Pick<ScheduleShiftRow, 'startsAt' | 'endsAt' | 'timeZone'>,
	deltaMinutes: number,
	step = TIME_STEP_MINUTES,
): { startTime: string; endTime: string } | null {
	const delta = snapMinutes(deltaMinutes, step)
	if (delta === 0) return null
	const startMinute = localMinuteOfDay(shift.startsAt, shift.timeZone)
	const length = wallLengthMinutes(shift)
	const nextStart = Math.min(Math.max(startMinute + delta, 0), 1440 - step)
	const times = {
		startTime: hhmmWrapped(nextStart),
		endTime: hhmmWrapped(nextStart + length),
	}
	const current = shiftTimes(shift)
	return times.startTime === current.startTime &&
		times.endTime === current.endTime
		? null
		: times
}

/** A position's name in the viewer's language. */
export function positionName(
	position: Pick<SchedulePositionRow, 'name' | 'nameAr'> | null | undefined,
	locale: string,
): string {
	if (!position) return ''
	return locale.startsWith('ar') && position.nameAr
		? position.nameAr
		: position.name
}

// ---------------------------------------------------------------------------
// Demand strip
// ---------------------------------------------------------------------------

export type DemandSummary = {
	date: string
	totalOrders: number
	/** Bar heights for the 24 hours, 0 to 1 against the busiest hour of the week. */
	bars: number[]
	/** The busiest local hour, or null on a quiet day. */
	peakHour: number | null
	peakOrders: number
}

/** Scale each day against the week's busiest hour so days compare at a glance. */
export function summarizeDemand(demand: ScheduleDemand): DemandSummary[] {
	let max = 0
	for (const day of demand.days)
		for (const hour of day.hours) max = Math.max(max, hour)
	return demand.days.map((day) => {
		let peakHour: number | null = null
		let peakOrders = 0
		day.hours.forEach((orders, hour) => {
			if (orders > peakOrders) {
				peakOrders = orders
				peakHour = hour
			}
		})
		return {
			date: day.date,
			totalOrders: day.totalOrders,
			bars: day.hours.map((orders) => (max > 0 ? orders / max : 0)),
			peakHour,
			peakOrders,
		}
	})
}

/** Local hours of a shift (start inclusive), for placing it against the strip. */
export function shiftHours(shift: ScheduleShiftRow): {
	from: number
	to: number
} {
	const from = localMinuteOfDay(shift.startsAt, shift.timeZone) / 60
	const length = (shift.endsAt - shift.startsAt) / 3_600_000
	return { from, to: Math.min(24, from + length) }
}

// ---------------------------------------------------------------------------
// Backfill suggestions
// ---------------------------------------------------------------------------

export type BackfillStatus =
	'available' | 'unknown' | 'outside' | 'unavailable' | 'time_off' | 'overlap'

export type BackfillCandidate = {
	person: SchedulePersonRow
	status: BackfillStatus
	/** Paid minutes this week before and after taking the shift. */
	weekMinutes: number
	afterMinutes: number
	/** Already over, or reaching, overtime this week. */
	overtime: boolean
}

const BLOCKED: ReadonlySet<BackfillStatus> = new Set<BackfillStatus>([
	'unavailable',
	'time_off',
	'overlap',
])

export function isBlockedStatus(status: BackfillStatus): boolean {
	return BLOCKED.has(status)
}

function minuteWindow(row: {
	allDay: boolean
	startMinute: number | null
	endMinute: number | null
}): [number, number] {
	return row.allDay ? [0, 1440] : [row.startMinute ?? 0, row.endMinute ?? 1440]
}

/**
 * People who could take `shift`, best first: those who said they are available,
 * then those with no preference, each with the fewest hours this week first and
 * anyone nearing overtime last. People who cannot (time off, a clash, a blocked
 * window) come after, flagged. This is a guide: the server still reports
 * conflicts when the shift is assigned.
 */
export function rankBackfill(input: {
	shift: ScheduleShiftRow
	week: ScheduleWeek
	/** Include people who are blocked, so the manager sees why they are not offered. */
	includeBlocked?: boolean
}): BackfillCandidate[] {
	const { shift, week } = input
	const date = shift.localDate
	const weekday = dayOfWeek(date)
	const startMinute = localMinuteOfDay(shift.startsAt, shift.timeZone)
	const length = Math.round((shift.endsAt - shift.startsAt) / 60_000)
	const endMinute = Math.min(1440, startMinute + length)
	const overlays = new Map(
		week.overlays.map((overlay) => [overlay.staffId, overlay]),
	)

	const out: BackfillCandidate[] = []
	for (const person of week.people) {
		if (person.id === shift.staffId) continue
		if (person.status === 'terminated') continue
		if (shift.positionId && !person.positionIds.includes(shift.positionId))
			continue
		if (shift.staffId === null && !person.eligibleOpenShifts) continue

		let status: BackfillStatus = 'unknown'
		const overlay = overlays.get(person.id)

		const onTimeOff = overlay?.timeOff.some((entry) => {
			if (entry.status !== 'approved') return false
			if (date < entry.startDate || date > entry.endDate) return false
			if (entry.allDay) return true
			const [from, to] = minuteWindow(entry)
			return from < endMinute && to > startMinute
		})
		const clash = week.shifts.some(
			(other) =>
				other.id !== shift.id &&
				other.staffId === person.id &&
				other.state !== 'cancel_pending' &&
				other.startsAt < shift.endsAt &&
				other.endsAt > shift.startsAt,
		)
		if (onTimeOff) status = 'time_off'
		else if (clash) status = 'overlap'
		else if (overlay) {
			const rows = overlay.availability.filter((row) => {
				if (row.kind === 'one_off') return row.date === date
				if (row.weekday !== weekday) return false
				if (row.effectiveFrom && date < row.effectiveFrom) return false
				if (row.effectiveTo && date > row.effectiveTo) return false
				return true
			})
			const blocked = rows.some((row) => {
				if (row.availability !== 'unavailable') return false
				const [from, to] = minuteWindow(row)
				return from < endMinute && to > startMinute
			})
			const windows = rows.filter((row) => row.availability === 'available')
			if (blocked) status = 'unavailable'
			else if (windows.length > 0) {
				status = windows.some((row) => {
					const [from, to] = minuteWindow(row)
					return from <= startMinute && to >= endMinute
				})
					? 'available'
					: 'outside'
			}
		}

		if (!input.includeBlocked && BLOCKED.has(status)) continue
		out.push({
			person,
			status,
			weekMinutes: person.weekMinutes,
			afterMinutes: person.weekMinutes + shift.paidMinutes,
			overtime: person.overtimeMinutes > 0,
		})
	}

	const tier = (candidate: BackfillCandidate): number => {
		switch (candidate.status) {
			case 'available':
				return 0
			case 'unknown':
				return 1
			case 'outside':
				return 2
			default:
				return 3
		}
	}
	return out.sort(
		(a, b) =>
			tier(a) - tier(b) ||
			Number(a.overtime) - Number(b.overtime) ||
			a.weekMinutes - b.weekMinutes ||
			a.person.id.localeCompare(b.person.id),
	)
}

// ---------------------------------------------------------------------------
// Month view
// ---------------------------------------------------------------------------

/** The week starts (first dates) a month grid needs, from the first to the last visible week. */
export function monthWeekStarts(date: string, weekStartsOn: number): string[] {
	const first = `${date.slice(0, 7)}-01`
	const start = weekStartFor(first, weekStartsOn)
	const lastOfMonth = addDays(`${nextMonthKey(date)}-01`, -1)
	const out: string[] = []
	for (let cursor = start; cursor <= lastOfMonth; cursor = addDays(cursor, 7)) {
		out.push(cursor)
	}
	return out
}

function nextMonthKey(date: string): string {
	const year = Number(date.slice(0, 4))
	const month = Number(date.slice(5, 7))
	return month === 12
		? `${String(year + 1).padStart(4, '0')}-01`
		: `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}`
}

/** The first of the previous or next month, for the month view's arrows. */
export function shiftMonth(date: string, months: number): string {
	const year = Number(date.slice(0, 4))
	const month = Number(date.slice(5, 7)) - 1 + months
	const y = year + Math.floor(month / 12)
	const m = ((month % 12) + 12) % 12
	return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-01`
}
