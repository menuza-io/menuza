/**
 * Fits a drawn room to the space it has. The plan has coordinates, so it is
 * scaled to fill the pane instead of keeping the manager's canvas size: the
 * tables and fixtures (the content, not the empty canvas around them) are
 * scaled as large as fits, a table never draws smaller than `minTable` px (it
 * grows around its own centre), and only a room that cannot fit at a size a
 * finger can hit is left to pan. Pure, so it is tested apart from the screen.
 */

export type Rect = { x: number; y: number; w: number; h: number }

export type FitTable = Rect & { id: string }

export type PlacedPx = {
	left: number
	top: number
	width: number
	height: number
}

export type RoomFit = {
	/** Pixels per plan unit. */
	scale: number
	/** The plan's size in pixels (what is drawn, bigger than the pane when it pans). */
	width: number
	height: number
	/** The room cannot fit at the smallest usable size: it scrolls in the pane. */
	scrolls: boolean
	tables: Map<string, PlacedPx>
	extras: PlacedPx[]
}

/** A table is never drawn smaller than this (about a fingertip and a name). */
export const MIN_TABLE_PX = 72
/** Below this the plan stops shrinking to fit and pans instead. */
export const SOFT_MIN_TABLE_PX = 48
/** No table is blown up past this, however small the room. */
const MAX_TABLE_PX = 120

/** A pane narrower than this gets a smaller fingertip (a phone has the width for no more). */
const NARROW_PANE_PX = 560
const NARROW_MIN_TABLE_PX = 56
const NARROW_SOFT_MIN_TABLE_PX = 36

export function fitRoom({
	tables,
	extras,
	frame,
	minTable: minTableOption,
	softMin: softMinOption,
}: {
	tables: FitTable[]
	extras: Rect[]
	frame: { w: number; h: number }
	minTable?: number
	softMin?: number
}): RoomFit {
	const narrow = frame.w < NARROW_PANE_PX
	const minTable =
		minTableOption ?? (narrow ? NARROW_MIN_TABLE_PX : MIN_TABLE_PX)
	const softMin =
		softMinOption ?? (narrow ? NARROW_SOFT_MIN_TABLE_PX : SOFT_MIN_TABLE_PX)
	const smallest = tables.length
		? Math.max(1, Math.min(...tables.map((t) => Math.min(t.w, t.h))))
		: 80
	const maxScale = MAX_TABLE_PX / smallest
	const minScale = Math.min(1.5, Math.max(0.3, softMin / smallest))

	if (tables.length + extras.length === 0 || frame.w <= 0 || frame.h <= 0)
		return {
			scale: 1,
			width: Math.max(frame.w, 0),
			height: Math.max(frame.h, 0),
			scrolls: false,
			tables: new Map(),
			extras: [],
		}

	/**
	 * The room at the largest scale that fits, counting these fixtures. The
	 * content is drawn at a scale with each table grown to the minimum around
	 * its centre; growing a small table widens the content, which lowers the
	 * scale a little, so it settles over a few passes.
	 */
	const attempt = (counted: Rect[]) => {
		const layout = (scale: number) => {
			const placedTables = tables.map((t) => {
				const width = Math.max(t.w * scale, minTable)
				const height = Math.max(t.h * scale, minTable)
				return {
					id: t.id,
					left: (t.x + t.w / 2) * scale - width / 2,
					top: (t.y + t.h / 2) * scale - height / 2,
					width,
					height,
				}
			})
			const placedExtras = extras.map((e) => ({
				left: e.x * scale,
				top: e.y * scale,
				width: e.w * scale,
				height: e.h * scale,
			}))
			// Only what is counted decides the plan's extent.
			const counts = [
				...placedTables,
				...placedExtras.filter((_, i) => counted.includes(extras[i]!)),
			]
			const x0 = Math.min(...counts.map((p) => p.left))
			const y0 = Math.min(...counts.map((p) => p.top))
			const x1 = Math.max(...counts.map((p) => p.left + p.width))
			const y1 = Math.max(...counts.map((p) => p.top + p.height))
			return { placedTables, placedExtras, x0, y0, x1, y1 }
		}
		let scale = 1
		for (let i = 0; i < 8; i += 1) {
			const { x0, y0, x1, y1 } = layout(scale)
			const next =
				scale *
				Math.min(frame.w / Math.max(x1 - x0, 1), frame.h / Math.max(y1 - y0, 1))
			if (Math.abs(next - scale) < 0.001) {
				scale = next
				break
			}
			scale = next
		}
		return { scale: Math.min(scale, maxScale), layout }
	}

	// Tables and fixtures together; when that is too small to use, the tables
	// alone (a wide bar may then run off the edge) before the room pans.
	let chosen = attempt(extras)
	if (chosen.scale < minScale && extras.length > 0) {
		const tablesOnly = attempt([])
		if (tablesOnly.scale >= minScale) chosen = tablesOnly
	}
	let { scale } = chosen
	let scrolls = false
	if (scale < minScale) {
		scale = minScale
		scrolls = true
		chosen = attempt(extras)
	}
	const { placedTables, placedExtras, x0, y0, x1, y1 } = chosen.layout(scale)
	const shift = (p: PlacedPx): PlacedPx => ({
		...p,
		left: p.left - x0,
		top: p.top - y0,
	})
	return {
		scale,
		width: x1 - x0,
		height: y1 - y0,
		scrolls,
		tables: new Map(placedTables.map((p) => [p.id, shift(p)])),
		extras: placedExtras.map(shift),
	}
}
