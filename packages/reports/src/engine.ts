import {
	addDays,
	formatDate,
	isValidTimeZone,
	localParts,
	parseDate,
	weekStartFor,
	zonedLocalToUtc,
} from '@repo/staffing'
import {
	type FilterCondition,
	type FilterGroup,
	type ReportDefinition,
	type ReportResult,
	type ReportRunError,
	type ReportSegment,
	type ReportValueInfo,
	type TimeBucket,
	type TimeframePreset,
	type ValueMeasure,
	flattenFilterConditions,
	isFilterGroup,
	isListReport,
	isRatioMeasure,
	measuresAValueField,
} from './dsl.ts'
import {
	type ReportCatalog,
	type ReportField,
	type ReportSubject,
	defaultListColumns,
	getField,
	getSubject,
	isValueFieldType,
	valueMeasureLabel,
} from './catalog.ts'
import { formatCurrency, formatDuration, formatNumber } from './format.ts'

export type ReportRecord = Record<string, unknown>

const MAX_LIST_ROWS = 200

function asNumber(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null
	if (typeof value === 'string' && value.trim().length > 0) {
		const parsed = Number(value)
		return Number.isFinite(parsed) ? parsed : null
	}
	return null
}

function asDate(value: unknown): Date | null {
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value
	if (typeof value === 'number' && Number.isFinite(value)) {
		const ms = value < 1e12 ? value * 1000 : value
		const date = new Date(ms)
		return Number.isNaN(date.getTime()) ? null : date
	}
	if (typeof value === 'string' && value.length > 0) {
		const date = new Date(value)
		return Number.isNaN(date.getTime()) ? null : date
	}
	return null
}

function asString(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (typeof value === 'boolean') return value ? 'true' : 'false'
	return String(value)
}

/** Where days, weeks and months are cut when a report names no zone. */
export const DEFAULT_REPORT_TIME_ZONE = 'UTC'

/**
 * The IANA zone a report is cut in. `user` follows the viewer's zone (sent by
 * their browser; UTC when a caller sends none), `UTC` and any other valid zone
 * name are used as given, and anything unrecognized falls back to UTC so a
 * crafted value can never throw.
 */
export function resolveReportTimeZone(
	setting: string | undefined,
	userTimeZone?: string | null,
): string {
	if (setting && setting !== 'user') {
		return isValidTimeZone(setting) ? setting : DEFAULT_REPORT_TIME_ZONE
	}
	return userTimeZone && isValidTimeZone(userTimeZone)
		? userTimeZone
		: DEFAULT_REPORT_TIME_ZONE
}

/**
 * The zone to run a report in for a request body of the form
 * `{ definition, timeZone? }`, where `timeZone` is the viewer's own zone.
 */
export function reportTimeZoneForRequest(
	definition: Pick<ReportDefinition, 'settings'>,
	body: unknown,
): string {
	const sent =
		body && typeof body === 'object' && 'timeZone' in body
			? (body as { timeZone?: unknown }).timeZone
			: undefined
	return resolveReportTimeZone(
		definition.settings.timezone,
		typeof sent === 'string' && sent.length <= 64 ? sent : undefined,
	)
}

/** The calendar date (`YYYY-MM-DD`) an instant falls on in `timeZone`. */
export function localDateIn(date: Date, timeZone: string): string {
	const parts = localParts(date.getTime(), timeZone)
	return formatDate(parts.year, parts.month, parts.day)
}

/** The instant a local calendar day begins in `timeZone` (DST safe). */
export function startOfLocalDay(date: string, timeZone: string): Date {
	const { year, month, day } = parseDate(date)
	return new Date(zonedLocalToUtc(year, month, day, 0, 0, timeZone))
}

/** `months` calendar months before `date`, clamped to the end of a shorter month. */
function subtractMonths(date: string, months: number): string {
	const { year, month, day } = parseDate(date)
	const index = year * 12 + (month - 1) - months
	const targetYear = Math.floor(index / 12)
	const targetMonth = index - targetYear * 12 + 1
	const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate()
	return formatDate(targetYear, targetMonth, Math.min(day, lastDay))
}

