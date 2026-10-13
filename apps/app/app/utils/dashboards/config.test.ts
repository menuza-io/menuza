import { describe, expect, it } from 'vitest'
import {
	BLOCK_DEFINITIONS,
	BLOCK_TYPES,
	BUILT_IN_BLOCK_TYPES,
	DASHBOARD_COLS,
	MAX_BLOCK_ROWS,
	MAX_DASHBOARD_BLOCKS,
	PERSISTED_BREAKPOINTS,
	addableBuiltInBlockTypes,
	blockSizeLimits,
	canAddBlockType,
	dashboardNameSchema,
	defaultHomeConfig,
	emptyDashboardConfig,
	normalizeDashboardConfig,
	parseDashboardConfig,
	parseStoredDashboardConfig,
	serializeDashboardConfig,
	type DashboardBlock,
	type DashboardConfig,
} from './config.ts'

function reportBlock(id: string, reportId = 'report_1'): DashboardBlock {
	return { id, type: 'report', config: { source: 'saved', reportId } }
}

function expectError(input: unknown, code: string) {
	const result = normalizeDashboardConfig(input)
	expect(result.success).toBe(false)
	if (result.success) throw new Error('expected a validation error')
	expect(result.error.code).toBe(code)
	expect(result.error.message).toEqual(expect.any(String))
	expect(result.error.message.length).toBeGreaterThan(0)
	return result.error
}

function expectConfig(input: unknown): DashboardConfig {
	const result = normalizeDashboardConfig(input)
	if (!result.success) {
		throw new Error(`expected a valid config, got ${result.error.code}`)
	}
	return result.config
}

describe('defaultHomeConfig', () => {
	it('has the four built-in blocks in reading order', () => {
		const config = defaultHomeConfig()
		expect(config.version).toBe(1)
		expect(config.blocks).toEqual([
			{ id: 'stats', type: 'stats' },
			{ id: 'notes-chart', type: 'notes-chart' },
			{ id: 'onboarding', type: 'onboarding' },
			{ id: 'leaderboard', type: 'leaderboard' },
		])
	})

	it('lays out stats, the chart, then onboarding and the leaderboard side by side', () => {
		const { layouts } = defaultHomeConfig()
		expect(layouts.lg).toEqual([
			{ i: 'stats', x: 0, y: 0, w: 12, h: 2 },
			{ i: 'notes-chart', x: 0, y: 2, w: 12, h: 8 },
			{ i: 'onboarding', x: 0, y: 10, w: 6, h: 10 },
			{ i: 'leaderboard', x: 6, y: 10, w: 6, h: 10 },
		])
		expect(layouts.md).toEqual([
			{ i: 'stats', x: 0, y: 0, w: 8, h: 2 },
			{ i: 'notes-chart', x: 0, y: 2, w: 8, h: 8 },
			{ i: 'onboarding', x: 0, y: 10, w: 4, h: 10 },
			{ i: 'leaderboard', x: 4, y: 10, w: 4, h: 10 },
		])
	})

	it('returns a fresh copy on every call', () => {
		const first = defaultHomeConfig()
		first.blocks.pop()
		first.layouts.lg[0]!.w = 1
		expect(defaultHomeConfig().blocks).toHaveLength(4)
		expect(defaultHomeConfig().layouts.lg[0]!.w).toBe(12)
	})

	it('is already normalized', () => {
		expect(expectConfig(defaultHomeConfig())).toEqual(defaultHomeConfig())
	})
})

describe('emptyDashboardConfig', () => {
	it('has no blocks and no layout entries', () => {
		expect(emptyDashboardConfig()).toEqual({
			version: 1,
			blocks: [],
			layouts: { lg: [], md: [] },
		})
	})
})

