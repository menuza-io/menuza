import {
	addDays,
	daysBetween,
	dayOfWeek,
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

/** Whether rolling presets include the current day, and where weeks start. */
export type TimeframeOptions = {
	/** Off, rolling ranges end with yesterday. On when left out. */
	includeToday?: boolean
	/** 0 (Sunday) to 6. Monday when left out, as weeks always were in reports. */
	weekStart?: number
}

const ROLLING_DAYS: Partial<Record<TimeframePreset, number>> = {
	last_7_days: 7,
	last_14_days: 14,
	last_21_days: 21,
	last_28_days: 28,
	last_30_days: 30,
}

const ROLLING_MONTHS: Partial<Record<TimeframePreset, number>> = {
	last_3_months: 3,
	last_6_months: 6,
	last_12_months: 12,
}

function weekStartOf(options?: { weekStart?: number }) {
	const day = options?.weekStart
	return typeof day === 'number' &&
		Number.isInteger(day) &&
		day >= 0 &&
		day <= 6
		? day
		: 1
}

/**
 * The instants a timeframe preset covers. Presets are whole local days in
 * `timeZone` (UTC unless given), so "today" starts at the zone's midnight even
 * when that day is 23 or 25 hours long. Custom ranges are absolute instants.
 *
 * Presets that end on a complete period (yesterday, last complete week or
 * month, and any rolling preset with `includeToday` off) end one millisecond
 * before the next local day begins, so that day's records are never in them.
 */
export function resolveTimeframeRange(
	preset: TimeframePreset,
	now = new Date(),
	custom?: { start?: string; end?: string },
	timeZone: string = DEFAULT_REPORT_TIME_ZONE,
	options: TimeframeOptions = {},
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
	const includeToday = options.includeToday !== false
	const endBefore = (date: string) =>
		new Date(startOfLocalDay(date, zone).getTime() - 1)
	const from = (date: string, last = end) => ({
		start: startOfLocalDay(date, zone),
		end: last,
	})
	const rollingEnd = includeToday ? end : endBefore(today)

	if (preset === 'today') return from(today)
	if (preset === 'yesterday') return from(addDays(today, -1), endBefore(today))
	if (preset === 'last_complete_week') {
		const thisWeek = weekStartFor(today, weekStartOf(options))
		return from(addDays(thisWeek, -7), endBefore(thisWeek))
	}
	if (preset === 'last_complete_month') {
		const thisMonth = `${monthKey(today)}-01`
		return from(subtractMonths(thisMonth, 1), endBefore(thisMonth))
	}
	if (preset === 'month_to_date') {
		return from(`${monthKey(today)}-01`, rollingEnd)
	}
	const days = ROLLING_DAYS[preset]
	if (days) {
		// With today left out the range still holds `days` whole days.
		return from(addDays(today, includeToday ? 1 - days : -days), rollingEnd)
	}
	const months = ROLLING_MONTHS[preset]
	if (months) return from(subtractMonths(today, months), rollingEnd)
	return from(today)
}

/** The range a definition's timeframe covers in `timeZone`. */
export function definitionRange(
	definition: Pick<ReportDefinition, 'timeframe' | 'settings'>,
	now: Date,
	timeZone: string,
	options: { weekStart?: number } = {},
) {
	return resolveTimeframeRange(
		definition.timeframe.preset,
		now,
		definition.timeframe,
		timeZone,
		{
			includeToday: definition.settings.includeToday,
			weekStart: options.weekStart,
		},
	)
}

const DAY_MS = 86_400_000

/** `date` moved by whole local days in `zone`, keeping its local time of day. */
function shiftLocalDays(date: Date, days: number, zone: string): Date {
	const parts = localParts(date.getTime(), zone)
	const { year, month, day } = parseDate(
		addDays(formatDate(parts.year, parts.month, parts.day), days),
	)
	const minute = zonedLocalToUtc(
		year,
		month,
		day,
		parts.hour,
		parts.minute,
		zone,
	)
	// Seconds and milliseconds ride along (zone offsets are whole minutes here).
	return new Date(minute + (((date.getTime() % 60_000) + 60_000) % 60_000))
}

/** `date` moved back by calendar months in `zone`, keeping its local time of day. */
function shiftLocalMonths(date: Date, months: number, zone: string): Date {
	const parts = localParts(date.getTime(), zone)
	const { year, month, day } = parseDate(
		subtractMonths(formatDate(parts.year, parts.month, parts.day), months),
	)
	const minute = zonedLocalToUtc(
		year,
		month,
		day,
		parts.hour,
		parts.minute,
		zone,
	)
	return new Date(minute + (((date.getTime() % 60_000) + 60_000) % 60_000))
}

/** A year back is 52 weeks, so weekdays line up. */
const PREVIOUS_YEAR_DAYS = 364

/**
 * The earlier range a comparison reads, or null when the report compares
 * nothing or its range has no start.
 *
 * - Previous period: the same length immediately before the range. Calendar
 *   month presets step back one calendar month instead (October against
 *   September, not against the 31 days before October).
 * - Previous year: both ends moved back 52 weeks.
 *
 * Shifts are whole local days in `timeZone`, so a daylight-saving change in
 * between does not move the edges by an hour.
 */
export function comparisonRange(
	definition: Pick<ReportDefinition, 'timeframe' | 'compare'>,
	range: { start: Date | null; end: Date },
	timeZone: string,
): { start: Date; end: Date } | null {
	if (definition.compare === 'none' || !range.start) return null
	const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_REPORT_TIME_ZONE
	if (definition.compare === 'previous_year') {
		return {
			start: shiftLocalDays(range.start, -PREVIOUS_YEAR_DAYS, zone),
			end: shiftLocalDays(range.end, -PREVIOUS_YEAR_DAYS, zone),
		}
	}
	const justBefore = new Date(range.start.getTime() - 1)
	const preset = definition.timeframe.preset
	if (preset === 'last_complete_month') {
		return { start: shiftLocalMonths(range.start, 1, zone), end: justBefore }
	}
	if (preset === 'month_to_date') {
		const shifted = shiftLocalMonths(range.end, 1, zone)
		return {
			start: shiftLocalMonths(range.start, 1, zone),
			end: shifted < justBefore ? shifted : justBefore,
		}
	}
	if (preset === 'custom') {
		const length = Math.max(0, range.end.getTime() - range.start.getTime())
		return { start: new Date(justBefore.getTime() - length), end: justBefore }
	}
	const days =
		daysBetween(localDateIn(range.start, zone), localDateIn(range.end, zone)) +
		1
	return {
		start: shiftLocalDays(range.start, -days, zone),
		end: shiftLocalDays(range.end, -days, zone),
	}
}

/** Longest range a report with a comparison may cover: it reads two ranges. */
export const COMPARE_MAX_RANGE_DAYS = 200

/** A range's length in days (fractions kept). */
function rangeDays(range: { start: Date; end: Date }) {
	return (range.end.getTime() - range.start.getTime()) / DAY_MS
}

/**
 * Refuses a range a run may not cover: a comparison needs a start and at most
 * {@link COMPARE_MAX_RANGE_DAYS} days, and a subject may cap its own range
 * (`maxRangeDays`). A day of slack covers the partial current day.
 */
function rangeError(
	subject: ReportSubject,
	definition: ReportDefinition,
	now: Date,
): ReportRunError | null {
	if (isListReport(definition) && !subject.maxRangeDays) return null
	const range = definitionRange(definition, now, DEFAULT_REPORT_TIME_ZONE)
	const comparing = definition.compare !== 'none' && !isListReport(definition)
	if (comparing && !range.start) {
		return {
			error: 'invalid_definition',
			message: 'Choose a time range with a start date to compare periods.',
		}
	}
	const limits = [
		...(comparing ? [COMPARE_MAX_RANGE_DAYS] : []),
		...(subject.maxRangeDays ? [subject.maxRangeDays] : []),
	]
	if (limits.length === 0) return null
	const limit = Math.min(...limits)
	if (
		!range.start ||
		rangeDays({ start: range.start, end: range.end }) > limit + 1
	) {
		return {
			error: 'report_range_too_long',
			message:
				comparing && limit === COMPARE_MAX_RANGE_DAYS
					? `Comparing periods works for ranges of up to ${COMPARE_MAX_RANGE_DAYS} days. Choose a shorter range or turn the comparison off.`
					: `This report can cover up to ${limit} days at a time. Choose a shorter range.`,
		}
	}
	return null
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
	options: TimeframeOptions = {},
): { start: Date | null; end: Date } {
	const range = resolveTimeframeRange(preset, now, custom, 'UTC', options)
	if (preset === 'custom') return range
	return {
		start: range.start
			? new Date(range.start.getTime() - MAX_ZONE_OFFSET_MS)
			: null,
		end: range.end,
	}
}

/**
 * The definition a data loader should be handed: the same report with its
 * timeframe replaced by one absolute window that covers everything the run
 * reads, in any zone. That is the report's own range and, when it compares
 * periods, the earlier range too. Loaders only narrow by the timeframe, so
 * they need to know nothing about presets, "include today" or comparisons;
 * the engine cuts the exact ranges from what they return.
 *
 * Ranges without a start (all time) are returned unchanged.
 */
export function definitionForLoading(
	definition: ReportDefinition,
	now = new Date(),
	options: { weekStart?: number } = {},
): ReportDefinition {
	const range = definitionRange(definition, now, 'UTC', options)
	if (!range.start) return definition
	const earlier = isListReport(definition)
		? null
		: comparisonRange(definition, range, 'UTC')
	// Custom ranges are absolute instants, so they need no room for zones.
	const pad = definition.timeframe.preset === 'custom' ? 0 : MAX_ZONE_OFFSET_MS
	const start = earlier ? earlier.start : range.start
	return {
		...definition,
		timeframe: {
			field: definition.timeframe.field,
			preset: 'custom',
			start: new Date(start.getTime() - pad).toISOString(),
			end: new Date(range.end.getTime() + pad).toISOString(),
		},
	}
}

const PRESET_LABELS: Record<TimeframePreset, string> = {
	today: 'Today',
	yesterday: 'Yesterday',
	last_7_days: 'Last 7 days',
	last_14_days: 'Last 14 days',
	last_21_days: 'Last 21 days',
	last_28_days: 'Last 28 days',
	last_30_days: 'Last 30 days',
	last_3_months: 'Last 3 months',
	last_6_months: 'Last 6 months',
	last_12_months: 'Last 12 months',
	last_complete_week: 'Last complete week',
	last_complete_month: 'Last complete month',
	month_to_date: 'Month to date',
	all_time: 'All time',
	custom: 'Custom range',
}

export function timeframePresetLabel(preset: TimeframePreset): string {
	return PRESET_LABELS[preset]
}

/** Rolling presets, which "include today" changes. */
export function presetFollowsIncludeToday(preset: TimeframePreset) {
	return (
		preset in ROLLING_DAYS ||
		preset in ROLLING_MONTHS ||
		preset === 'month_to_date'
	)
}

export function timeBucketLabel(bucket: TimeBucket): string {
	switch (bucket) {
		case 'day':
			return 'Daily'
		case 'week':
			return 'Weekly'
		case 'month':
			return 'Monthly'
		case 'hour_of_day':
			return 'Hour of day'
		case 'day_of_week':
			return 'Day of week'
	}
}

/** Buckets that fold time (every Monday together), not a timeline. */
export function isCyclicTimeBucket(bucket: TimeBucket) {
	return bucket === 'hour_of_day' || bucket === 'day_of_week'
}

/**
 * The zones a run cuts time in: the report's, and per record the zone a
 * subject's records carry (a scope's), so a labor day is the scope's day.
 */
type ZoneContext = {
	subject: ReportSubject
	reportZone: string
	weekStart: number
}

/**
 * The record field a datetime field is read from. On an order subject counted
 * by fulfilment time, the placed-time field stands for the fulfilment time
 * (#310), in the timeframe and in every grouping alike, so a comparison uses
 * one basis for both periods.
 */
export function timeBasisFieldId(
	subject: ReportSubject,
	definition: Pick<ReportDefinition, 'timeBasis'>,
	fieldId: string,
): string {
	const basis = subject.timeBasisFields
	return basis &&
		definition.timeBasis === 'fulfillment' &&
		fieldId === basis.placed
		? basis.fulfillment
		: fieldId
}

/**
 * The field a measured field id stands for: the one "Sales" figure reads the
 * gross or the net field, as the definition's `salesBasis` says (#331).
 */
export function salesBasisFieldId(
	subject: ReportSubject,
	definition: Pick<ReportDefinition, 'salesBasis'>,
	fieldId: string,
): string {
	const basis = subject.salesBasisField
	if (!basis || fieldId !== basis.field) return fieldId
	return definition.salesBasis === 'gross' ? basis.gross : basis.net
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

type Range = { start: Date | null; end: Date }

/** The report's range and the earlier one it compares with, per zone. */
type ZoneRanges = { current: Range; previous: Range | null }

function rangesFor(
	zone: string,
	definition: ReportDefinition,
	now: Date,
	zones: ZoneContext,
	cache: Map<string, ZoneRanges>,
): ZoneRanges {
	let ranges = cache.get(zone)
	if (!ranges) {
		const current = definitionRange(definition, now, zone, zones)
		ranges = {
			current,
			previous: isListReport(definition)
				? null
				: comparisonRange(definition, current, zone),
		}
		cache.set(zone, ranges)
	}
	return ranges
}

function inRange(value: Date, range: Range) {
	return !(range.start && value < range.start) && !(value > range.end)
}

/** Which of a run's two periods a record falls in, if either. */
function periodOf(
	record: ReportRecord,
	timeField: string,
	definition: ReportDefinition,
	now: Date,
	zones: ZoneContext,
	cache: Map<string, ZoneRanges>,
): 'current' | 'previous' | null {
	const value = asDate(record[timeField])
	if (!value) return null
	const ranges = rangesFor(zoneOf(record, zones), definition, now, zones, cache)
	if (inRange(value, ranges.current)) return 'current'
	if (ranges.previous && inRange(value, ranges.previous)) return 'previous'
	return null
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

/** Weeks start on Monday unless the caller says otherwise. */
function weekKey(date: string, weekStart = 1): string {
	return weekStartFor(date, weekStart)
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

function formatWeekLabel(date: string, weekStart = 1): string {
	const first = weekKey(date, weekStart)
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

const WEEKDAY_NAMES = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
]

/** Hour-of-day bucket: the key sorts as text, the label is the 24-hour clock. */
function hourBucket(hour: number) {
	const text = String(hour).padStart(2, '0')
	return { key: text, label: `${text}:00` }
}

/**
 * Day-of-week bucket. The key is the day's place in the week (1 is the day
 * the week starts on), so the segments sort in week order.
 */
function weekdayBucket(weekday: number, weekStart: number) {
	return {
		key: String(((weekday - weekStart + 7) % 7) + 1),
		label: WEEKDAY_NAMES[weekday] ?? 'Unspecified',
	}
}

/** The bucket a local calendar date belongs to. */
function bucketOfDate(
	date: string,
	timeBucket: TimeBucket,
	weekStart = 1,
): { key: string; label: string } {
	if (timeBucket === 'day') return { key: date, label: formatDayLabel(date) }
	if (timeBucket === 'week') {
		return {
			key: weekKey(date, weekStart),
			label: formatWeekLabel(date, weekStart),
		}
	}
	if (timeBucket === 'day_of_week') {
		return weekdayBucket(dayOfWeek(date), weekStart)
	}
	return { key: monthKey(date), label: formatMonthLabel(date) }
}

function datetimeBucket(
	value: unknown,
	timeBucket: TimeBucket,
	timeZone: string,
	weekStart = 1,
): { key: string; label: string } {
	const date = asDate(value)
	if (!date) return { key: 'unspecified', label: 'Unspecified' }
	if (timeBucket === 'hour_of_day') {
		return hourBucket(localParts(date.getTime(), timeZone).hour)
	}
	return bucketOfDate(localDateIn(date, timeZone), timeBucket, weekStart)
}

/** The first and last local day a timeline bucket covers. */
function bucketDays(
	key: string,
	timeBucket: TimeBucket,
): { first: string; last: string } | null {
	if (timeBucket === 'day') return { first: key, last: key }
	if (timeBucket === 'week') return { first: key, last: addDays(key, 6) }
	if (timeBucket === 'month') {
		const { year, month } = parseDate(`${key}-01`)
		const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
		return { first: `${key}-01`, last: formatDate(year, month, days) }
	}
	return null
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
	/** The record field to read, when another stands in for `field` (#310). */
	readId = field.id,
	weekStart = 1,
): { key: string; label: string } {
	const raw = record[readId]
	if (field.type === 'datetime') {
		return datetimeBucket(raw, timeBucket, timeZone, weekStart)
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
		// Numeric collation keeps numbers in their natural order (2 before 10).
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
	weekStart = 1,
): Array<{ key: string; label: string }> {
	const buckets: Array<{ key: string; label: string }> = []
	// Folded time has the same slots whatever the range.
	if (timeBucket === 'hour_of_day') {
		return Array.from({ length: 24 }, (_unused, hour) => hourBucket(hour))
	}
	if (timeBucket === 'day_of_week') {
		return Array.from({ length: 7 }, (_unused, index) =>
			weekdayBucket((weekStart + index) % 7, weekStart),
		)
	}
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
	let cursor = timeBucket === 'week' ? weekKey(startDate, weekStart) : startDate
	const last = timeBucket === 'week' ? weekKey(endDate, weekStart) : endDate
	while (cursor <= last) {
		buckets.push(bucketOfDate(cursor, timeBucket, weekStart))
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

/** `ratioParts` with the "Sales" figure resolved to gross or net. */
function resolvedRatioParts(
	subject: ReportSubject,
	definition: Pick<ReportDefinition, 'salesBasis'>,
	field: ReportField,
) {
	const parts = ratioParts(subject, field)
	if (!parts) return null
	const resolve = (part: ReportField) =>
		getField(subject, salesBasisFieldId(subject, definition, part.id)) ?? part
	return {
		...parts,
		numerator: resolve(parts.numerator),
		denominator: resolve(parts.denominator),
	}
}

export function validateReportDefinition(
	catalog: ReportCatalog,
	definition: ReportDefinition,
	now = new Date(),
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
		const field = valueField
			? getField(subject, salesBasisFieldId(subject, definition, valueField))
			: null
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
	return rangeError(subject, definition, now)
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
	// Counted by fulfilment time, the placed-time field reads the fulfilment one.
	for (const id of [...ids]) ids.add(timeBasisFieldId(subject, definition, id))
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
		ids.add(salesBasisFieldId(subject, definition, valueField))
		const field = getField(subject, valueField)
		if (field?.type === 'ratio' && field.ratio) {
			for (const part of [field.ratio.numerator, field.ratio.denominator]) {
				ids.add(part)
				ids.add(salesBasisFieldId(subject, definition, part))
			}
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

	const timeField = timeBasisFieldId(
		subject,
		definition,
		definition.timeframe.field,
	)
	const sorted = [...matched].sort((a, b) => {
		const left = asDate(a[timeField])?.getTime() ?? 0
		const right = asDate(b[timeField])?.getTime() ?? 0
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
		...(subject.timeBasisFields ? { timeBasis: definition.timeBasis } : {}),
	}
}

export type RunReportOptions = {
	/**
	 * IANA zone the report is cut in, already resolved (see
	 * {@link resolveReportTimeZone}). UTC when omitted.
	 */
	timeZone?: string
	/** The day weeks start on, 0 (Sunday) to 6. Monday when omitted. */
	weekStart?: number
}

type Bucket = { label: string; tally: ValueTally; currency?: string }

/** One period's records, tallied overall and per group. */
function tallyPeriod(
	records: readonly ReportRecord[],
	groups: ReadonlyArray<{ field: ReportField; readId: string }>,
	definition: ReportDefinition,
	zones: ZoneContext,
	valued: Measured | null,
	/** Set when each currency gets its own segments. */
	currencySubject: ReportSubject | null,
) {
	const overall = emptyTally()
	const buckets = new Map<string, Bucket>()
	for (const record of records) {
		addToTally(overall, record, valued)
		if (groups.length === 0) continue
		const zone = zoneOf(record, zones)
		const parts = groups.map(({ field, readId }) =>
			segmentValue(
				record,
				field,
				definition.timeBucket,
				zone,
				readId,
				zones.weekStart,
			),
		)
		const currency = currencySubject
			? recordCurrency(record, currencySubject)
			: ''
		if (currencySubject) {
			parts.push({ key: currency || 'unspecified', label: currency || '—' })
		}
		const key = parts.map((part) => part.key).join(' / ')
		let bucket = buckets.get(key)
		if (!bucket) {
			bucket = {
				label: parts.map((part) => part.label).join(' / '),
				tally: emptyTally(),
				...(currency ? { currency } : {}),
			}
			buckets.set(key, bucket)
		}
		addToTally(bucket.tally, record, valued)
	}
	return { overall, buckets }
}

/** The change from `previous` to `current`, in a number and in words. */
export function describeChange(
	current: number | undefined,
	previous: number | undefined,
): { changePercent?: number; changeLabel?: string } {
	// Nothing to divide by: a change from zero is shown as no percentage.
	if (current === undefined || previous === undefined || previous === 0) {
		return {}
	}
	const changePercent = ((current - previous) / Math.abs(previous)) * 100
	const amount = `${formatNumber(Math.abs(changePercent), { locale: 'en-US' })}%`
	const rounded = Math.round(changePercent * 10) / 10
	return {
		changePercent,
		changeLabel:
			rounded === 0
				? 'No change'
				: rounded > 0
					? `Up ${amount}`
					: `Down ${amount}`,
	}
}

function periodOfRange(range: Range) {
	return {
		start: range.start ? range.start.toISOString() : null,
		end: range.end.toISOString(),
	}
}

export function runReport(
	catalog: ReportCatalog,
	definition: ReportDefinition,
	records: ReportRecord[],
	now = new Date(),
	options: RunReportOptions = {},
): ReportResult | ReportRunError {
	const error = validateReportDefinition(catalog, definition, now)
	if (error) return error
	const subject = getSubject(catalog, definition.subject) as ReportSubject
	const reportZone =
		options.timeZone && isValidTimeZone(options.timeZone)
			? options.timeZone
			: DEFAULT_REPORT_TIME_ZONE
	const zones: ZoneContext = {
		subject,
		reportZone,
		weekStart: weekStartOf(options),
	}
	const rangeCache = new Map<string, ZoneRanges>()
	const timeField = timeBasisFieldId(
		subject,
		definition,
		definition.timeframe.field,
	)

	const matched: ReportRecord[] = []
	const earlier: ReportRecord[] = []
	for (const record of records) {
		const period = periodOf(
			record,
			timeField,
			definition,
			now,
			zones,
			rangeCache,
		)
		if (!period || !matchesGroup(record, definition.filters)) continue
		;(period === 'current' ? matched : earlier).push(record)
	}

	if (isListReport(definition)) {
		return listResult(subject, definition, matched, now, zones)
	}

	const ranges = rangesFor(reportZone, definition, now, zones, rangeCache)
	const comparing = ranges.previous !== null
	// Currencies are looked for across both periods: a comparison of amounts in
	// two currencies is as meaningless as their sum.
	const measured = measuredValue(
		subject,
		definition,
		comparing ? [...matched, ...earlier] : matched,
		matched,
	)
	const ungrouped =
		definition.visualization.chartStyle === 'single_number' ||
		definition.groupBy.length === 0
	// Several currencies can't be added together. On a subject that splits
	// them, a grouped report gives each currency its own segments; otherwise
	// the result keeps its value info for the notice and measures nothing.
	const splitCurrencies = Boolean(
		measured?.info.mixedCurrencies &&
		!ungrouped &&
		subject.splitCurrencies &&
		subject.currencyField,
	)
	if (measured && splitCurrencies) {
		delete measured.info.mixedCurrencies
		measured.info.currencySplit = true
	}
	const valued = measured?.info.mixedCurrencies ? null : measured
	const valueOf = (tally: ValueTally) =>
		valued ? tallyValue(tally, valued) : undefined
	/** The figure a comparison sets side by side: the measured value, else the count. */
	const metricOf = (tally: ValueTally) =>
		valued ? tallyValue(tally, valued) : tally.count

	const groupFields = ungrouped
		? []
		: definition.groupBy
				.map((id) => getField(subject, id))
				.filter((field): field is ReportField => Boolean(field))
				.map((field) => ({
					field,
					readId: timeBasisFieldId(subject, definition, field.id),
				}))
	const currencySubject = splitCurrencies ? subject : null
	const current = tallyPeriod(
		matched,
		groupFields,
		definition,
		zones,
		valued,
		currencySubject,
	)
	const previous = comparing
		? tallyPeriod(
				earlier,
				groupFields,
				definition,
				zones,
				valued,
				currencySubject,
			)
		: null

	const shared = {
		...(measured ? { valueInfo: measured.info } : {}),
		refreshedAt: now.toISOString(),
		timeZone: reportZone,
		period: periodOfRange(ranges.current),
		...(ranges.previous && definition.compare !== 'none'
			? {
					previousPeriod: periodOfRange(ranges.previous),
					compare: definition.compare,
				}
			: {}),
		...(subject.timeBasisFields ? { timeBasis: definition.timeBasis } : {}),
		...(measured?.salesBasis ? { salesBasis: measured.salesBasis } : {}),
	} satisfies Partial<ReportResult>
	const total = matched.length
	const overallValue = splitCurrencies ? undefined : valueOf(current.overall)
	const overallChange = previous
		? (() => {
				const before = splitCurrencies ? undefined : metricOf(previous.overall)
				return {
					...(before === undefined ? {} : { previousValue: before }),
					...describeChange(
						splitCurrencies ? undefined : metricOf(current.overall),
						before,
					),
				}
			})()
		: {}

	if (ungrouped) {
		return {
			total,
			...(valued ? { value: overallValue } : {}),
			...overallChange,
			segments: [
				{
					key: 'total',
					label: subject.label,
					count: total,
					percent: 100,
					...(valued ? { value: overallValue } : {}),
					...overallChange,
				},
			],
			...shared,
		}
	}

	const timeGrouped =
		groupFields.length === 1 &&
		groupFields[0]?.field.type === 'datetime' &&
		!splitCurrencies
	const cyclic = isCyclicTimeBucket(definition.timeBucket)
	/** A timeline: buckets are periods in order, so they can be incomplete. */
	const timeline = timeGrouped && !cyclic

	const fillFrom = (range: Range, records: readonly ReportRecord[]) => {
		const readId = groupFields[0]?.readId ?? ''
		let earliest: Date | null = null
		for (const record of records) {
			const date = asDate(record[readId])
			if (date && (!earliest || date < earliest)) earliest = date
		}
		const first = range.start ?? earliest
		return first
			? iterateTimeBuckets(
					localDateIn(first, reportZone),
					localDateIn(range.end, reportZone),
					definition.timeBucket,
					zones.weekStart,
				)
			: []
	}
	if (
		timeGrouped &&
		(matched.length > 0 || (comparing && earlier.length > 0))
	) {
		for (const slot of fillFrom(ranges.current, matched)) {
			if (!current.buckets.has(slot.key)) {
				current.buckets.set(slot.key, {
					label: slot.label,
					tally: emptyTally(),
				})
			}
		}
	}

	// Which earlier bucket each bucket is set against. Timelines pair the
	// periods in order (the third day with the third day); everything else
	// pairs by key (Monday with Monday, a channel with itself).
	const earlierOf = new Map<string, Bucket & { key: string }>()
	if (previous && ranges.previous) {
		if (timeline) {
			const slots = fillFrom(ranges.previous, earlier)
			const keys = [...current.buckets.keys()].sort((a, b) =>
				a.localeCompare(b),
			)
			keys.forEach((key, index) => {
				const slot = slots[index]
				if (!slot) return
				const bucket = previous.buckets.get(slot.key)
				earlierOf.set(key, {
					key: slot.key,
					label: slot.label,
					tally: bucket?.tally ?? emptyTally(),
				})
			})
		} else {
			for (const [key, bucket] of previous.buckets) {
				earlierOf.set(key, { key, ...bucket })
				// A group that sold before and not now still shows, as a drop.
				if (!current.buckets.has(key)) {
					current.buckets.set(key, {
						label: bucket.label,
						tally: emptyTally(),
						...(bucket.currency ? { currency: bucket.currency } : {}),
					})
				}
			}
		}
	}

	const today = localDateIn(now, reportZone)
	const firstDay = ranges.current.start
		? localDateIn(ranges.current.start, reportZone)
		: null
	const isPartial = (key: string) => {
		if (!timeline) return false
		const days = bucketDays(key, definition.timeBucket)
		if (!days) return false
		// Not over yet, or cut short by where the range begins.
		return days.last >= today || (firstDay !== null && days.first < firstDay)
	}

	const all = [...current.buckets.entries()].map(
		([key, bucket]): ReportSegment => {
			const before = earlierOf.get(key)
			const value = valueOf(bucket.tally)
			const previousValue = before ? metricOf(before.tally) : undefined
			return {
				key,
				label: bucket.label,
				count: bucket.tally.count,
				percent: total === 0 ? 0 : (bucket.tally.count / total) * 100,
				...(valued ? { value } : {}),
				...(bucket.currency ? { currency: bucket.currency } : {}),
				...(previous
					? {
							...(previousValue === undefined ? {} : { previousValue }),
							...(timeline && before ? { previousLabel: before.label } : {}),
							...describeChange(metricOf(bucket.tally), previousValue),
						}
					: {}),
				...(isPartial(key) ? { partial: true } : {}),
			}
		},
	)
	const hidden = definition.settings.hidePartial
		? all.filter((segment) => segment.partial).length
		: 0
	const segments = sortSegments(
		hidden > 0 ? all.filter((segment) => !segment.partial) : all,
		definition.visualization.sortBy,
		timeGrouped,
		Boolean(valued),
	)

	return {
		total,
		...(valued && !splitCurrencies ? { value: overallValue } : {}),
		...overallChange,
		segments,
		...(hidden > 0 ? { partialHidden: hidden } : {}),
		...shared,
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
type Measured = (
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
			unit: 'percent' | 'per_hour' | 'each'
			info: ReportValueInfo
	  }
) & {
	/** Set when the measured figure is the gross-or-net "Sales" figure. */
	salesBasis?: ReportDefinition['salesBasis']
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
		if (measured.unit === 'each') return numerator / denominator
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

/**
 * What the report measures. `records` is everything the run reads (both
 * periods of a comparison), where currencies are looked for; `current` is the
 * report's own period, which the excluded count is about.
 */
function measuredValue(
	subject: ReportSubject,
	definition: ReportDefinition,
	matched: ReportRecord[],
	current: ReportRecord[] = matched,
): Measured | null {
	const { measure, valueField } = definition.visualization
	if (!measuresAValueField(measure) || !valueField) return null
	const basis = subject.salesBasisField
	const field = getField(
		subject,
		salesBasisFieldId(subject, definition, valueField),
	)
	if (!field) return null

	if (isRatioMeasure(measure)) {
		const parts = resolvedRatioParts(subject, definition, field)
		if (!parts) return null
		const onSalesBasis =
			basis !== undefined &&
			[field.ratio?.numerator, field.ratio?.denominator].includes(basis.field)
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
		info.excluded = current.filter((record) => !both(record)).length
		if (
			parts.numerator.type === 'currency' ||
			parts.denominator.type === 'currency'
		) {
			// Cost and sales in different currencies can't be divided, so only
			// one currency's records may be in a ratio.
			const currency = currencyOf(matched, subject, both)
			if (currency.mixed) info.mixedCurrencies = true
			else if (currency.currency && parts.unit !== 'percent') {
				info.currency = currency.currency
			}
		}
		return {
			kind: 'ratio',
			field,
			...parts,
			info,
			...(onSalesBasis ? { salesBasis: definition.salesBasis } : {}),
		}
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
	return {
		kind: 'value',
		measure,
		field,
		info,
		...(basis && valueField === basis.field
			? { salesBasis: definition.salesBasis }
			: {}),
	}
}

export function isReportRunError(
	value: ReportResult | ReportRunError,
): value is ReportRunError {
	return 'error' in value
}
