import { describe, expect, it } from 'vitest'
import {
	BLOCK_DEFINITIONS,
	defaultHomeConfig,
	emptyDashboardConfig,
	normalizeDashboardConfig,
	type DashboardBlock,
	type GridItem,
} from './config.ts'
import {
	appendBlock,
	createBlockId,
	layoutBottom,
	mergeHiddenLayoutEntries,
	mirrorLayout,
	mirrorLayouts,
	removeBlock,
	sortBlocksByLayout,
	sortLayoutItems,
	stackLayout,
	toGridItems,
	unmirrorLayout,
	unmirrorLayouts,
} from './layout.ts'

const report: DashboardBlock = {
	id: 'report-abc',
	type: 'report',
	config: { source: 'template', templateId: 'customer-count' },
}

describe('layoutBottom', () => {
	it('is 0 for an empty layout and the lowest edge otherwise', () => {
		expect(layoutBottom([])).toBe(0)
		expect(layoutBottom(defaultHomeConfig().layouts.lg)).toBe(20)
	})
})

describe('appendBlock', () => {
	it('adds the block at the bottom of every breakpoint with its default size', () => {
		const next = appendBlock(defaultHomeConfig(), report)
		const size = BLOCK_DEFINITIONS.report.defaultSize
		expect(next.blocks.at(-1)).toEqual(report)
		expect(next.layouts.lg.at(-1)).toEqual({
			i: 'report-abc',
			x: 0,
			y: 20,
			w: size.lg.w,
			h: size.lg.h,
		})
		expect(next.layouts.md.at(-1)).toEqual({
			i: 'report-abc',
			x: 0,
			y: 20,
			w: size.md.w,
			h: size.md.h,
		})
	})

	it('places the first block of an empty dashboard at the top', () => {
		const next = appendBlock(emptyDashboardConfig(), {
			id: 'stats',
			type: 'stats',
		})
		expect(next.layouts.lg).toEqual([{ i: 'stats', x: 0, y: 0, w: 12, h: 2 }])
		expect(next.layouts.md).toEqual([{ i: 'stats', x: 0, y: 0, w: 8, h: 2 }])
	})

	it('does not modify the original config and stays valid', () => {
		const original = defaultHomeConfig()
		const next = appendBlock(original, report)
		expect(original).toEqual(defaultHomeConfig())
		const normalized = normalizeDashboardConfig(next)
		expect(normalized).toEqual({ success: true, config: next })
	})
})

describe('removeBlock', () => {
	it('removes the block and its layout entries', () => {
		const next = removeBlock(defaultHomeConfig(), 'leaderboard')
		expect(next.blocks.map((block) => block.id)).toEqual([
			'stats',
			'notes-chart',
			'onboarding',
		])
		expect(next.layouts.lg.map((item) => item.i)).not.toContain('leaderboard')
		expect(next.layouts.md.map((item) => item.i)).not.toContain('leaderboard')
	})
})

describe('mirrorLayout', () => {
	it('mirrors x across the grid columns', () => {
		expect(
			mirrorLayout(
				[
					{ i: 'a', x: 0, y: 0, w: 6, h: 4 },
					{ i: 'b', x: 6, y: 0, w: 6, h: 4 },
					{ i: 'c', x: 2, y: 4, w: 3, h: 2 },
				],
				12,
			),
		).toEqual([
			{ i: 'a', x: 6, y: 0, w: 6, h: 4 },
			{ i: 'b', x: 0, y: 0, w: 6, h: 4 },
			{ i: 'c', x: 7, y: 4, w: 3, h: 2 },
		])
	})

	it('restores the original layout when unmirrored', () => {
		const layout = defaultHomeConfig().layouts.md
		expect(unmirrorLayout(mirrorLayout(layout, 8), 8)).toEqual(layout)
	})

	it('mirrors lg with 12 columns and md with 8 columns', () => {
		const layouts = defaultHomeConfig().layouts
		const mirrored = mirrorLayouts(layouts)
		expect(mirrored.lg.find((item) => item.i === 'onboarding')?.x).toBe(6)
		expect(mirrored.lg.find((item) => item.i === 'leaderboard')?.x).toBe(0)
		expect(mirrored.md.find((item) => item.i === 'onboarding')?.x).toBe(4)
		expect(mirrored.md.find((item) => item.i === 'leaderboard')?.x).toBe(0)
		expect(unmirrorLayouts(mirrored)).toEqual(layouts)
	})
})

