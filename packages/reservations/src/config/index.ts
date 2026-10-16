import { z } from 'zod'
import { isValidTimeZone } from '../time.ts'

export const INTERVAL_MIN_VALUES = [5, 10, 15, 20, 30, 60] as const
export type IntervalMinValue = (typeof INTERVAL_MIN_VALUES)[number]

export const LARGE_PARTY_MODES = ['disabled', 'request', 'call_only'] as const
export type LargePartyMode = (typeof LARGE_PARTY_MODES)[number]

export const SEATING_PREFERENCES = ['any', 'indoor', 'outdoor', 'bar'] as const
export type SeatingPreference = (typeof SEATING_PREFERENCES)[number]

export const SEATING_PREFERENCE_MODES = ['off', 'preference', 'strict'] as const
export type SeatingPreferenceMode = (typeof SEATING_PREFERENCE_MODES)[number]

export const POLICY_MODES = ['none', 'card_hold', 'deposit', 'prepay'] as const
export type PolicyMode = (typeof POLICY_MODES)[number]

export const TABLE_SHAPES = ['round', 'square', 'rect', 'booth', 'bar'] as const
export type TableShape = (typeof TABLE_SHAPES)[number]

export const COMBINATION_TYPES = ['adjacent', 'manual'] as const
export type CombinationType = (typeof COMBINATION_TYPES)[number]

export const SERVICE_TABLE_MODES = [
	'online',
	'staff_only',
	'walk_in_only',
	'unavailable',
] as const
export type ServiceTableMode = (typeof SERVICE_TABLE_MODES)[number]

export const SPECIAL_DAY_TYPES = [
	'closed',
	'online_closed',
	'modified',
	'replace',
] as const
export type SpecialDayType = (typeof SPECIAL_DAY_TYPES)[number]

export const DECOR_ELEMENT_KINDS = [
	'wall',
	'bar',
	'door',
	'window',
	'label',
	'plant',
	'zone',
] as const
export type DecorElementKind = (typeof DECOR_ELEMENT_KINDS)[number]

export const hexColorSchema = z
	.string()
	.regex(/^#[0-9A-Fa-f]{6}$/, 'Use a 6-digit hex color such as #2563EB')

export const businessDateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
	.refine((value) => {
		const [y, m, d] = value.split('-').map(Number) as [number, number, number]
		const date = new Date(Date.UTC(y, m - 1, d))
		return (
			date.getUTCFullYear() === y &&
			date.getUTCMonth() === m - 1 &&
			date.getUTCDate() === d
		)
	}, 'Not a valid calendar date')

export const timeZoneSchema = z
	.string()
	.min(1)
	.max(80)
	.refine(isValidTimeZone, 'Not a valid IANA time zone')

export const intervalMinSchema = z
	.number()
	.int()
	.refine(
		(val): val is IntervalMinValue =>
			(INTERVAL_MIN_VALUES as readonly number[]).includes(val),
		'intervalMin must be one of 5, 10, 15, 20, 30, 60',
	)

export const locationSettingsSchema = z
	.object({
		enabled: z.boolean().default(true),
		onlineEnabled: z.boolean().default(true),
		dayStartMin: z.number().int().min(0).max(720).default(240),
		intervalMin: intervalMinSchema.default(15),
		horizonDays: z.number().int().min(1).max(365).default(60),
		releaseLocalMin: z.number().int().min(0).max(1439).default(0),
		minNoticeMin: z.number().int().min(0).max(10_080).default(30),
		sameDayCutoffMin: z
			.number()
			.int()
			.min(0)
			.max(1439)
			.nullable()
			.default(null),
		minParty: z.number().int().min(1).max(100).default(1),
		maxOnlineParty: z.number().int().min(1).max(100).default(8),
		maxParty: z.number().int().min(1).max(200).default(16),
		largePartyMode: z.enum(LARGE_PARTY_MODES).default('request'),
		seatingPreferenceMode: z.enum(SEATING_PREFERENCES).default('any'),
		defaultTurnMin: z.number().int().min(15).max(720).default(90),
		bufferMin: z.number().int().min(0).max(240).default(15),
		holdTtlSec: z.number().int().min(0).max(3600).default(300),
		assignmentFreezeMin: z.number().int().min(0).max(1440).default(60),
		graceMin: z.number().int().min(0).max(240).default(15),
		autoNoShowMin: z.number().int().min(0).max(720).nullable().default(null),
		maxActivePerPhone: z.number().int().min(1).max(50).default(3),
		modifyCutoffMin: z.number().int().min(0).max(10_080).default(120),
		waitlistEnabled: z.boolean().default(true),
		notifyMeEnabled: z.boolean().default(true),
		expectedVersion: z.number().int().min(1).optional(),
	})
	.strict()
	.superRefine((val, ctx) => {
		if (val.minParty > val.maxOnlineParty) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['minParty'],
				message: 'minParty must be <= maxOnlineParty',
			})
		}
		if (val.maxOnlineParty > val.maxParty) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['maxOnlineParty'],
				message: 'maxOnlineParty must be <= maxParty',
			})
		}
	})