/**
 * The instants a timeframe preset covers. Presets are whole local days in
 * `timeZone` (UTC unless given), so "today" starts at the zone's midnight even
 * when that day is 23 or 25 hours long. Custom ranges are absolute instants.
 */
export function resolveTimeframeRange(
	preset: TimeframePreset,
	now = new Date(),
	custom?: { start?: string; end?: string },
	timeZone: string = DEFAULT_REPORT_TIME_ZONE,
): { start: Date | null; end: Date } {
	const end = new Date(now)
	if (preset === 'all_time') return { start: null, end }
	if (preset === 'custom') {
		return {
			start: custom?.start ? asDate(custom.start) : null,
			end: custom?.end ? (asDate(custom.end) ?? end) : end,
		}
	}

	const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_REPORT_TIME_ZONE
	const today = localDateIn(now, zone)
	let firstDay = today
	if (preset === 'last_7_days') firstDay = addDays(today, -6)
	else if (preset === 'last_30_days') firstDay = addDays(today, -29)
	else if (preset === 'last_3_months') firstDay = subtractMonths(today, 3)
	else if (preset === 'last_6_months') firstDay = subtractMonths(today, 6)
	else if (preset === 'last_12_months') firstDay = subtractMonths(today, 12)
	return { start: startOfLocalDay(firstDay, zone), end }
}

/** No zone is more than this far from UTC. */
const MAX_ZONE_OFFSET_MS = 14 * 60 * 60 * 1000

/**
 * The window a data loader should read for a timeframe. The engine does the
 * exact cut in the report's (or each record's) zone afterwards; this only has
 * to be wide enough for any zone, so a loader never needs to know which one.
 */
export function timeframeLoadWindow(
	preset: TimeframePreset,
	now = new Date(),
	custom?: { start?: string; end?: string },
): { start: Date | null; end: Date } {
	const range = resolveTimeframeRange(preset, now, custom, 'UTC')
	if (preset === 'custom') return range
	return {
		start: range.start
			? new Date(range.start.getTime() - MAX_ZONE_OFFSET_MS)
			: null,
		end: range.end,
	}
}

export function timeframePresetLabel(preset: TimeframePreset): string {
	switch (preset) {
		case 'today':
			return 'Today'
		case 'last_7_days':
			return 'Last 7 days'
		case 'last_30_days':
			return 'Last 30 days'
		case 'last_3_months':
			return 'Last 3 months'
		case 'last_6_months':
			return 'Last 6 months'
		case 'last_12_months':
			return 'Last 12 months'
		case 'all_time':
			return 'All time'
		case 'custom':
			return 'Custom range'
	}
}

export function timeBucketLabel(bucket: TimeBucket): string {
	if (bucket === 'day') return 'Daily'
	return bucket === 'week' ? 'Weekly' : 'Monthly'
}

/**
 * The zones a run cuts time in: the report's, and per record the zone a
 * subject's records carry (a scope's), so a labor day is the scope's day.
 */
type ZoneContext = {
	subject: ReportSubject
	reportZone: string
}

/**
 * Validating a zone builds an `Intl.DateTimeFormat`, which is too slow to do
 * for every record of a large report, so answers are remembered. The cache is
 * capped, so a stream of odd values can't grow it without bound.
 */
const zoneValidity = new Map<string, boolean>()
const ZONE_VALIDITY_CACHE_LIMIT = 512

function knownTimeZone(zone: string): boolean {
	const cached = zoneValidity.get(zone)
	if (cached !== undefined) return cached
	const valid = isValidTimeZone(zone)
	if (zoneValidity.size >= ZONE_VALIDITY_CACHE_LIMIT) zoneValidity.clear()
	zoneValidity.set(zone, valid)
	return valid
}

function zoneOf(record: ReportRecord, zones: ZoneContext): string {
	const field = zones.subject.timeZoneField
	if (field) {
		const own = asString(record[field])
		if (own && knownTimeZone(own)) return own
	}
	return zones.reportZone
}

