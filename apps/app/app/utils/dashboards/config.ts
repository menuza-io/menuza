import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { z } from 'zod'

export const DASHBOARD_CONFIG_VERSION = 1
export const MAX_DASHBOARD_BLOCKS = 30
export const MAX_CUSTOM_DASHBOARDS = 25
export const DASHBOARD_NAME_MAX_LENGTH = 60
export const MAX_BLOCK_ROWS = 30

export const BUILT_IN_BLOCK_TYPES = [
	'stats',
	'notes-chart',
	'onboarding',
	'leaderboard',
	'bookings-today',
] as const
export const BLOCK_TYPES = [...BUILT_IN_BLOCK_TYPES, 'report'] as const
export type BuiltInBlockType = (typeof BUILT_IN_BLOCK_TYPES)[number]
export type BlockType = (typeof BLOCK_TYPES)[number]

export const DASHBOARD_KINDS = ['home', 'custom'] as const
export type DashboardKind = (typeof DASHBOARD_KINDS)[number]

export const DASHBOARD_SHARE_ACCESS = ['view', 'edit'] as const
export type DashboardShareAccess = (typeof DASHBOARD_SHARE_ACCESS)[number]
export type DashboardAccess = 'owner' | DashboardShareAccess
export const dashboardShareAccessSchema = z.enum(DASHBOARD_SHARE_ACCESS)

/** Owners and edit recipients may change a dashboard's blocks and layout. */
export function canEdit(access: DashboardAccess) {
	return access === 'owner' || access === 'edit'
}

/** Only owners may rename, delete or share a dashboard. */
export function isOwner(access: DashboardAccess) {
	return access === 'owner'
}

/** Breakpoints whose layouts are stored. `sm` is derived (one stacked column). */
export const PERSISTED_BREAKPOINTS = ['lg', 'md'] as const
export type PersistedBreakpoint = (typeof PERSISTED_BREAKPOINTS)[number]
export type DashboardBreakpoint = PersistedBreakpoint | 'sm'

export const DASHBOARD_COLS = {
	lg: 12,
	md: 8,
	sm: 1,
} as const satisfies Record<DashboardBreakpoint, number>
/** Minimum container widths in pixels (not viewport widths). */
export const DASHBOARD_BREAKPOINTS = {
	lg: 960,
	md: 600,
	sm: 0,
} as const satisfies Record<DashboardBreakpoint, number>
export const DASHBOARD_ROW_HEIGHT = 40
export const DASHBOARD_MARGIN = [16, 16] as const

export type GridItem = { i: string; x: number; y: number; w: number; h: number }
export type DashboardLayouts = Record<PersistedBreakpoint, GridItem[]>

export type BlockSize = { w: number; h: number }

export type BlockDefinition<T extends BlockType = BlockType> = {
	type: T
	title: MessageDescriptor
	description: MessageDescriptor
	defaultSize: Record<PersistedBreakpoint, BlockSize>
	minSize: Record<PersistedBreakpoint, BlockSize>
	maxInstances: number
}

export const BLOCK_DEFINITIONS: { [T in BlockType]: BlockDefinition<T> } = {
	stats: {
		type: 'stats',
		title: msg`Stats`,
		description: msg`Total notes, the daily average and the trend.`,
		defaultSize: { lg: { w: 12, h: 2 }, md: { w: 8, h: 2 } },
		minSize: { lg: { w: 4, h: 2 }, md: { w: 4, h: 2 } },
		maxInstances: 1,
	},
	'notes-chart': {
		type: 'notes-chart',
		title: msg`Notes chart`,
		description: msg`Notes created each day.`,
		defaultSize: { lg: { w: 12, h: 8 }, md: { w: 8, h: 8 } },
		minSize: { lg: { w: 4, h: 6 }, md: { w: 4, h: 6 } },
		maxInstances: 1,
	},
	onboarding: {
		type: 'onboarding',
		title: msg`Onboarding checklist`,
		description: msg`Your remaining setup steps.`,
		defaultSize: { lg: { w: 6, h: 10 }, md: { w: 4, h: 10 } },
		minSize: { lg: { w: 4, h: 8 }, md: { w: 4, h: 8 } },
		maxInstances: 1,
	},
	leaderboard: {
		type: 'leaderboard',
		title: msg`Top contributors`,
		description: msg`Members who created the most notes.`,
		defaultSize: { lg: { w: 6, h: 10 }, md: { w: 4, h: 10 } },
		minSize: { lg: { w: 3, h: 6 }, md: { w: 3, h: 6 } },
		maxInstances: 1,
	},
	'bookings-today': {
		type: 'bookings-today',
		title: msg`Bookings today`,
		description: msg`Today's reservations by status, covers by service, and the next arrivals.`,
		defaultSize: { lg: { w: 6, h: 8 }, md: { w: 4, h: 8 } },
		minSize: { lg: { w: 4, h: 6 }, md: { w: 4, h: 6 } },
		maxInstances: 1,
	},
	report: {
		type: 'report',
		title: msg`Report`,
		description: msg`A saved report or a report template.`,
		defaultSize: { lg: { w: 6, h: 8 }, md: { w: 4, h: 8 } },
		minSize: { lg: { w: 3, h: 4 }, md: { w: 3, h: 4 } },
		maxInstances: Number.POSITIVE_INFINITY,
	},
}