describe('block registry', () => {
	it('declares a definition for every block type', () => {
		expect(Object.keys(BLOCK_DEFINITIONS).sort()).toEqual(
			[...BLOCK_TYPES].sort(),
		)
		for (const type of BLOCK_TYPES) {
			const definition = BLOCK_DEFINITIONS[type]
			expect(definition.type).toBe(type)
			expect(definition.title.id).toEqual(expect.any(String))
		}
	})

	it('keeps default and minimum sizes inside the grid for lg and md', () => {
		for (const type of BLOCK_TYPES) {
			const definition = BLOCK_DEFINITIONS[type]
			for (const breakpoint of PERSISTED_BREAKPOINTS) {
				const cols = DASHBOARD_COLS[breakpoint]
				const min = definition.minSize[breakpoint]
				const size = definition.defaultSize[breakpoint]
				expect(min.w).toBeGreaterThanOrEqual(1)
				expect(min.h).toBeGreaterThanOrEqual(1)
				expect(size.w).toBeGreaterThanOrEqual(min.w)
				expect(size.h).toBeGreaterThanOrEqual(min.h)
				expect(size.w).toBeLessThanOrEqual(cols)
				expect(size.h).toBeLessThanOrEqual(MAX_BLOCK_ROWS)
			}
		}
	})

	it('allows each built-in block once and report blocks any number of times', () => {
		for (const type of BUILT_IN_BLOCK_TYPES) {
			expect(BLOCK_DEFINITIONS[type].maxInstances).toBe(1)
		}
		expect(BLOCK_DEFINITIONS.report.maxInstances).toBe(Number.POSITIVE_INFINITY)
	})

	it('exposes size limits for react-grid-layout items', () => {
		expect(blockSizeLimits('notes-chart', 'lg')).toEqual({
			minW: BLOCK_DEFINITIONS['notes-chart'].minSize.lg.w,
			minH: BLOCK_DEFINITIONS['notes-chart'].minSize.lg.h,
			maxW: 12,
			maxH: MAX_BLOCK_ROWS,
		})
		expect(blockSizeLimits('report', 'md').maxW).toBe(8)
	})

	it('only offers block types that are below their limit', () => {
		const home = defaultHomeConfig()
		expect(canAddBlockType(home.blocks, 'stats')).toBe(false)
		expect(canAddBlockType(home.blocks, 'report')).toBe(true)
		const withoutStats = home.blocks.filter((block) => block.type !== 'stats')
		expect(canAddBlockType(withoutStats, 'stats')).toBe(true)

		const full = Array.from({ length: MAX_DASHBOARD_BLOCKS }, (_, index) =>
			reportBlock(`report-${index}`),
		)
		expect(canAddBlockType(full, 'report')).toBe(false)
		expect(canAddBlockType(full, 'stats')).toBe(false)
	})
})

describe('addableBuiltInBlockTypes', () => {
	const without = (...types: string[]) =>
		defaultHomeConfig().blocks.filter((block) => !types.includes(block.type))

	it('offers only the built-in blocks that are not on the dashboard', () => {
		const options = { onboardingAvailable: true }
		expect(
			addableBuiltInBlockTypes(defaultHomeConfig().blocks, options),
		).toEqual([])
		expect(addableBuiltInBlockTypes(without('leaderboard'), options)).toEqual([
			'leaderboard',
		])
		expect(addableBuiltInBlockTypes([], options)).toEqual(BUILT_IN_BLOCK_TYPES)
	})

	it('offers onboarding only while the viewer would see it', () => {
		const blocks = without('onboarding', 'stats')
		expect(
			addableBuiltInBlockTypes(blocks, { onboardingAvailable: true }),
		).toEqual(['stats', 'onboarding'])
		expect(
			addableBuiltInBlockTypes(blocks, { onboardingAvailable: false }),
		).toEqual(['stats'])
	})

	it('offers nothing once the dashboard is full', () => {
		const full = Array.from({ length: MAX_DASHBOARD_BLOCKS }, (_, index) =>
			reportBlock(`report-${index}`),
		)
		expect(
			addableBuiltInBlockTypes(full, { onboardingAvailable: true }),
		).toEqual([])
	})
})