describe('mergeHiddenLayoutEntries', () => {
	it('keeps the saved entries of hidden blocks', () => {
		const previous = defaultHomeConfig().layouts
		const visible = {
			lg: previous.lg
				.filter((item) => item.i !== 'onboarding')
				.map((item) =>
					item.i === 'leaderboard' ? { ...item, x: 0, y: 0 } : item,
				),
			md: previous.md.filter((item) => item.i !== 'onboarding'),
		}
		const merged = mergeHiddenLayoutEntries(visible, previous, ['onboarding'])
		expect(merged.lg.find((item) => item.i === 'leaderboard')).toMatchObject({
			x: 0,
			y: 0,
		})
		expect(merged.lg.find((item) => item.i === 'onboarding')).toEqual(
			previous.lg.find((item) => item.i === 'onboarding'),
		)
		expect(merged.md.find((item) => item.i === 'onboarding')).toEqual(
			previous.md.find((item) => item.i === 'onboarding'),
		)
		expect(merged.lg).toHaveLength(4)
	})

	it('prefers the visible entry when a hidden block is in the visible layout', () => {
		const previous = defaultHomeConfig().layouts
		const moved = { i: 'onboarding', x: 6, y: 30, w: 6, h: 10 }
		const merged = mergeHiddenLayoutEntries(
			{ lg: [moved], md: previous.md },
			previous,
			['onboarding'],
		)
		expect(merged.lg).toEqual([moved])
	})

	it('falls back to the saved layout for a breakpoint the grid did not report', () => {
		const previous = defaultHomeConfig().layouts
		const merged = mergeHiddenLayoutEntries(
			{ lg: previous.lg.slice(0, 2) },
			previous,
			[],
		)
		expect(merged.md).toEqual(previous.md)
		expect(merged.lg).toEqual(previous.lg.slice(0, 2))
	})

	it('strips react-grid-layout fields from the visible entries', () => {
		const merged = mergeHiddenLayoutEntries(
			{
				lg: [{ i: 'stats', x: 0, y: 0, w: 12, h: 2, moved: false }],
				md: [{ i: 'stats', x: 0, y: 0, w: 8, h: 2, static: false }],
			},
			emptyDashboardConfig().layouts,
			[],
		)
		expect(merged).toEqual({
			lg: [{ i: 'stats', x: 0, y: 0, w: 12, h: 2 }],
			md: [{ i: 'stats', x: 0, y: 0, w: 8, h: 2 }],
		})
	})
})

describe('sorting by position', () => {
	const layout: GridItem[] = [
		{ i: 'leaderboard', x: 6, y: 10, w: 6, h: 10 },
		{ i: 'stats', x: 0, y: 2, w: 12, h: 2 },
		{ i: 'onboarding', x: 0, y: 10, w: 6, h: 10 },
		{ i: 'notes-chart', x: 0, y: 0, w: 12, h: 2 },
	]

	it('sorts layout items by row, then column', () => {
		expect(sortLayoutItems(layout).map((item) => item.i)).toEqual([
			'notes-chart',
			'stats',
			'onboarding',
			'leaderboard',
		])
		expect(layout[0]!.i).toBe('leaderboard')
	})

	it('sorts blocks by their layout position and keeps unplaced blocks last', () => {
		const blocks: DashboardBlock[] = [
			{ id: 'stats', type: 'stats' },
			report,
			{ id: 'leaderboard', type: 'leaderboard' },
			{ id: 'notes-chart', type: 'notes-chart' },
			{ id: 'onboarding', type: 'onboarding' },
		]
		expect(sortBlocksByLayout(blocks, layout).map((block) => block.id)).toEqual(
			['notes-chart', 'stats', 'onboarding', 'leaderboard', 'report-abc'],
		)
	})
})

describe('toGridItems', () => {
	it('keeps only i, x, y, w and h', () => {
		expect(
			toGridItems([
				{
					i: 'stats',
					x: 0,
					y: 0,
					w: 12,
					h: 2,
					moved: false,
					static: false,
					minW: 4,
					isDraggable: true,
				},
			]),
		).toEqual([{ i: 'stats', x: 0, y: 0, w: 12, h: 2 }])
	})
})

describe('stackLayout', () => {
	it('stacks blocks in one column in row, then column order', () => {
		expect(stackLayout(defaultHomeConfig().layouts.lg)).toEqual([
			{ i: 'stats', x: 0, y: 0, w: 1, h: 2 },
			{ i: 'notes-chart', x: 0, y: 2, w: 1, h: 8 },
			{ i: 'onboarding', x: 0, y: 10, w: 1, h: 10 },
			{ i: 'leaderboard', x: 0, y: 20, w: 1, h: 10 },
		])
	})
})

describe('createBlockId', () => {
	it('uses the type as the id of a built-in block', () => {
		expect(createBlockId('stats', [])).toBe('stats')
		expect(createBlockId('stats', ['stats'])).toBe('stats-2')
	})

	it('creates unique ids for report blocks', () => {
		const existing = new Set<string>()
		for (let index = 0; index < 50; index++) {
			const id = createBlockId('report', existing)
			expect(id).toMatch(/^report-[a-z0-9]+$/)
			expect(existing.has(id)).toBe(false)
			existing.add(id)
		}
	})
})