export function isBlockType(value: string): value is BlockType {
	return (BLOCK_TYPES as readonly string[]).includes(value)
}

/** Size constraints for a react-grid-layout item of this block type. */
export function blockSizeLimits(
	type: BlockType,
	breakpoint: PersistedBreakpoint,
) {
	const min = BLOCK_DEFINITIONS[type].minSize[breakpoint]
	return {
		minW: min.w,
		minH: min.h,
		maxW: DASHBOARD_COLS[breakpoint],
		maxH: MAX_BLOCK_ROWS,
	}
}

const blockIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[\w-]+$/)
const referenceIdSchema = z.string().min(1).max(128)

export const reportBlockConfigSchema = z.discriminatedUnion('source', [
	z.object({ source: z.literal('saved'), reportId: referenceIdSchema }),
	z.object({ source: z.literal('template'), templateId: referenceIdSchema }),
])

export const dashboardBlockSchema = z.discriminatedUnion('type', [
	z.object({ id: blockIdSchema, type: z.enum(BUILT_IN_BLOCK_TYPES) }),
	z.object({
		id: blockIdSchema,
		type: z.literal('report'),
		config: reportBlockConfigSchema,
	}),
])

export type ReportBlockConfig = z.infer<typeof reportBlockConfigSchema>
export type DashboardBlock = z.infer<typeof dashboardBlockSchema>
export type BuiltInDashboardBlock = Extract<
	DashboardBlock,
	{ type: BuiltInBlockType }
>
export type ReportDashboardBlock = Extract<DashboardBlock, { type: 'report' }>
/** A block picked to be added, before it gets an id on the dashboard. */
export type NewDashboardBlock =
	{ type: BuiltInBlockType } | { type: 'report'; config: ReportBlockConfig }

export type DashboardConfig = {
	version: typeof DASHBOARD_CONFIG_VERSION
	blocks: DashboardBlock[]
	layouts: DashboardLayouts
}

const gridItemInputSchema = z.object({
	i: z.string(),
	x: z.number().finite(),
	y: z.number().finite(),
	w: z.number().finite(),
	h: z.number().finite(),
})

// Blocks are validated one by one so unknown types get their own error code.
const dashboardConfigInputSchema = z.object({
	version: z
		.literal(DASHBOARD_CONFIG_VERSION)
		.default(DASHBOARD_CONFIG_VERSION),
	blocks: z.array(z.unknown()),
	layouts: z
		.object({
			lg: z.array(gridItemInputSchema).optional(),
			md: z.array(gridItemInputSchema).optional(),
		})
		.optional(),
})

const blockTypeProbeSchema = z.object({ type: z.string() })

export type DashboardConfigErrorCode =
	| 'invalid-json'
	| 'invalid-shape'
	| 'unknown-block-type'
	| 'duplicate-built-in'
	| 'duplicate-block-id'
	| 'too-many-blocks'

export type DashboardConfigError = {
	code: DashboardConfigErrorCode
	message: string
}

export type DashboardConfigResult =
	| { success: true; config: DashboardConfig }
	| { success: false; error: DashboardConfigError }

function failure(
	code: DashboardConfigErrorCode,
	message: string,
): DashboardConfigResult {
	return { success: false, error: { code, message } }
}

