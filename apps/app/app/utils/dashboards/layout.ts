import { verticalCompactor } from 'react-grid-layout/core'
import {
	BLOCK_DEFINITIONS,
	blockSizeLimits,
	DASHBOARD_BREAKPOINTS,
	DASHBOARD_COLS,
	type BlockType,
	type DashboardBlock,
	type DashboardBreakpoint,
	type DashboardConfig,
	type DashboardLayouts,
	type GridItem,
	type PersistedBreakpoint,
} from './config.ts'

type Position = { x: number; y: number }

export type GridLayouts = Record<DashboardBreakpoint, GridItem[]>

function compareByPosition(a: Position, b: Position) {
	return a.y - b.y || a.x - b.x
}

function overlapsRows(a: GridItem, b: GridItem) {
	return a.y < b.y + b.h && b.y < a.y + a.h
}

function collides(a: GridItem, b: GridItem) {
	return a.i !== b.i && a.x < b.x + b.w && b.x < a.x + a.w && overlapsRows(a, b)
}

function mapLayouts(
	fn: (breakpoint: PersistedBreakpoint) => GridItem[],
): DashboardLayouts {
	return { lg: fn('lg'), md: fn('md') }
}

/** The first free row below every item of the layout. */
export function layoutBottom(layout: readonly GridItem[]) {
	return layout.reduce((bottom, item) => Math.max(bottom, item.y + item.h), 0)
}

/** Keeps only the fields we persist, dropping react-grid-layout extras. */
export function toGridItems<T extends GridItem>(
	layout: readonly T[],
): GridItem[] {
	return layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))
}

/** Adds a block at the bottom of every breakpoint with its default size. */
export function appendBlock(
	config: DashboardConfig,
	block: DashboardBlock,
): DashboardConfig {
	const { defaultSize } = BLOCK_DEFINITIONS[block.type]
	return {
		...config,
		blocks: [...config.blocks, block],
		layouts: mapLayouts((breakpoint) => [
			...config.layouts[breakpoint],
			{
				i: block.id,
				x: 0,
				y: layoutBottom(config.layouts[breakpoint]),
				w: defaultSize[breakpoint].w,
				h: defaultSize[breakpoint].h,
			},
		]),
	}
}

export function removeBlock(
	config: DashboardConfig,
	blockId: string,
): DashboardConfig {
	return {
		...config,
		blocks: config.blocks.filter((block) => block.id !== blockId),
		layouts: mapLayouts((breakpoint) =>
			config.layouts[breakpoint].filter((item) => item.i !== blockId),
		),
	}
}

/**
 * Flips x positions for right-to-left locales. The grid itself always runs
 * left to right, so layouts are mirrored for display and unmirrored on save.
 */
export function mirrorLayout<T extends GridItem>(
	layout: readonly T[],
	cols: number,
): T[] {
	return layout.map((item) => ({
		...item,
		x: Math.max(0, cols - item.x - item.w),
	}))
}

export function unmirrorLayout<T extends GridItem>(
	layout: readonly T[],
	cols: number,
): T[] {
	return mirrorLayout(layout, cols)
}

export function mirrorLayouts(layouts: DashboardLayouts): DashboardLayouts {
	return mapLayouts((breakpoint) =>
		mirrorLayout(layouts[breakpoint], DASHBOARD_COLS[breakpoint]),
	)
}

export function unmirrorLayouts(layouts: DashboardLayouts): DashboardLayouts {
	return mirrorLayouts(layouts)
}

export function mirrorGridLayouts(layouts: GridLayouts): GridLayouts {
	return {
		lg: mirrorLayout(layouts.lg, DASHBOARD_COLS.lg),
		md: mirrorLayout(layouts.md, DASHBOARD_COLS.md),
		sm: mirrorLayout(layouts.sm, DASHBOARD_COLS.sm),
	}
}

/**
 * The breakpoint for a grid container width. Unlike react-grid-layout's own
 * lookup (which needs the width to exceed a breakpoint), a container exactly
 * as wide as a breakpoint already gets it.
 */
export function breakpointForWidth(width: number): DashboardBreakpoint {
	if (width >= DASHBOARD_BREAKPOINTS.lg) return 'lg'
	if (width >= DASHBOARD_BREAKPOINTS.md) return 'md'
	return 'sm'
}

/**
 * Builds the layouts to save from what the grid reports. Hidden blocks are not
 * rendered, so their saved entries are carried over from `previous`, and a
 * breakpoint the grid did not report keeps its saved layout.
 */
export function mergeHiddenLayoutEntries<T extends GridItem>(
	visible: Partial<Record<PersistedBreakpoint, readonly T[]>>,
	previous: DashboardLayouts,
	hiddenIds: Iterable<string>,
): DashboardLayouts {
	const hidden = new Set(hiddenIds)
	return mapLayouts((breakpoint) => {
		const reported = visible[breakpoint]
		if (!reported) return toGridItems(previous[breakpoint])
		const items = toGridItems(reported)
		const reportedIds = new Set(items.map((item) => item.i))
		const hiddenItems = previous[breakpoint].filter(
			(item) => hidden.has(item.i) && !reportedIds.has(item.i),
		)
		return [...items, ...toGridItems(hiddenItems)]
	})
}

/**
 * Puts the layout the grid reported for one breakpoint into the config.
 * Hidden blocks are not rendered, so the grid compacts other blocks into
 * their space; their saved entries move below the reported layout so they do
 * not overlap anything once they are shown again.
 */