function inTimeframe(
	record: ReportRecord,
	definition: ReportDefinition,
	now: Date,
	zones: ZoneContext,
	ranges: Map<string, { start: Date | null; end: Date }>,
): boolean {
	const value = asDate(record[definition.timeframe.field])
	if (!value) return false
	const zone = zoneOf(record, zones)
	let range = ranges.get(zone)
	if (!range) {
		range = resolveTimeframeRange(
			definition.timeframe.preset,
			now,
			definition.timeframe,
			zone,
		)
		ranges.set(zone, range)
	}
	if (range.start && value < range.start) return false
	if (value > range.end) return false
	return true
}

function matchesCondition(
	record: ReportRecord,
	condition: FilterCondition,
): boolean {
	const raw = record[condition.field]
	const text = asString(raw).toLowerCase()
	const expected = Array.isArray(condition.value)
		? condition.value.map((item) => asString(item).toLowerCase())
		: asString(condition.value).toLowerCase()

	switch (condition.operator) {
		case 'eq':
			return text === expected
		case 'neq':
			return text !== expected
		case 'contains':
			return text.includes(
				Array.isArray(expected) ? (expected[0] ?? '') : expected,
			)
		case 'starts_with':
			return text.startsWith(
				Array.isArray(expected) ? (expected[0] ?? '') : expected,
			)
		case 'is_empty':
			return raw === null || raw === undefined || text.length === 0
		case 'is_not_empty':
			return raw !== null && raw !== undefined && text.length > 0
		case 'in':
			return expected.includes(text)
		default:
			return false
	}
}

function matchesGroup(record: ReportRecord, group: FilterGroup): boolean {
	if (group.conditions.length === 0) return true
	const results = group.conditions.map((item) =>
		isFilterGroup(item)
			? matchesGroup(record, item)
			: matchesCondition(record, item),
	)
	const combined =
		group.combinator === 'and' ? results.every(Boolean) : results.some(Boolean)
	return group.not ? !combined : combined
}

function formatBoolean(value: unknown): string {
	if (value === true || value === 'true' || value === 1 || value === '1') {
		return 'Yes'
	}
	if (value === false || value === 'false' || value === 0 || value === '0') {
		return 'No'
	}
	return 'Unspecified'
}

/** A calendar date as a `Date` at UTC noon, for formatting without zone shifts. */
function calendarDate(date: string): Date {
	const { year, month, day } = parseDate(date)
	return new Date(Date.UTC(year, month - 1, day, 12))
}

function monthKey(date: string): string {
	return date.slice(0, 7)
}

/** Weeks start on Monday, as they always have in reports. */
function weekKey(date: string): string {
	return weekStartFor(date, 1)
}

function formatMonthLabel(date: string): string {
	return calendarDate(date).toLocaleString('en-US', {
		month: 'short',
		year: 'numeric',
		timeZone: 'UTC',
	})
}

function formatDayLabel(date: string): string {
	return calendarDate(date).toLocaleString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC',
	})
}

function formatWeekLabel(date: string): string {
	const first = weekKey(date)
	const start = calendarDate(first)
	const end = calendarDate(addDays(first, 6))
	const sameYear = start.getUTCFullYear() === end.getUTCFullYear()
	const startLabel = start.toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		year: sameYear ? undefined : 'numeric',
		timeZone: 'UTC',
	})
	const endLabel = end.toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC',
	})
	return `${startLabel} – ${endLabel}`
}

/** The bucket a local calendar date belongs to. */
function bucketOfDate(
	date: string,
	timeBucket: TimeBucket,
): { key: string; label: string } {
	if (timeBucket === 'day') return { key: date, label: formatDayLabel(date) }
	if (timeBucket === 'week') {
		return { key: weekKey(date), label: formatWeekLabel(date) }
	}
	return { key: monthKey(date), label: formatMonthLabel(date) }
}

function datetimeBucket(
	value: unknown,
	timeBucket: TimeBucket,
	timeZone: string,
): { key: string; label: string } {
	const date = asDate(value)
	if (!date) return { key: 'unspecified', label: 'Unspecified' }
	return bucketOfDate(localDateIn(date, timeZone), timeBucket)
}