function invalidShape() {
	return failure('invalid-shape', 'The dashboard configuration is invalid.')
}

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max)
}

function clampGridItem(
	item: GridItem,
	type: BlockType,
	breakpoint: PersistedBreakpoint,
): GridItem {
	const cols = DASHBOARD_COLS[breakpoint]
	const min = BLOCK_DEFINITIONS[type].minSize[breakpoint]
	const w = clamp(Math.round(item.w), min.w, cols)
	const h = clamp(Math.round(item.h), min.h, MAX_BLOCK_ROWS)
	return {
		i: item.i,
		x: clamp(Math.round(item.x), 0, cols - w),
		y: Math.max(0, Math.round(item.y)),
		w,
		h,
	}
}

function normalizeLayout(
	items: readonly GridItem[] | undefined,
	blocks: readonly DashboardBlock[],
	breakpoint: PersistedBreakpoint,
): GridItem[] {
	const typeById = new Map(blocks.map((block) => [block.id, block.type]))
	const placed = new Set<string>()
	const layout: GridItem[] = []
	for (const item of items ?? []) {
		const type = typeById.get(item.i)
		if (!type || placed.has(item.i)) continue
		placed.add(item.i)
		layout.push(clampGridItem(item, type, breakpoint))
	}
	let bottom = layout.reduce((max, item) => Math.max(max, item.y + item.h), 0)
	for (const block of blocks) {
		if (placed.has(block.id)) continue
		const size = BLOCK_DEFINITIONS[block.type].defaultSize[breakpoint]
		layout.push({ i: block.id, x: 0, y: bottom, w: size.w, h: size.h })
		bottom += size.h
	}
	return layout
}

/**
 * Validates an untrusted dashboard config and returns its canonical form:
 * extra fields are stripped, layout items are clamped to the grid, entries for
 * unknown blocks are dropped and missing entries are added at the bottom.
 */
export function normalizeDashboardConfig(
	input: unknown,
): DashboardConfigResult {
	const parsed = dashboardConfigInputSchema.safeParse(input)
	if (!parsed.success) return invalidShape()
	const { blocks: rawBlocks, layouts } = parsed.data

	if (rawBlocks.length > MAX_DASHBOARD_BLOCKS) {
		return failure(
			'too-many-blocks',
			`A dashboard can have at most ${MAX_DASHBOARD_BLOCKS} blocks.`,
		)
	}

	const blocks: DashboardBlock[] = []
	for (const rawBlock of rawBlocks) {
		const probe = blockTypeProbeSchema.safeParse(rawBlock)
		if (!probe.success) return invalidShape()
		if (!isBlockType(probe.data.type)) {
			return failure(
				'unknown-block-type',
				`Unknown block type "${probe.data.type.slice(0, 40)}".`,
			)
		}
		const block = dashboardBlockSchema.safeParse(rawBlock)
		if (!block.success) return invalidShape()
		blocks.push(block.data)
	}

	const ids = new Set<string>()
	const typeCounts = new Map<BlockType, number>()
	for (const block of blocks) {
		const typeCount = (typeCounts.get(block.type) ?? 0) + 1
		typeCounts.set(block.type, typeCount)
		if (typeCount > BLOCK_DEFINITIONS[block.type].maxInstances) {
			return failure(
				'duplicate-built-in',
				`The ${block.type} block can only be added once.`,
			)
		}
		if (ids.has(block.id)) {
			return failure(
				'duplicate-block-id',
				`Block ids must be unique ("${block.id}" is used twice).`,
			)
		}
		ids.add(block.id)
	}

	return {
		success: true,
		config: {
			version: DASHBOARD_CONFIG_VERSION,
			blocks,
			layouts: {
				lg: normalizeLayout(layouts?.lg, blocks, 'lg'),
				md: normalizeLayout(layouts?.md, blocks, 'md'),
			},
		},
	}
}

export function parseDashboardConfig(text: string): DashboardConfigResult {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return failure(
			'invalid-json',
			'The dashboard configuration is not valid JSON.',
		)
	}
	return normalizeDashboardConfig(parsed)
}

/**
 * Reads a config stored in the database. Bad stored data must never break the
 * page, so anything invalid falls back to the defaults for the dashboard kind.
 */