export type LocationSettingsConfig = z.infer<typeof locationSettingsSchema>

export const diningAreaSchema = z
	.object({
		id: z.string().min(1).max(64),
		name: z.string().trim().min(1).max(120),
		color: hexColorSchema,
		isOutdoor: z.boolean().default(false),
		sortOrder: z.number().int().min(0).max(10_000).default(0),
		active: z.boolean().default(true),
	})
	.strict()

export type DiningAreaConfig = z.infer<typeof diningAreaSchema>

export const tableSchema = z
	.object({
		id: z.string().min(1).max(64),
		areaId: z.string().min(1).max(64),
		label: z.string().trim().min(1).max(40),
		shape: z.enum(TABLE_SHAPES).default('square'),
		minSeats: z.number().int().min(1).max(100),
		maxSeats: z.number().int().min(1).max(100),
		onlineBookable: z.boolean().default(true),
		combinable: z.boolean().default(true),
		priority: z.number().int().min(-1000).max(1000).default(0),
		isAccessible: z.boolean().default(false),
		isHighTop: z.boolean().default(false),
		isWindow: z.boolean().default(false),
		isBooth: z.boolean().default(false),
		isPatio: z.boolean().default(false),
		isBar: z.boolean().default(false),
		x: z.number().min(0).max(10_000).default(0),
		y: z.number().min(0).max(10_000).default(0),
		width: z.number().min(10).max(2_000).default(60),
		height: z.number().min(10).max(2_000).default(60),
		rotation: z.number().min(-360).max(360).default(0),
		active: z.boolean().default(true),
	})
	.strict()
	.superRefine((val, ctx) => {
		if (val.minSeats > val.maxSeats) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['minSeats'],
				message: 'minSeats must be <= maxSeats',
			})
		}
	})

export type TableConfig = z.infer<typeof tableSchema>

export function canonicalCombinationSignature(
	tableIds: readonly string[],
): string {
	return [...new Set(tableIds.map((t) => t.trim()))].sort().join(',')
}

export const combinationSchema = z
	.object({
		id: z.string().min(1).max(64),
		name: z.string().trim().min(1).max(120),
		type: z.enum(COMBINATION_TYPES).default('adjacent'),
		minSeats: z.number().int().min(1).max(200),
		maxSeats: z.number().int().min(1).max(200),
		priority: z.number().int().min(-1000).max(1000).default(0),
		onlineBookable: z.boolean().default(true),
		active: z.boolean().default(true),
		tableIds: z.array(z.string().min(1).max(64)).min(2).max(20),
	})
	.strict()
	.superRefine((val, ctx) => {
		if (val.minSeats > val.maxSeats) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['minSeats'],
				message: 'minSeats must be <= maxSeats',
			})
		}
		const distinct = new Set(val.tableIds)
		if (distinct.size < 2 || distinct.size !== val.tableIds.length) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['tableIds'],
				message: 'Combination must reference at least 2 distinct tableIds',
			})
		}
	})

export type CombinationConfig = z.infer<typeof combinationSchema>