describe('normalizeDashboardConfig', () => {
	it('rejects input that is not a config object', () => {
		expectError(null, 'invalid-shape')
		expectError('nope', 'invalid-shape')
		expectError([], 'invalid-shape')
		expectError({ version: 1, blocks: 'stats' }, 'invalid-shape')
		expectError({ version: 1 }, 'invalid-shape')
		expectError(
			{ version: 1, blocks: [], layouts: { lg: 'nope' } },
			'invalid-shape',
		)
	})

	it('rejects an unsupported version', () => {
		expectError({ version: 2, blocks: [] }, 'invalid-shape')
	})

	it('rejects unknown block types', () => {
		const error = expectError(
			{ version: 1, blocks: [{ id: 'weather', type: 'weather' }] },
			'unknown-block-type',
		)
		expect(error.message).toContain('weather')
	})

	it('rejects malformed blocks', () => {
		expectError({ version: 1, blocks: [{ type: 'stats' }] }, 'invalid-shape')
		expectError(
			{ version: 1, blocks: [{ id: 'has spaces', type: 'stats' }] },
			'invalid-shape',
		)
		expectError(
			{ version: 1, blocks: [{ id: 'r1', type: 'report' }] },
			'invalid-shape',
		)
		expectError(
			{
				version: 1,
				blocks: [{ id: 'r1', type: 'report', config: { source: 'saved' } }],
			},
			'invalid-shape',
		)
		expectError(
			{
				version: 1,
				blocks: [
					{ id: 'r1', type: 'report', config: { source: 'web', url: 'x' } },
				],
			},
			'invalid-shape',
		)
	})

	it('rejects a built-in block that appears twice', () => {
		const error = expectError(
			{
				version: 1,
				blocks: [
					{ id: 'stats', type: 'stats' },
					{ id: 'stats-2', type: 'stats' },
				],
			},
			'duplicate-built-in',
		)
		expect(error.message).toContain('stats')
	})

	it('rejects duplicate block ids', () => {
		expectError(
			{ version: 1, blocks: [reportBlock('r1'), reportBlock('r1', 'other')] },
			'duplicate-block-id',
		)
	})

	it('rejects more than 30 blocks and accepts exactly 30', () => {
		const blocks = Array.from({ length: MAX_DASHBOARD_BLOCKS }, (_, index) =>
			reportBlock(`report-${index}`),
		)
		expect(expectConfig({ version: 1, blocks }).blocks).toHaveLength(30)
		const error = expectError(
			{ version: 1, blocks: [...blocks, reportBlock('report-extra')] },
			'too-many-blocks',
		)
		expect(error.message).toContain('30')
	})

	it('allows the same report and template more than once', () => {
		const config = expectConfig({
			version: 1,
			blocks: [
				reportBlock('r1', 'same'),
				reportBlock('r2', 'same'),
				{
					id: 't1',
					type: 'report',
					config: { source: 'template', templateId: 'customer-count' },
				},
				{
					id: 't2',
					type: 'report',
					config: { source: 'template', templateId: 'customer-count' },
				},
			],
		})
		expect(config.blocks.map((block) => block.id)).toEqual([
			'r1',
			'r2',
			't1',
			't2',
		])
		expect(config.layouts.lg.map((item) => item.i)).toEqual([
			'r1',
			'r2',
			't1',
			't2',
		])
	})

	it('defaults a missing version to 1', () => {
		expect(expectConfig({ blocks: [] })).toEqual(emptyDashboardConfig())
	})

	it('clamps layout items into the 12 and 8 column grids', () => {
		const config = expectConfig({
			version: 1,
			blocks: [{ id: 'leaderboard', type: 'leaderboard' }],
			layouts: {
				lg: [{ i: 'leaderboard', x: 10, y: -4, w: 6, h: 10 }],
				md: [{ i: 'leaderboard', x: -2, y: 3, w: 20, h: 10 }],
			},
		})
		expect(config.layouts.lg).toEqual([
			{ i: 'leaderboard', x: 6, y: 0, w: 6, h: 10 },
		])
		expect(config.layouts.md).toEqual([
			{ i: 'leaderboard', x: 0, y: 3, w: 8, h: 10 },
		])
	})

	it('enforces minimum and maximum block sizes', () => {
		const min = BLOCK_DEFINITIONS['notes-chart'].minSize
		const config = expectConfig({
			version: 1,
			blocks: [{ id: 'notes-chart', type: 'notes-chart' }],
			layouts: {
				lg: [{ i: 'notes-chart', x: 0, y: 0, w: 1, h: 1 }],
				md: [{ i: 'notes-chart', x: 0, y: 0, w: 2, h: 500 }],
			},
		})
		expect(config.layouts.lg[0]).toMatchObject({ w: min.lg.w, h: min.lg.h })
		expect(config.layouts.md[0]).toMatchObject({
			w: min.md.w,
			h: MAX_BLOCK_ROWS,
		})
	})

	it('rounds fractional positions and sizes', () => {
		const config = expectConfig({
			version: 1,
			blocks: [reportBlock('r1')],
			layouts: {
				lg: [{ i: 'r1', x: 1.4, y: 2.6, w: 5.5, h: 7.2 }],
				md: [{ i: 'r1', x: 0, y: 0, w: 4, h: 8 }],
			},
		})
		expect(config.layouts.lg).toEqual([{ i: 'r1', x: 1, y: 3, w: 6, h: 7 }])
	})

	it('generates missing layout entries at the bottom with default sizes', () => {
		const config = expectConfig({
			version: 1,
			blocks: [
				{ id: 'stats', type: 'stats' },
				reportBlock('r1'),
				{ id: 'leaderboard', type: 'leaderboard' },
			],
			layouts: {
				lg: [{ i: 'stats', x: 0, y: 0, w: 12, h: 2 }],
				md: [],
			},
		})
		const reportSize = BLOCK_DEFINITIONS.report.defaultSize
		const leaderboardSize = BLOCK_DEFINITIONS.leaderboard.defaultSize
		expect(config.layouts.lg).toEqual([
			{ i: 'stats', x: 0, y: 0, w: 12, h: 2 },
			{ i: 'r1', x: 0, y: 2, w: reportSize.lg.w, h: reportSize.lg.h },
			{
				i: 'leaderboard',
				x: 0,
				y: 2 + reportSize.lg.h,
				w: leaderboardSize.lg.w,
				h: leaderboardSize.lg.h,
			},
		])
		expect(config.layouts.md.map((item) => item.i)).toEqual([
			'stats',
			'r1',
			'leaderboard',
		])
		expect(config.layouts.md[0]).toMatchObject({ x: 0, y: 0 })
	})

	it('generates both breakpoints when layouts are missing', () => {
		const config = expectConfig({ version: 1, blocks: [reportBlock('r1')] })
		expect(config.layouts.lg).toHaveLength(1)
		expect(config.layouts.md).toHaveLength(1)
	})

	it('drops layout entries for unknown block ids and keeps the first duplicate', () => {
		const config = expectConfig({
			version: 1,
			blocks: [reportBlock('r1')],
			layouts: {
				lg: [
					{ i: 'ghost', x: 0, y: 0, w: 4, h: 4 },
					{ i: 'r1', x: 2, y: 0, w: 4, h: 6 },
					{ i: 'r1', x: 8, y: 9, w: 4, h: 6 },
				],
				md: [{ i: 'ghost', x: 0, y: 0, w: 4, h: 4 }],
			},
		})
		expect(config.layouts.lg).toEqual([{ i: 'r1', x: 2, y: 0, w: 4, h: 6 }])
		expect(config.layouts.md.map((item) => item.i)).toEqual(['r1'])
	})

	it('strips react-grid-layout internals and unknown breakpoints', () => {
		const config = expectConfig({
			version: 1,
			blocks: [{ id: 'stats', type: 'stats', extra: true }],
			layouts: {
				lg: [
					{
						i: 'stats',
						x: 0,
						y: 0,
						w: 12,
						h: 2,
						moved: false,
						static: false,
						isDraggable: true,
						minW: 1,
						resizeHandles: ['se'],
					},
				],
				md: [{ i: 'stats', x: 0, y: 0, w: 8, h: 2, moved: true }],
				sm: [{ i: 'stats', x: 0, y: 0, w: 1, h: 2 }],
			},
		})
		expect(config).toEqual({
			version: 1,
			blocks: [{ id: 'stats', type: 'stats' }],
			layouts: {
				lg: [{ i: 'stats', x: 0, y: 0, w: 12, h: 2 }],
				md: [{ i: 'stats', x: 0, y: 0, w: 8, h: 2 }],
			},
		})
	})

	it('rejects layout items with the wrong value types', () => {
		expectError(
			{
				version: 1,
				blocks: [{ id: 'stats', type: 'stats' }],
				layouts: { lg: [{ i: 'stats', x: '0', y: 0, w: 12, h: 2 }] },
			},
			'invalid-shape',
		)
	})
})