export function parseStoredDashboardConfig(
	raw: string | null | undefined,
	kind: DashboardKind,
): DashboardConfig {
	const result = raw ? parseDashboardConfig(raw) : null
	if (result?.success) return result.config
	return kind === 'home' ? defaultHomeConfig() : emptyDashboardConfig()
}

export function serializeDashboardConfig(config: DashboardConfig) {
	return JSON.stringify(config)
}

export function defaultHomeConfig(): DashboardConfig {
	return {
		version: DASHBOARD_CONFIG_VERSION,
		blocks: [
			{ id: 'stats', type: 'stats' },
			{ id: 'notes-chart', type: 'notes-chart' },
			{ id: 'onboarding', type: 'onboarding' },
			{ id: 'leaderboard', type: 'leaderboard' },
		],
		layouts: {
			lg: [
				{ i: 'stats', x: 0, y: 0, w: 12, h: 2 },
				{ i: 'notes-chart', x: 0, y: 2, w: 12, h: 8 },
				{ i: 'onboarding', x: 0, y: 10, w: 6, h: 10 },
				{ i: 'leaderboard', x: 6, y: 10, w: 6, h: 10 },
			],
			md: [
				{ i: 'stats', x: 0, y: 0, w: 8, h: 2 },
				{ i: 'notes-chart', x: 0, y: 2, w: 8, h: 8 },
				{ i: 'onboarding', x: 0, y: 10, w: 4, h: 10 },
				{ i: 'leaderboard', x: 4, y: 10, w: 4, h: 10 },
			],
		},
	}
}

export function emptyDashboardConfig(): DashboardConfig {
	return {
		version: DASHBOARD_CONFIG_VERSION,
		blocks: [],
		layouts: { lg: [], md: [] },
	}
}

/** Whether another block of this type fits the block and per-type limits. */
export function canAddBlockType(
	blocks: readonly DashboardBlock[],
	type: BlockType,
) {
	if (blocks.length >= MAX_DASHBOARD_BLOCKS) return false
	const count = blocks.filter((block) => block.type === type).length
	return count < BLOCK_DEFINITIONS[type].maxInstances
}

/**
 * The built-in blocks a dashboard can still take. Onboarding is only offered
 * while the viewer would see it, since a completed or dismissed checklist is
 * not shown at all. Bookings today is only offered to viewers who may read
 * reservations while the module is on.
 */
export function addableBuiltInBlockTypes(
	blocks: readonly DashboardBlock[],
	{
		onboardingAvailable,
		bookingsTodayAvailable,
	}: { onboardingAvailable: boolean; bookingsTodayAvailable: boolean },
): BuiltInBlockType[] {
	return BUILT_IN_BLOCK_TYPES.filter(
		(type) =>
			canAddBlockType(blocks, type) &&
			(type !== 'onboarding' || onboardingAvailable) &&
			(type !== 'bookings-today' || bookingsTodayAvailable),
	)
}

export type DashboardNameErrorCode = 'name-required' | 'name-too-long'

const DASHBOARD_NAME_ERRORS: Record<DashboardNameErrorCode, string> = {
	'name-required': 'Enter a dashboard name.',
	'name-too-long': `Use ${DASHBOARD_NAME_MAX_LENGTH} characters or fewer.`,
}

export const dashboardNameSchema = z
	.string({ required_error: DASHBOARD_NAME_ERRORS['name-required'] })
	.trim()
	.min(1, DASHBOARD_NAME_ERRORS['name-required'])
	.max(DASHBOARD_NAME_MAX_LENGTH, DASHBOARD_NAME_ERRORS['name-too-long'])

export type DashboardNameResult =
	| { success: true; name: string }
	| { success: false; code: DashboardNameErrorCode; message: string }

/** Trims a submitted dashboard name and checks that it has 1 to 60 characters. */
export function validateDashboardName(value: unknown): DashboardNameResult {
	const result = dashboardNameSchema.safeParse(value ?? '')
	if (result.success) return { success: true, name: result.data }
	const code: DashboardNameErrorCode = result.error.issues.some(
		(issue) => issue.code === 'too_big',
	)
		? 'name-too-long'
		: 'name-required'
	return { success: false, code, message: DASHBOARD_NAME_ERRORS[code] }
}