export const decorElementSchema = z
	.object({
		id: z.string().min(1).max(64),
		areaId: z.string().min(1).max(64),
		kind: z.enum(DECOR_ELEMENT_KINDS),
		label: z.string().trim().max(120).nullable().default(null),
		x: z.number().min(0).max(10_000),
		y: z.number().min(0).max(10_000),
		width: z.number().min(1).max(5_000),
		height: z.number().min(1).max(5_000),
		rotation: z.number().min(-360).max(360).default(0),
	})
	.strict()

export type DecorElementConfig = z.infer<typeof decorElementSchema>

export const floorPlanTableGeometrySchema = z
	.object({
		id: z.string().min(1).max(64),
		areaId: z.string().min(1).max(64).optional(),
		label: z.string().trim().min(1).max(40).optional(),
		shape: z.enum(TABLE_SHAPES).optional(),
		minSeats: z.number().int().min(1).max(100).optional(),
		maxSeats: z.number().int().min(1).max(100).optional(),
		x: z.number().min(0).max(10_000),
		y: z.number().min(0).max(10_000),
		width: z.number().min(10).max(2_000),
		height: z.number().min(10).max(2_000),
		rotation: z.number().min(-360).max(360).default(0),
	})
	.strict()

export const floorPlanSaveSchema = z
	.object({
		expectedFloorPlanVersion: z.number().int().min(1),
		tables: z.array(floorPlanTableGeometrySchema).max(500),
		decorElements: z.array(decorElementSchema).max(500),
	})
	.strict()

export type FloorPlanSaveInput = z.infer<typeof floorPlanSaveSchema>

export const serviceSchema = z
	.object({
		id: z.string().min(1).max(64),
		name: z.string().trim().min(1).max(120),
		slug: z
			.string()
			.trim()
			.min(1)
			.max(80)
			.regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric and dashes'),
		color: hexColorSchema,
		daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
		startMin: z.number().int().min(0).max(1439),
		firstSeatingMin: z.number().int().min(0).max(2880).optional(),
		endMin: z.number().int().min(1).max(2880),
		lastSeatingMin: z.number().int().min(0).max(2880),
		effectiveFrom: businessDateSchema.nullable().optional(),
		effectiveTo: businessDateSchema.nullable().optional(),
		priority: z.number().int().min(-1000).max(10_000).default(0),
		onlineBookable: z.boolean().default(true),
		sortOrder: z.number().int().min(0).max(10_000).default(0),
		active: z.boolean().default(true),
	})
	.strict()
	.superRefine((val, ctx) => {
		const firstSeatingMin = val.firstSeatingMin ?? val.startMin
		if (val.endMin <= val.startMin) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['endMin'],
				message: 'endMin must be greater than startMin',
			})
		}
		if (
			val.lastSeatingMin < firstSeatingMin ||
			val.lastSeatingMin > val.endMin
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['lastSeatingMin'],
				message: 'lastSeatingMin must lie within [firstSeatingMin, endMin]',
			})
		}
		if (
			val.endMin - firstSeatingMin > 1440 ||
			val.endMin - val.startMin > 1440
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['endMin'],
				message: 'Service window duration must not exceed 1440 minutes (24h)',
			})
		}
	})

export type ServiceConfig = z.infer<typeof serviceSchema>

export const turnTimeBucketSchema = z
	.object({
		id: z.string().min(1).max(64),
		serviceId: z.string().min(1).max(64).nullable(),
		minParty: z.number().int().min(1).max(200),
		maxParty: z.number().int().min(1).max(200),
		durationMin: z.number().int().min(1).max(720),
	})
	.strict()
	.superRefine((val, ctx) => {
		if (val.minParty > val.maxParty) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['minParty'],
				message: 'minParty must be <= maxParty',
			})
		}
	})

export type TurnTimeBucketConfig = z.infer<typeof turnTimeBucketSchema>