describe('parseDashboardConfig', () => {
	it('rejects text that is not JSON', () => {
		const result = parseDashboardConfig('{not json')
		expect(result.success).toBe(false)
		if (!result.success) expect(result.error.code).toBe('invalid-json')
	})

	it('parses and normalizes a JSON string', () => {
		const result = parseDashboardConfig(
			serializeDashboardConfig(defaultHomeConfig()),
		)
		expect(result).toEqual({ success: true, config: defaultHomeConfig() })
	})
})

describe('parseStoredDashboardConfig', () => {
	it('falls back to the default Home for invalid stored JSON', () => {
		expect(parseStoredDashboardConfig('{not json', 'home')).toEqual(
			defaultHomeConfig(),
		)
		expect(
			parseStoredDashboardConfig('{"version":1,"blocks":"x"}', 'home'),
		).toEqual(defaultHomeConfig())
		expect(parseStoredDashboardConfig(null, 'home')).toEqual(
			defaultHomeConfig(),
		)
	})

	it('falls back to an empty config for custom dashboards', () => {
		expect(parseStoredDashboardConfig('{not json', 'custom')).toEqual(
			emptyDashboardConfig(),
		)
		expect(parseStoredDashboardConfig('', 'custom')).toEqual(
			emptyDashboardConfig(),
		)
		expect(
			parseStoredDashboardConfig(
				JSON.stringify({
					version: 1,
					blocks: [
						{ id: 'stats', type: 'stats' },
						{ id: 'stats-2', type: 'stats' },
					],
				}),
				'custom',
			),
		).toEqual(emptyDashboardConfig())
	})

	it('returns the stored config, normalized, when it is valid', () => {
		const stored = JSON.stringify({
			version: 1,
			blocks: [reportBlock('r1')],
			layouts: { lg: [{ i: 'r1', x: 20, y: 0, w: 4, h: 6, moved: false }] },
		})
		const config = parseStoredDashboardConfig(stored, 'custom')
		expect(config.blocks).toEqual([reportBlock('r1')])
		expect(config.layouts.lg).toEqual([{ i: 'r1', x: 8, y: 0, w: 4, h: 6 }])
		expect(config.layouts.md).toHaveLength(1)
	})
})

describe('dashboardNameSchema', () => {
	it('trims names and accepts 1 to 60 characters', () => {
		expect(dashboardNameSchema.parse('  Sales overview  ')).toBe(
			'Sales overview',
		)
		expect(dashboardNameSchema.parse('a'.repeat(60))).toHaveLength(60)
	})

	it('rejects empty, blank and too long names', () => {
		expect(dashboardNameSchema.safeParse('').success).toBe(false)
		expect(dashboardNameSchema.safeParse('    ').success).toBe(false)
		expect(dashboardNameSchema.safeParse('a'.repeat(61)).success).toBe(false)
	})
})
