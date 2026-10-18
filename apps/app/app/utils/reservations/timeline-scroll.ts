/**
 * Where the timeline grid should scroll horizontally on load. Pure so it can be
 * tested without a DOM. Today it follows the current time; other days jump to
 * the earliest booking; an empty day stays at the start.
 */
export function pickTimelineFocusMin({
	isToday,
	nowLocalMin,
	bookingStartMins,
}: {
	isToday: boolean
	nowLocalMin: number
	bookingStartMins: readonly number[]
}): number | null {
	if (isToday) return nowLocalMin
	if (bookingStartMins.length === 0) return null
	return Math.min(...bookingStartMins)
}

export function pickTimelineScrollLeft({
	focusMin,
	gridStartMin,
	gridEndMin,
	stepMin,
	slotWidthPx,
	viewportWidthPx,
	labelWidthPx,
	leadFraction = 0.25,
}: {
	focusMin: number | null
	gridStartMin: number
	gridEndMin: number
	stepMin: number
	slotWidthPx: number
	viewportWidthPx: number
	/** Width of the sticky/row-label column left of the slots. */
	labelWidthPx: number
	/** How much of the visible grid stays before the focus time. */
	leadFraction?: number
}): number {
	if (focusMin === null || viewportWidthPx <= 0) return 0
	const gridWidth = ((gridEndMin - gridStartMin) / stepMin) * slotWidthPx
	const focus = Math.min(Math.max(focusMin, gridStartMin), gridEndMin)
	const focusX = ((focus - gridStartMin) / stepMin) * slotWidthPx
	const visible = Math.max(0, viewportWidthPx - labelWidthPx)
	const target = focusX - visible * leadFraction
	const max = Math.max(0, labelWidthPx + gridWidth - viewportWidthPx)
	return Math.round(Math.min(Math.max(0, target), max))
}