export const pacingRuleSchema = z
	.object({
		id: z.string().min(1).max(64),
		serviceId: z.string().min(1).max(64),
		areaId: z.string().min(1).max(64).nullable().default(null),
		windowStartMin: z.number().int().min(0).max(2880).nullable().default(null),
		windowEndMin: z.number().int().min(0).max(2880).nullable().default(null),
		maxCoversPerSlot: z
			.number()
			.int()
			.min(1)
			.max(2000)
			.nullable()
			.default(null),
		maxPartiesPerSlot: z
			.number()
			.int()
			.min(1)
			.max(500)
			.nullable()
			.default(null),
		maxOnlineCoversForService: z
			.number()
			.int()
			.min(1)
			.max(10_000)
			.nullable()
			.default(null),
	})
	.strict()
	.superRefine((val, ctx) => {
		if (
			val.windowStartMin !== null &&
			val.windowEndMin !== null &&
			val.windowEndMin <= val.windowStartMin
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['windowEndMin'],
				message: 'windowEndMin must be greater than windowStartMin',
			})
		}
	})

export type PacingRuleConfig = z.infer<typeof pacingRuleSchema>

export const serviceTableAvailabilitySchema = z
	.object({
		id: z.string().min(1).max(64).optional(),
		serviceId: z.string().min(1).max(64),
		tableId: z.string().min(1).max(64).nullable().default(null),
		combinationId: z.string().min(1).max(64).nullable().default(null),
		mode: z.enum(SERVICE_TABLE_MODES),
	})
	.strict()
	.superRefine((val, ctx) => {
		const hasTable = val.tableId !== null
		const hasCombo = val.combinationId !== null
		if (hasTable === hasCombo) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['tableId'],
				message: 'Exactly one of tableId or combinationId must be set',
			})
		}
	})

export type ServiceTableAvailabilityConfig = z.infer<
	typeof serviceTableAvailabilitySchema
>

export const customServiceEntrySchema = z
	.object({
		id: z.string().min(1).max(64),
		serviceId: z.string().min(1).max(64).optional(),
		name: z.string().trim().min(1).max(120),
		slug: z.string().trim().min(1).max(80).optional(),
		color: hexColorSchema.optional(),
		startMin: z.number().int().min(0).max(1439),
		firstSeatingMin: z.number().int().min(0).max(2880).optional(),
		endMin: z.number().int().min(1).max(2880),
		lastSeatingMin: z.number().int().min(0).max(2880),
		priority: z.number().int().min(-1000).max(10_000).default(0),
		onlineBookable: z.boolean().default(true),
		sortOrder: z.number().int().min(0).max(10_000).default(0),
		active: z.boolean().default(true),
	})
	.strict()
	.superRefine((val, ctx) => {
		const firstSeatingMin = val.firstSeatingMin ?? val.startMin
		if (val.endMin <= val.startMin) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['endMin'],
				message: 'endMin must be greater than startMin',
			})
		}
		if (
			val.lastSeatingMin < firstSeatingMin ||
			val.lastSeatingMin > val.endMin
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['lastSeatingMin'],
				message: 'lastSeatingMin must lie within [firstSeatingMin, endMin]',
			})
		}
		if (
			val.endMin - firstSeatingMin > 1440 ||
			val.endMin - val.startMin > 1440
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['endMin'],
				message: 'Service window duration must not exceed 1440 minutes (24h)',
			})
		}
	})

export type CustomServiceEntryConfig = z.infer<typeof customServiceEntrySchema>

export const specialDaySchema = z
	.object({
		id: z.string().min(1).max(64),
		businessDate: businessDateSchema,
		type: z.enum(SPECIAL_DAY_TYPES),
		name: z.string().trim().min(1).max(120).nullable().default(null),
		note: z.string().trim().max(500).nullable().default(null),
		customServices: z.array(customServiceEntrySchema).nullable().default(null),
	})
	.strict()

export type SpecialDayConfig = z.infer<typeof specialDaySchema>

