/**
 * Time windows for the online ordering history reports (#176, #405). Pure:
 * epoch milliseconds in, epoch milliseconds out, no I/O and no guest data.
 * Shared by the missed sales estimate and the uptime report so both read the
 * same hours and the same pause history the same way.
 */

export type TimeWindow = { from: number; to: number }

/** A merged list of non-overlapping windows, sorted. */
export function mergeWindows(windows: readonly TimeWindow[]): TimeWindow[] {
	const sorted = windows
		.filter((window) => window.to > window.from)
		.map((window) => ({ ...window }))
		.sort((a, b) => a.from - b.from)
	const merged: TimeWindow[] = []
	for (const window of sorted) {
		const last = merged[merged.length - 1]
		if (last && window.from <= last.to) last.to = Math.max(last.to, window.to)
		else merged.push(window)
	}
	return merged
}

export function windowMs(windows: readonly TimeWindow[]): number {
	return mergeWindows(windows).reduce((sum, w) => sum + (w.to - w.from), 0)
}

/** The parts of `windows` that lie inside `inside` (both merged first). */
export function intersectWindows(
	windows: readonly TimeWindow[],
	inside: readonly TimeWindow[],
): TimeWindow[] {
	const a = mergeWindows(windows)
	const b = mergeWindows(inside)
	const out: TimeWindow[] = []
	let i = 0
	let j = 0
	while (i < a.length && j < b.length) {
		const from = Math.max(a[i]!.from, b[j]!.from)
		const to = Math.min(a[i]!.to, b[j]!.to)
		if (to > from) out.push({ from, to })
		if (a[i]!.to < b[j]!.to) i += 1
		else j += 1
	}
	return out
}

/** The parts of `windows` that are not inside `minus`. */
export function subtractWindows(
	windows: readonly TimeWindow[],
	minus: readonly TimeWindow[],
): TimeWindow[] {
	const cut = mergeWindows(minus)
	const out: TimeWindow[] = []
	for (const window of mergeWindows(windows)) {
		let from = window.from
		for (const hole of cut) {
			if (hole.to <= from) continue
			if (hole.from >= window.to) break
			if (hole.from > from) out.push({ from, to: hole.from })
			from = Math.max(from, hole.to)
			if (from >= window.to) break
		}
		if (from < window.to) out.push({ from, to: window.to })
	}
	return out
}

export function overlaps(a: TimeWindow, windows: readonly TimeWindow[]): boolean {
	return windows.some((w) => a.from < w.to && w.from < a.to)
}

/** Whether `inner` lies entirely inside the (merged) `windows`. */
export function isCoveredBy(
	inner: TimeWindow,
	windows: readonly TimeWindow[],
): boolean {
	return (
		windowMs(intersectWindows([inner], windows)) === inner.to - inner.from
	)
}