export function applyGridLayout<T extends GridItem>(
	config: DashboardConfig,
	breakpoint: PersistedBreakpoint,
	reported: readonly T[],
	hiddenIds: Iterable<string>,
): DashboardConfig {
	const blockIds = new Set(config.blocks.map((block) => block.id))
	const hidden = new Set(hiddenIds)
	const items = toGridItems(reported.filter((item) => blockIds.has(item.i)))
	const reportedIds = new Set(items.map((item) => item.i))
	let bottom = layoutBottom(items)
	const hiddenItems = sortLayoutItems(
		config.layouts[breakpoint].filter(
			(item) =>
				hidden.has(item.i) && blockIds.has(item.i) && !reportedIds.has(item.i),
		),
	).map(({ i, x, w, h }) => {
		const item = { i, x, y: bottom, w, h }
		bottom += h
		return item
	})
	return {
		...config,
		layouts: { ...config.layouts, [breakpoint]: [...items, ...hiddenItems] },
	}
}

/** Whether two layouts place the same blocks at the same positions and sizes. */
export function sameLayout(
	a: readonly GridItem[],
	b: readonly GridItem[],
): boolean {
	if (a.length !== b.length) return false
	const byId = new Map(b.map((item) => [item.i, item]))
	return a.every((item) => {
		const other = byId.get(item.i)
		return (
			other !== undefined &&
			other.x === item.x &&
			other.y === item.y &&
			other.w === item.w &&
			other.h === item.h
		)
	})
}

/** Adds each block type's size limits so the grid enforces them on resize. */
export function withBlockSizeLimits<T extends GridItem>(
	layout: readonly T[],
	blocks: readonly DashboardBlock[],
	breakpoint: PersistedBreakpoint,
) {
	const typeById = new Map(blocks.map((block) => [block.id, block.type]))
	return layout.map((item) => {
		const type = typeById.get(item.i)
		return type ? { ...item, ...blockSizeLimits(type, breakpoint) } : item
	})
}

/** Sorts by row, then column, so DOM order matches the visual order. */
export function sortLayoutItems<T extends Position>(layout: readonly T[]): T[] {
	return [...layout].sort(compareByPosition)
}

/** Orders blocks by their layout position; blocks without one go last. */
export function sortBlocksByLayout<T extends { id: string }>(
	blocks: readonly T[],
	layout: readonly GridItem[],
): T[] {
	const rank = new Map(
		sortLayoutItems(layout).map((item, index) => [item.i, index]),
	)
	const unplaced = blocks.length
	return [...blocks].sort(
		(a, b) => (rank.get(a.id) ?? unplaced) - (rank.get(b.id) ?? unplaced),
	)
}

/** One full-width column in row, then column order (mobile layout). */
export function stackLayout(layout: readonly GridItem[]): GridItem[] {
	let y = 0
	return sortLayoutItems(layout).map((item) => {
		const stacked = { i: item.i, x: 0, y, w: 1, h: item.h }
		y += item.h
		return stacked
	})
}

/**
 * Drops hidden blocks and closes the space they leave. Vertical compaction
 * alone would leave a hole next to a hidden block, so blocks first slide
 * toward the start into the columns it freed in their rows.
 */
export function withoutHiddenBlocks(
	layout: readonly GridItem[],
	hiddenIds: Iterable<string>,
	cols: number,
): GridItem[] {
	const hidden = new Set(hiddenIds)
	const removed = layout.filter((item) => hidden.has(item.i))
	const placed = toGridItems(layout.filter((item) => !hidden.has(item.i)))
	const byColumn = [...placed].sort((a, b) => a.x - b.x || a.y - b.y)
	for (const item of byColumn) {
		const freedColumns = new Set<number>()
		for (const gone of removed) {
			if (!overlapsRows(gone, item)) continue
			const end = Math.min(gone.x + gone.w, item.x)
			for (let column = gone.x; column < end; column++) {
				freedColumns.add(column)
			}
		}
		let shift = freedColumns.size
		while (
			shift > 0 &&
			placed.some((other) => collides({ ...item, x: item.x - shift }, other))
		) {
			shift--
		}
		item.x -= shift
	}
	return toGridItems(verticalCompactor.compact(placed, cols))
}

/**
 * The layouts the grid renders: hidden blocks removed and `sm` stacked in the
 * lg reading order.
 */
export function visibleGridLayouts(
	layouts: DashboardLayouts,
	hiddenIds: Iterable<string> = [],
): GridLayouts {
	const hidden = [...hiddenIds]
	const lg = withoutHiddenBlocks(layouts.lg, hidden, DASHBOARD_COLS.lg)
	return {
		lg,
		md: withoutHiddenBlocks(layouts.md, hidden, DASHBOARD_COLS.md),
		sm: stackLayout(lg),
	}
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomSuffix(length = 10) {
	const bytes = crypto.getRandomValues(new Uint8Array(length))
	return Array.from(bytes, (byte) =>
		ID_ALPHABET.charAt(byte % ID_ALPHABET.length),
	).join('')
}

/**
 * Built-in blocks use their type as id (they appear at most once); report
 * blocks get a random id because the same report can be added many times.
 */
export function createBlockId(type: BlockType, existing: Iterable<string>) {
	const taken = new Set(existing)
	if (type === 'report') {
		let id = `report-${randomSuffix()}`
		while (taken.has(id)) id = `report-${randomSuffix()}`
		return id
	}
	if (!taken.has(type)) return type
	let suffix = 2
	while (taken.has(`${type}-${suffix}`)) suffix++
	return `${type}-${suffix}`
}
