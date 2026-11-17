import { z } from 'zod'

export const REPORT_DSL_VERSION = 1 as const

export const chartStyleSchema = z.enum(['pie', 'single_number', 'table', 'bar'])
export type ChartStyle = z.infer<typeof chartStyleSchema>

export const measureSchema = z.enum([
	'count',
	'percent',
	'sum',
	'average',
	'ratio',
])
export type Measure = z.infer<typeof measureSchema>
export type ValueMeasure = Extract<Measure, 'sum' | 'average'>

/** Sum and average read a numeric field instead of counting records. */
export function isValueMeasure(measure: Measure): measure is ValueMeasure {
	return measure === 'sum' || measure === 'average'
}

/**
 * A ratio divides one sum by another (labor cost over sales). It reads a
 * ratio field the subject defines and is always the ratio of the two sums over
 * the whole group, never an average of per-record ratios.
 */
export function isRatioMeasure(measure: Measure): measure is 'ratio' {
	return measure === 'ratio'
}

/** Measures that read `visualization.valueField` instead of counting. */
export function measuresAValueField(measure: Measure) {
	return isValueMeasure(measure) || isRatioMeasure(measure)
}

export const sortBySchema = z.enum(['none', 'label', 'value_asc', 'value_desc'])
export type SortBy = z.infer<typeof sortBySchema>

export const timeframePresetSchema = z.enum([
	'today',
	'yesterday',
	'last_7_days',
	'last_14_days',
	'last_21_days',
	'last_28_days',
	'last_30_days',
	'last_3_months',
	'last_6_months',
	'last_12_months',
	'last_complete_week',
	'last_complete_month',
	'month_to_date',
	'all_time',
	'custom',
])
export type TimeframePreset = z.infer<typeof timeframePresetSchema>

export const compareSchema = z.enum([
	'none',
	'previous_period',
	'previous_year',
])
export type ReportCompare = z.infer<typeof compareSchema>

export const timeBasisSchema = z.enum(['placed', 'fulfillment'])
export type TimeBasis = z.infer<typeof timeBasisSchema>

export const salesBasisSchema = z.enum(['gross', 'net'])
export type SalesBasis = z.infer<typeof salesBasisSchema>

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

export const timeBucketSchema = z.enum([
	'day',
	'week',
	'month',
	'hour_of_day',
	'day_of_week',
])
export type TimeBucket = z.infer<typeof timeBucketSchema>

export const visualizationSchema = z.object({
	chartStyle: chartStyleSchema,
	measure: measureSchema.default('count'),
	/** Number, currency or duration field that sum and average read; a ratio field for the ratio measure. */
	valueField: z.string().min(1).optional(),
	sortBy: sortBySchema.default('none'),
	hideCounts: z.boolean().default(false),
})
export type ReportVisualization = z.infer<typeof visualizationSchema>

export const reportSettingsSchema = z.object({
	title: z.string().min(1).max(120),
	notes: z.string().max(4000).default(''),
	timezone: z.string().min(1).default('user'),
	/**
	 * Rolling ranges ("last 7 days", "month to date") include the current local
	 * day. Off, they end with yesterday, so every day in the range is complete.
	 */
	includeToday: z.boolean().default(true),
	/**
	 * Leave periods that are not complete (the current day, a week cut by the
	 * range) off a chart over time. The result still says how many were left
	 * out: partial data is labelled, never silently dropped.
	 */
	hidePartial: z.boolean().default(false),
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
	/** Run the same report over an earlier period and show the change (#120). */
	compare: compareSchema.default('none'),
	/**
	 * Order subjects: date orders by when they were placed or when they were
	 * fulfilled (#310). Subjects without the choice ignore it.
	 */
	timeBasis: timeBasisSchema.default('placed'),
	/**
	 * Sales subject: whether the "Sales" figure is gross or net (#331). Reports
	 * that measure another field ignore it.
	 */
	salesBasis: salesBasisSchema.default('net'),
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

type ReportDefinitionInput = z.input<typeof reportDefinitionSchema>

export function createReportDefinition(
	partial: Partial<ReportDefinitionInput> &
		Pick<
			ReportDefinitionInput,
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
		compare: 'none',
		timeBasis: 'placed',
		salesBasis: 'net',
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
	/**
	 * Comparison runs: the same figure (the measured value, else the count) in
	 * the earlier period. Left out when that period has no such bucket.
	 */
	previousValue?: number
	/** Comparison runs over time: the earlier period's bucket this one is set against. */
	previousLabel?: string
	/** Percent change from the earlier period. Left out when that value was 0 or unknown. */
	changePercent?: number
	/** The change in words ("Up 12.5%", "Down 3%", "No change"), so it never rests on color. */
	changeLabel?: string
	/** Over time: the period is not complete (today, or a week or month the range cuts). */
	partial?: boolean
	/** Set when amounts in several currencies were split into one segment each. */
	currency?: string
}

/** A range of instants a run covered, as ISO strings (`start` null: no lower bound). */
export type ReportPeriod = { start: string | null; end: string }

export type ReportColumn = {
	id: string
	label: string
}

export type ReportValueInfo = {
	measure: ValueMeasure | 'ratio'
	field: string
	/** Display name for the measured value, for example "Average sales". */
	label: string
	/**
	 * `duration` values are minutes. `percent` is a ratio shown as a percentage
	 * (12.5 means 12.5%).
	 */
	type: 'number' | 'currency' | 'duration' | 'percent'
	/** Currency every measured amount shares. */
	currency?: string
	/**
	 * The amounts are in more than one currency. They can't be added together,
	 * so the result and its segments carry no value.
	 */
	mixedCurrencies?: boolean
	/** The ratio is per hour (for example sales per labor hour). */
	perHour?: boolean
	/**
	 * Amounts were in more than one currency and the report is grouped, so each
	 * currency got its own segments (`segment.currency`); there is no overall
	 * value.
	 */
	currencySplit?: boolean
	/**
	 * Ratio only: matched records left out because they lacked the numerator
	 * or the denominator (a day with wages and no sales).
	 */
	excluded?: number
	/** Ratio only: what the figure rests on (sales source, estimates), shown with it. */
	note?: string
}

export type ReportResult = {
	total: number
	/** Sum, average or ratio of the value field over every matched record. */
	value?: number
	/** Comparison runs: the headline figure (measured value, else the count) in the earlier period. */
	previousValue?: number
	changePercent?: number
	changeLabel?: string
	/** The period the run covered, and the earlier one it was compared with. */
	period?: ReportPeriod
	previousPeriod?: ReportPeriod
	/** Which comparison ran. */
	compare?: Exclude<ReportCompare, 'none'>
	/** Incomplete periods left off because the report hides them. */
	partialHidden?: number
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
	/** The time zone days, weeks and months were cut in (IANA name). */
	timeZone?: string
	/** Order subjects: which time the orders were dated by. */
	timeBasis?: TimeBasis
	/** Set when the measured figure was the gross-or-net "Sales" figure. */
	salesBasis?: SalesBasis
}

export type ReportRunErrorCode =
	| 'invalid_definition'
	| 'unknown_subject'
	| 'missing_group_by'
	| 'tenant_not_provisioned'
	| 'unauthorized'
	| 'region_mismatch'
	| 'report_range_too_long'

export type ReportRunError = {
	error: ReportRunErrorCode
	message: string
}
