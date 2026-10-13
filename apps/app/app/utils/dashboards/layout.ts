import {
	BLOCK_DEFINITIONS,
	DASHBOARD_COLS,
	type BlockType,
	type DashboardBlock,
	type DashboardConfig,
	type DashboardLayouts,
	type GridItem,
	type PersistedBreakpoint,
} from './config.ts'

type Position = { x: number; y: number }

function compareByPosition(a: Position, b: Position) {
	return a.y - b.y || a.x - b.x
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