export const policyRuleSchema = z
	.object({
		id: z.string().min(1).max(64),
		name: z.string().trim().min(1).max(120).optional(),
		mode: z.enum(POLICY_MODES),
		amountPerCoverMinor: z.number().int().min(0).max(10_000_000).default(0),
		flatAmountMinor: z.number().int().min(0).max(10_000_000).optional(),
		currency: z
			.string()
			.trim()
			.regex(/^[A-Z]{3}$/)
			.default('USD'),
		cancelCutoffMin: z
			.number()
			.int()
			.min(0)
			.max(30 * 1440)
			.default(1440),
		minParty: z.number().int().min(1).max(200).default(1),
		maxParty: z.number().int().min(1).max(200).optional().nullable(),
		serviceId: z.string().min(1).max(64).optional().nullable(),
		daysOfWeek: z.array(z.number().int().min(0).max(6)).optional().nullable(),
		dates: z.array(businessDateSchema).optional().nullable(),
		windowStartMin: z.number().int().min(0).max(2880).optional().nullable(),
		windowEndMin: z.number().int().min(0).max(2880).optional().nullable(),
		priority: z.number().int().min(-1000).max(10_000).default(0),
		active: z.boolean().default(true),
	})
	.strict()
	.superRefine((val, ctx) => {
		if (
			val.maxParty !== undefined &&
			val.maxParty !== null &&
			val.minParty > val.maxParty
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['minParty'],
				message: 'minParty must be <= maxParty',
			})
		}
		if (
			val.windowStartMin !== undefined &&
			val.windowStartMin !== null &&
			val.windowEndMin !== undefined &&
			val.windowEndMin !== null &&
			val.windowEndMin <= val.windowStartMin
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['windowEndMin'],
				message: 'windowEndMin must be greater than windowStartMin',
			})
		}
	})

export type PolicyRuleConfig = z.infer<typeof policyRuleSchema>

export const tableBlockSchema = z
	.object({
		id: z.string().min(1).max(64),
		businessDate: businessDateSchema.optional(),
		tableId: z.string().min(1).max(64).nullable().optional(),
		tableIds: z.array(z.string().min(1).max(64)).min(1).optional(),
		areaId: z.string().min(1).max(64).nullable().optional(),
		startMin: z.number().int().min(0).max(2880).optional(),
		endMin: z.number().int().min(1).max(2880).optional(),
		startAt: z.number().int().min(0).optional(),
		endAt: z.number().int().min(1).optional(),
		startAtMs: z.number().int().min(0).optional(),
		endAtMs: z.number().int().min(1).optional(),
		reason: z.string().trim().max(240).nullable().optional(),
	})
	.strict()
	.superRefine((val, ctx) => {
		if (
			val.startMin !== undefined &&
			val.endMin !== undefined &&
			val.endMin <= val.startMin
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['endMin'],
				message: 'endMin must be greater than startMin',
			})
		}
		if (
			val.startAt !== undefined &&
			val.endAt !== undefined &&
			val.endAt <= val.startAt
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['endAt'],
				message: 'endAt must be greater than startAt',
			})
		}
		if (
			val.startAtMs !== undefined &&
			val.endAtMs !== undefined &&
			val.endAtMs <= val.startAtMs
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['endAtMs'],
				message: 'endAtMs must be greater than startAtMs',
			})
		}
	})

export type TableBlockConfig = z.infer<typeof tableBlockSchema>

export const locationConfigSchema = z
	.object({
		settings: locationSettingsSchema,
		areas: z.array(diningAreaSchema).default([]),
		tables: z.array(tableSchema),
		combinations: z.array(combinationSchema).default([]),
		decorElements: z.array(decorElementSchema).default([]),
		services: z.array(serviceSchema).default([]),
		turnTimeBuckets: z.array(turnTimeBucketSchema).default([]),
		pacingRules: z.array(pacingRuleSchema).default([]),
		serviceTableAvailability: z
			.array(serviceTableAvailabilitySchema)
			.default([]),
		specialDays: z.array(specialDaySchema).default([]),
		policies: z.array(policyRuleSchema).default([]),
		blocks: z.array(tableBlockSchema).default([]),
	})
	.strict()

export type LocationConfig = z.infer<typeof locationConfigSchema>

// Helpful aliases
export const areaConfigSchema = diningAreaSchema
export const tableConfigSchema = tableSchema
export const combinationConfigSchema = combinationSchema
export const serviceConfigSchema = serviceSchema
export const serviceTableModeRuleSchema = serviceTableAvailabilitySchema
export const specialDayConfigSchema = specialDaySchema
export const servicePatchSchema = customServiceEntrySchema
export const blockSchema = tableBlockSchema
export const blockConfigSchema = tableBlockSchema
export type BlockConfig = TableBlockConfig
export type ServicePatchConfig = CustomServiceEntryConfig
