import { z } from 'zod'

export const REPORT_DSL_VERSION = 1 as const

export const chartStyleSchema = z.enum(['pie', 'single_number', 'table', 'bar'])
export type ChartStyle = z.infer<typeof chartStyleSchema>

export const measureSchema = z.enum(['count', 'percent', 'sum', 'average'])
export type Measure = z.infer<typeof measureSchema>
export type ValueMeasure = Extract<Measure, 'sum' | 'average'>

/** Sum and average read a numeric field instead of counting records. */
export function isValueMeasure(measure: Measure): measure is ValueMeasure {
	return measure === 'sum' || measure === 'average'
}

export const sortBySchema = z.enum(['none', 'label', 'value_asc', 'value_desc'])
export type SortBy = z.infer<typeof sortBySchema>

export const timeframePresetSchema = z.enum([
	'today',
	'last_7_days',
	'last_30_days',
	'last_3_months',
	'last_6_months',
	'last_12_months',
	'all_time',
	'custom',
])
export type TimeframePreset = z.infer<typeof timeframePresetSchema>

export const filterOperatorSchema = z.enum([
	'eq',
	'neq',
	'contains',
	'starts_with',
	'is_empty',
	'is_not_empty',
	'in',
])
export type FilterOperator = z.infer<typeof filterOperatorSchema>

export const filterConditionSchema = z.object({
	field: z.string().min(1),
	operator: filterOperatorSchema,
	value: z
		.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
		.optional(),
})
export type FilterCondition = z.infer<typeof filterConditionSchema>

export type FilterGroup = {
	combinator: 'and' | 'or'
	not?: boolean
	conditions: Array<FilterCondition | FilterGroup>
}

export const filterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
	z.object({
		combinator: z.enum(['and', 'or']),
		not: z.boolean().optional(),
		conditions: z.array(z.union([filterConditionSchema, filterGroupSchema])),
	}),
)

export const timeframeSchema = z.object({
	field: z.string().min(1),
	preset: timeframePresetSchema,
	start: z.string().datetime().optional(),
	end: z.string().datetime().optional(),
})
export type ReportTimeframe = z.infer<typeof timeframeSchema>

export const timeBucketSchema = z.enum(['week', 'month'])
export type TimeBucket = z.infer<typeof timeBucketSchema>

export const visualizationSchema = z.object({
	chartStyle: chartStyleSchema,
	measure: measureSchema.default('count'),
	/** Number or currency field that sum and average read. */
	valueField: z.string().min(1).optional(),
	sortBy: sortBySchema.default('none'),
	hideCounts: z.boolean().default(false),
})
export type ReportVisualization = z.infer<typeof visualizationSchema>

export const reportSettingsSchema = z.object({
	title: z.string().min(1).max(120),
	notes: z.string().max(4000).default(''),
	timezone: z.string().min(1).default('user'),
})
export type ReportSettings = z.infer<typeof reportSettingsSchema>

export const reportDefinitionSchema = z.object({
	version: z.literal(REPORT_DSL_VERSION),
	subject: z.string().min(1),
	timeframe: timeframeSchema,
	groupBy: z.array(z.string().min(1)).max(3).default([]),
	timeBucket: timeBucketSchema.default('month'),
	columns: z.array(z.string().min(1)).max(8).default([]),
	filters: filterGroupSchema.default({ combinator: 'and', conditions: [] }),
	advancedFilters: z.boolean().default(false),
	visualization: visualizationSchema,
	settings: reportSettingsSchema,
})
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>

export function isListReport(definition: ReportDefinition) {
	return (
		definition.visualization.chartStyle === 'table' &&
		definition.groupBy.length === 0
	)
}

export function emptyFilterGroup(): FilterGroup {
	return { combinator: 'and', conditions: [] }
}

export function isFilterGroup(
	value: FilterCondition | FilterGroup,
): value is FilterGroup {
	return (
		typeof value === 'object' &&
		value !== null &&
		'combinator' in value &&
		'conditions' in value
	)
}

export function flattenFilterConditions(group: FilterGroup): FilterCondition[] {
	const conditions: FilterCondition[] = []
	for (const item of group.conditions) {
		if (isFilterGroup(item)) {
			conditions.push(...flattenFilterConditions(item))
		} else {
			conditions.push(item)
		}
	}
	return conditions
}

export function countFilterConditions(group: FilterGroup): number {
	return group.conditions.reduce(
		(total, item) =>
			total + (isFilterGroup(item) ? countFilterConditions(item) : 1),
		0,
	)
}

export function createReportDefinition(
	partial: Partial<ReportDefinition> &
		Pick<
			ReportDefinition,
			'subject' | 'timeframe' | 'visualization' | 'settings'
		>,
): ReportDefinition {
	return reportDefinitionSchema.parse({
		version: REPORT_DSL_VERSION,
		groupBy: [],
		timeBucket: 'month',
		columns: [],
		filters: emptyFilterGroup(),
		advancedFilters: false,
		...partial,
	})
}

export type ReportSegment = {
	key: string
	label: string
	count: number
	percent: number
	/** Sum or average of the value field, set when the report measures one. */
	value?: number
}

export type ReportColumn = {
	id: string
	label: string
}

export type ReportValueInfo = {
	measure: ValueMeasure
	field: string
	/** Display name for the measured value, for example "Average sales". */
	label: string
	type: 'number' | 'currency'
	/** Currency every measured amount shares. */
	currency?: string
	/**
	 * The amounts are in more than one currency. They can't be added together,
	 * so the result and its segments carry no value.
	 */
	mixedCurrencies?: boolean
}

export type ReportResult = {
	total: number
	/** Sum or average of the value field over every matched record. */
	value?: number
	valueInfo?: ReportValueInfo
	segments: ReportSegment[]
	columns?: ReportColumn[]
	rows?: Array<Record<string, string>>
	truncated?: boolean
	/**
	 * The source held more records than a report reads, so results only cover
	 * the most recent `sourceRowLimit` of them.
	 */
	sourceTruncated?: boolean
	sourceRowLimit?: number
	refreshedAt: string
}

export type ReportRunErrorCode =
	| 'invalid_definition'
	| 'unknown_subject'
	| 'missing_group_by'
	| 'tenant_not_provisioned'
	| 'unauthorized'
	| 'region_mismatch'

export type ReportRunError = {
	error: ReportRunErrorCode
	message: string
}