/**
 * Enum values the catalog doesn't list (for example call purposes a business
 * type adds) read as words instead of raw slugs.
 */
function optionLabel(field: ReportField, key: string) {
	const option = field.options?.find((item) => item.value === key)
	if (option) return option.label
	if (field.type !== 'enum' || !/^[a-z][a-z0-9_]*$/u.test(key)) return key
	const words = key.replaceAll('_', ' ')
	return words.charAt(0).toUpperCase() + words.slice(1)
}

function segmentValue(
	record: ReportRecord,
	field: ReportField,
	timeBucket: TimeBucket,
	timeZone: string,
): { key: string; label: string } {
	const raw = record[field.id]
	if (field.type === 'datetime') {
		return datetimeBucket(raw, timeBucket, timeZone)
	}
	if (field.type === 'boolean') {
		const key = asString(raw) || 'unspecified'
		return { key, label: formatBoolean(raw) }
	}
	if (raw === null || raw === undefined || asString(raw).length === 0) {
		return { key: 'unspecified', label: 'Unspecified' }
	}
	const key = asString(raw)
	return { key, label: optionLabel(field, key) }
}

function recordCurrency(record: ReportRecord, subject: ReportSubject) {
	if (!subject.currencyField) return ''
	return asString(record[subject.currencyField]).trim().toUpperCase()
}

function formatListCell(
	record: ReportRecord,
	field: ReportField,
	subject: ReportSubject,
	timeZone: string,
): string {
	const raw = record[field.id]
	if (field.type === 'duration') {
		const minutes = asNumber(raw)
		return minutes === null ? '—' : formatDuration(minutes, { locale: 'en-US' })
	}
	if (field.type === 'number' || field.type === 'currency') {
		const amount = asNumber(raw)
		if (amount === null) return '—'
		const currency = recordCurrency(record, subject)
		if (field.type === 'currency' && currency) {
			return formatCurrency(amount, currency, { locale: 'en-US' })
		}
		return formatNumber(amount, { locale: 'en-US' })
	}
	if (field.type === 'datetime') {
		const date = asDate(raw)
		if (!date) return '—'
		const day = localDateIn(date, timeZone)
		if (!field.showTime) return day
		const parts = localParts(date.getTime(), timeZone)
		return `${day} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
	}
	if (field.type === 'boolean') {
		if (raw === null || raw === undefined || asString(raw).length === 0) {
			return '—'
		}
		return formatBoolean(raw)
	}
	if (raw === null || raw === undefined || asString(raw).length === 0) {
		return '—'
	}
	return optionLabel(field, asString(raw))
}

function sortSegments(
	segments: ReportSegment[],
	sortBy: ReportDefinition['visualization']['sortBy'],
	chronological: boolean,
	byValue: boolean,
): ReportSegment[] {
	const copy = [...segments]
	if (chronological && (sortBy === 'none' || sortBy === 'label')) {
		copy.sort((a, b) => a.key.localeCompare(b.key))
		return copy
	}
	const metric = (segment: ReportSegment) =>
		byValue ? (segment.value ?? 0) : segment.count
	if (sortBy === 'label') {
		// Numeric collation keeps party sizes and times in their natural order.
		copy.sort((a, b) =>
			a.label.localeCompare(b.label, undefined, { numeric: true }),
		)
	} else if (sortBy === 'value_asc') {
		copy.sort((a, b) => metric(a) - metric(b))
	} else if (sortBy === 'value_desc') {
		copy.sort((a, b) => metric(b) - metric(a))
	}
	return copy
}

/** Most buckets filled in for a range; wider ranges show only buckets with data. */
const MAX_FILLED_BUCKETS = 1000

function iterateTimeBuckets(
	startDate: string,
	endDate: string,
	timeBucket: TimeBucket,
): Array<{ key: string; label: string }> {
	const buckets: Array<{ key: string; label: string }> = []
	if (startDate > endDate) return buckets
	if (timeBucket === 'month') {
		let cursor = `${monthKey(startDate)}-01`
		while (monthKey(cursor) <= monthKey(endDate)) {
			buckets.push(bucketOfDate(cursor, 'month'))
			if (buckets.length > MAX_FILLED_BUCKETS) return []
			const { year, month } = parseDate(cursor)
			cursor =
				month === 12
					? formatDate(year + 1, 1, 1)
					: formatDate(year, month + 1, 1)
		}
		return buckets
	}
	const step = timeBucket === 'week' ? 7 : 1
	let cursor = timeBucket === 'week' ? weekKey(startDate) : startDate
	const last = timeBucket === 'week' ? weekKey(endDate) : endDate
	while (cursor <= last) {
		buckets.push(bucketOfDate(cursor, timeBucket))
		if (buckets.length > MAX_FILLED_BUCKETS) return []
		cursor = addDays(cursor, step)
	}
	return buckets
}

function needsGroupBy(definition: ReportDefinition) {
	const style = definition.visualization.chartStyle
	return style === 'pie' || style === 'bar'
}

/** The two fields of a ratio field, when the catalog defines them sensibly. */
function ratioParts(subject: ReportSubject, field: ReportField) {
	if (field.type !== 'ratio' || !field.ratio) return null
	const numerator = getField(subject, field.ratio.numerator)
	const denominator = getField(subject, field.ratio.denominator)
	if (!numerator || !denominator) return null
	if (
		!isValueFieldType(numerator.type) ||
		!isValueFieldType(denominator.type)
	) {
		return null
	}
	if (field.ratio.unit === 'per_hour' && denominator.type !== 'duration') {
		return null
	}
	return { numerator, denominator, unit: field.ratio.unit }
}

export function validateReportDefinition(
	catalog: ReportCatalog,
	definition: ReportDefinition,
): ReportRunError | null {
	const subject = getSubject(catalog, definition.subject)
	if (!subject) {
		return { error: 'unknown_subject', message: 'Unknown report subject.' }
	}
	if (!getField(subject, definition.timeframe.field)?.timeframe) {
		return {
			error: 'invalid_definition',
			message: 'The selected timeframe field is not valid for this subject.',
		}
	}
	for (const fieldId of definition.groupBy) {
		if (!getField(subject, fieldId)?.groupable) {
			return {
				error: 'invalid_definition',
				message: `Cannot group by "${fieldId}".`,
			}
		}
	}
	for (const fieldId of definition.columns) {
		const field = getField(subject, fieldId)
		if (!field || field.listable === false) {
			return {
				error: 'invalid_definition',
				message: `Cannot show column "${fieldId}".`,
			}
		}
	}
	const { measure, valueField } = definition.visualization
	if (measuresAValueField(measure) && !isListReport(definition)) {
		const field = valueField ? getField(subject, valueField) : null
		const usable =
			field !== null &&
			valueMeasureLabel(measure as ValueMeasure | 'ratio', field) !== null &&
			(!isRatioMeasure(measure) || ratioParts(subject, field) !== null)
		if (!usable) {
			return {
				error: 'invalid_definition',
				message: isRatioMeasure(measure)
					? 'Choose a ratio to measure.'
					: measure === 'sum'
						? 'Choose a number to add up.'
						: 'Choose a number to average.',
			}
		}
		if (
			(measure === 'average' || isRatioMeasure(measure)) &&
			definition.visualization.chartStyle === 'pie'
		) {
			return {
				error: 'invalid_definition',
				message: isRatioMeasure(measure)
					? 'Ratios don’t add up to a whole, so they can’t be a pie chart. Choose a bar chart or table.'
					: 'Averages don’t add up to a whole, so they can’t be a pie chart. Choose a bar chart or table.',
			}
		}
	}
	if (needsGroupBy(definition) && definition.groupBy.length === 0) {
		return {
			error: 'missing_group_by',
			message: "Select at least one 'Group Results By' field to see results.",
		}
	}
	return null
}

/**
 * Every field a definition reads: timeframe, groups, filters, list columns
 * (including the defaults an empty column list falls back to), and the
 * measured value. A ratio reads the two fields it divides as well, so a
 * permission on either one applies to the report.
 */
export function referencedFieldIds(
	subject: ReportSubject,
	definition: ReportDefinition,
): Set<string> {
	const ids = new Set<string>([
		definition.timeframe.field,
		...definition.groupBy,
	])
	for (const condition of flattenFilterConditions(definition.filters)) {
		ids.add(condition.field)
	}
	if (isListReport(definition)) {
		const columns =
			definition.columns.length > 0
				? definition.columns
				: defaultListColumns(subject)
		for (const id of columns) ids.add(id)
	} else if (
		measuresAValueField(definition.visualization.measure) &&
		definition.visualization.valueField
	) {
		const valueField = definition.visualization.valueField
		ids.add(valueField)
		const field = getField(subject, valueField)
		if (field?.type === 'ratio' && field.ratio) {
			ids.add(field.ratio.numerator)
			ids.add(field.ratio.denominator)
		}
	}
	return ids
}

function listResult(
	subject: ReportSubject,
	definition: ReportDefinition,
	matched: ReportRecord[],
	now: Date,
	zones: ZoneContext,
): ReportResult {
	const columnIds =
		definition.columns.length > 0
			? definition.columns
			: defaultListColumns(subject)
	const columns = columnIds
		.map((id) => getField(subject, id))
		.filter((field): field is ReportField => Boolean(field))
		.map((field) => ({ id: field.id, label: field.label }))

	const sorted = [...matched].sort((a, b) => {
		const left = asDate(a[definition.timeframe.field])?.getTime() ?? 0
		const right = asDate(b[definition.timeframe.field])?.getTime() ?? 0
		return right - left
	})
	const truncated = sorted.length > MAX_LIST_ROWS
	const visible = sorted.slice(0, MAX_LIST_ROWS)
	const rows = visible.map((record) => {
		const row: Record<string, string> = {}
		const zone = zoneOf(record, zones)
		for (const column of columns) {
			const field = getField(subject, column.id)
			row[column.id] = field
				? formatListCell(record, field, subject, zone)
				: '—'
		}
		return row
	})

	return {
		total: matched.length,
		segments: [],
		columns,
		rows,
		truncated,
		refreshedAt: now.toISOString(),
		timeZone: zones.reportZone,
	}
}

export type RunReportOptions = {
	/**
	 * IANA zone the report is cut in, already resolved (see
	 * {@link resolveReportTimeZone}). UTC when omitted.
	 */
	timeZone?: string
}

export function runReport(
	catalog: ReportCatalog,
	definition: ReportDefinition,
	records: ReportRecord[],
	now = new Date(),
	options: RunReportOptions = {},
): ReportResult | ReportRunError {
	const error = validateReportDefinition(catalog, definition)
	if (error) return error
	const subject = getSubject(catalog, definition.subject) as ReportSubject
	const reportZone =
		options.timeZone && isValidTimeZone(options.timeZone)
			? options.timeZone
			: DEFAULT_REPORT_TIME_ZONE
	const zones: ZoneContext = { subject, reportZone }
	const ranges = new Map<string, { start: Date | null; end: Date }>()

	const matched = records.filter(
		(record) =>
			inTimeframe(record, definition, now, zones, ranges) &&
			matchesGroup(record, definition.filters),
	)

	if (isListReport(definition)) {
		return listResult(subject, definition, matched, now, zones)
	}

	const measured = measuredValue(subject, definition, matched)
	// Amounts in different currencies can't be added together, so a mixed
	// result keeps its value info for the notice but measures nothing.
	const valued = measured?.info.mixedCurrencies ? null : measured
	const valueOf = (tally: ValueTally) =>
		valued ? tallyValue(tally, valued) : undefined

	if (
		definition.visualization.chartStyle === 'single_number' ||
		definition.groupBy.length === 0
	) {
		const tally = emptyTally()
		for (const record of matched) addToTally(tally, record, valued)
		const value = valueOf(tally)
		return {
			total: matched.length,
			...(measured ? { valueInfo: measured.info } : {}),
			...(valued ? { value } : {}),
			segments: [
				{
					key: 'total',
					label: subject.label,
					count: matched.length,
					percent: 100,
					...(valued ? { value } : {}),
				},
			],
			refreshedAt: now.toISOString(),
			timeZone: reportZone,
		}
	}

	const groupFields = definition.groupBy
		.map((id) => getField(subject, id))
		.filter((field): field is ReportField => Boolean(field))
	const timeGrouped =
		groupFields.length === 1 && groupFields[0]?.type === 'datetime'

	const overall = emptyTally()
	const buckets = new Map<string, { label: string; tally: ValueTally }>()
	for (const record of matched) {
		const zone = zoneOf(record, zones)
		const parts = groupFields.map((field) =>
			segmentValue(record, field, definition.timeBucket, zone),
		)
		const key = parts.map((part) => part.key).join(' / ')
		const label = parts.map((part) => part.label).join(' / ')
		let bucket = buckets.get(key)
		if (!bucket) {
			bucket = { label, tally: emptyTally() }
			buckets.set(key, bucket)
		}
		addToTally(bucket.tally, record, valued)
		addToTally(overall, record, valued)
	}

	if (timeGrouped && matched.length > 0) {
		const range =
			ranges.get(reportZone) ??
			resolveTimeframeRange(
				definition.timeframe.preset,
				now,
				definition.timeframe,
				reportZone,
			)
		const earliest =
			matched
				.map((record) => asDate(record[definition.groupBy[0] ?? '']))
				.filter((date): date is Date => Boolean(date))
				.sort((a, b) => a.getTime() - b.getTime())[0] ?? now
		const fillStart = localDateIn(range.start ?? earliest, reportZone)
		const fillEnd = localDateIn(range.end, reportZone)
		for (const slot of iterateTimeBuckets(
			fillStart,
			fillEnd,
			definition.timeBucket,
		)) {
			if (!buckets.has(slot.key)) {
				buckets.set(slot.key, { label: slot.label, tally: emptyTally() })
			}
		}
	}

	const total = matched.length
	const segments = sortSegments(
		[...buckets.entries()].map(([key, bucket]) => ({
			key,
			label: bucket.label,
			count: bucket.tally.count,
			percent: total === 0 ? 0 : (bucket.tally.count / total) * 100,
			...(valued ? { value: valueOf(bucket.tally) } : {}),
		})),
		definition.visualization.sortBy,
		timeGrouped,
		Boolean(valued),
	)

	return {
		total,
		...(measured ? { valueInfo: measured.info } : {}),
		...(valued ? { value: valueOf(overall) } : {}),
		segments,
		refreshedAt: now.toISOString(),
		timeZone: reportZone,
	}
}

type ValueTally = {
	count: number
	/** Records with a numeric value; averages divide by this, not `count`. */
	valued: number
	sum: number
	/** Ratio only: sum of the numerator over records that have both sides. */
	numerator: number
	/** Ratio only: sum of the denominator over the same records. */
	denominator: number
	/** Ratio only: records that had both sides. */
	included: number
}

function emptyTally(): ValueTally {
	return {
		count: 0,
		valued: 0,
		sum: 0,
		numerator: 0,
		denominator: 0,
		included: 0,
	}
}

/** What a report measures: a sum or average of a field, or a ratio of two sums. */
type Measured =
	| {
			kind: 'value'
			measure: ValueMeasure
			field: ReportField
			info: ReportValueInfo
	  }
	| {
			kind: 'ratio'
			field: ReportField
			numerator: ReportField
			denominator: ReportField
			unit: 'percent' | 'per_hour'
			info: ReportValueInfo
	  }

/** Money adds up in minor units so sums don't pick up float drift. */
function scaled(field: ReportField, amount: number) {
	return field.type === 'currency' ? Math.round(amount * 100) : amount
}

function unscaled(field: ReportField, amount: number) {
	return field.type === 'currency' ? amount / 100 : amount
}

function addToTally(
	tally: ValueTally,
	record: ReportRecord,
	measured: Measured | null,
) {
	tally.count += 1
	if (!measured) return
	if (measured.kind === 'ratio') {
		const numerator = asNumber(record[measured.numerator.id])
		const denominator = asNumber(record[measured.denominator.id])
		if (numerator === null || denominator === null) return
		tally.included += 1
		tally.numerator += scaled(measured.numerator, numerator)
		tally.denominator += scaled(measured.denominator, denominator)
		return
	}
	const amount = asNumber(record[measured.field.id])
	if (amount === null) return
	tally.valued += 1
	tally.sum += scaled(measured.field, amount)
}

function tallyValue(tally: ValueTally, measured: Measured): number | undefined {
	if (measured.kind === 'ratio') {
		// A ratio of nothing is unknown rather than zero, like an average.
		const denominator = unscaled(measured.denominator, tally.denominator)
		if (!(denominator > 0)) return undefined
		const numerator = unscaled(measured.numerator, tally.numerator)
		return measured.unit === 'percent'
			? (numerator / denominator) * 100
			: numerator / (denominator / 60)
	}
	const sum = unscaled(measured.field, tally.sum)
	if (measured.measure === 'sum') return sum
	// An average of no amounts is unknown rather than zero, so empty time
	// buckets don't chart as a drop to nothing.
	return tally.valued === 0 ? undefined : sum / tally.valued
}

function currencyOf(
	records: readonly ReportRecord[],
	subject: ReportSubject,
	has: (record: ReportRecord) => boolean,
): { currency?: string; mixed: boolean } {
	const currencies = new Set<string>()
	for (const record of records) {
		if (!has(record)) continue
		const currency = recordCurrency(record, subject)
		if (currency) currencies.add(currency)
	}
	if (currencies.size === 1)
		return { currency: [...currencies][0], mixed: false }
	return { mixed: currencies.size > 1 }
}

function measuredValue(
	subject: ReportSubject,
	definition: ReportDefinition,
	matched: ReportRecord[],
): Measured | null {
	const { measure, valueField } = definition.visualization
	if (!measuresAValueField(measure) || !valueField) return null
	const field = getField(subject, valueField)
	if (!field) return null

	if (isRatioMeasure(measure)) {
		const parts = ratioParts(subject, field)
		if (!parts) return null
		const info: ReportValueInfo = {
			measure: 'ratio',
			field: field.id,
			label: field.label,
			type:
				parts.unit === 'percent'
					? 'percent'
					: parts.numerator.type === 'currency'
						? 'currency'
						: 'number',
			...(parts.unit === 'per_hour' ? { perHour: true } : {}),
			...(field.description ? { note: field.description } : {}),
		}
		const both = (record: ReportRecord) =>
			asNumber(record[parts.numerator.id]) !== null &&
			asNumber(record[parts.denominator.id]) !== null
		info.excluded = matched.filter((record) => !both(record)).length
		if (
			parts.numerator.type === 'currency' ||
			parts.denominator.type === 'currency'
		) {
			// Cost and sales in different currencies can't be divided, so only
			// one currency's records may be in a ratio.
			const currency = currencyOf(matched, subject, both)
			if (currency.mixed) info.mixedCurrencies = true
			else if (currency.currency && parts.unit === 'per_hour') {
				info.currency = currency.currency
			}
		}
		return { kind: 'ratio', field, ...parts, info }
	}

	const label = valueMeasureLabel(measure, field)
	if (label === null) return null
	const info: ReportValueInfo = {
		measure,
		field: field.id,
		label,
		type:
			field.type === 'currency'
				? 'currency'
				: field.type === 'duration'
					? 'duration'
					: 'number',
	}
	if (field.type === 'currency') {
		const currency = currencyOf(
			matched,
			subject,
			(record) => asNumber(record[field.id]) !== null,
		)
		if (currency.mixed) info.mixedCurrencies = true
		else if (currency.currency) info.currency = currency.currency
	}
	return { kind: 'value', measure, field, info }
}

export function isReportRunError(
	value: ReportResult | ReportRunError,
): value is ReportRunError {
	return 'error' in value
}
