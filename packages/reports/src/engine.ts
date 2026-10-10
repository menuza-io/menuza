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
	isFilterGroup,
	isListReport,
	isValueMeasure,
} from './dsl.ts'
import {
	type ReportCatalog,
	type ReportField,
	type ReportSubject,
	defaultListColumns,
	getField,
	getSubject,
	valueMeasureLabel,
} from './catalog.ts'
import { formatCurrency, formatNumber } from './format.ts'

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

export function resolveTimeframeRange(
	preset: TimeframePreset,
	now = new Date(),
	custom?: { start?: string; end?: string },
): { start: Date | null; end: Date } {
	const end = new Date(now)
	if (preset === 'all_time') return { start: null, end }
	if (preset === 'custom') {
		return {
			start: custom?.start ? asDate(custom.start) : null,
			end: custom?.end ? (asDate(custom.end) ?? end) : end,
		}
	}

	const start = new Date(now)
	start.setHours(0, 0, 0, 0)
	if (preset === 'today') return { start, end }
	if (preset === 'last_7_days') start.setDate(start.getDate() - 6)
	else if (preset === 'last_30_days') start.setDate(start.getDate() - 29)
	else if (preset === 'last_3_months') start.setMonth(start.getMonth() - 3)
	else if (preset === 'last_6_months') start.setMonth(start.getMonth() - 6)
	else if (preset === 'last_12_months')
		start.setFullYear(start.getFullYear() - 1)
	return { start, end }
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
	return bucket === 'week' ? 'Weekly' : 'Monthly'
}

function inTimeframe(
	record: ReportRecord,
	definition: ReportDefinition,
	now?: Date,
): boolean {
	const value = asDate(record[definition.timeframe.field])
	if (!value) return false
	const { start, end } = resolveTimeframeRange(
		definition.timeframe.preset,
		now,
		definition.timeframe,
	)
	if (start && value < start) return false
	if (value > end) return false
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

function startOfUtcWeek(date: Date): Date {
	const day = date.getUTCDay()
	const mondayOffset = day === 0 ? -6 : 1 - day
	return new Date(
		Date.UTC(
			date.getUTCFullYear(),
			date.getUTCMonth(),
			date.getUTCDate() + mondayOffset,
		),
	)
}

function monthKey(date: Date): string {
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function weekKey(date: Date): string {
	return startOfUtcWeek(date).toISOString().slice(0, 10)
}

function formatMonthLabel(date: Date): string {
	return date.toLocaleString('en-US', {
		month: 'short',
		year: 'numeric',
		timeZone: 'UTC',
	})
}

function formatWeekLabel(date: Date): string {
	const start = startOfUtcWeek(date)
	const end = new Date(start)
	end.setUTCDate(end.getUTCDate() + 6)
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

function datetimeBucket(
	value: unknown,
	timeBucket: TimeBucket,
): { key: string; label: string } {
	const date = asDate(value)
	if (!date) return { key: 'unspecified', label: 'Unspecified' }
	if (timeBucket === 'week') {
		return { key: weekKey(date), label: formatWeekLabel(date) }
	}
	return { key: monthKey(date), label: formatMonthLabel(date) }
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
): { key: string; label: string } {
	const raw = record[field.id]
	if (field.type === 'datetime') {
		return datetimeBucket(raw, timeBucket)
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
): string {
	const raw = record[field.id]
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
		return date.toISOString().slice(0, 10)
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
		copy.sort((a, b) => a.label.localeCompare(b.label))
	} else if (sortBy === 'value_asc') {
		copy.sort((a, b) => metric(a) - metric(b))
	} else if (sortBy === 'value_desc') {
		copy.sort((a, b) => metric(b) - metric(a))
	}
	return copy
}

function iterateTimeBuckets(
	start: Date,
	end: Date,
	timeBucket: TimeBucket,
): Array<{ key: string; label: string }> {
	const buckets: Array<{ key: string; label: string }> = []
	if (timeBucket === 'week') {
		let cursor = startOfUtcWeek(start)
		const last = startOfUtcWeek(end)
		while (cursor <= last) {
			buckets.push({
				key: weekKey(cursor),
				label: formatWeekLabel(cursor),
			})
			cursor = new Date(cursor)
			cursor.setUTCDate(cursor.getUTCDate() + 7)
		}
		return buckets
	}

	let cursor = new Date(
		Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1),
	)
	const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
	while (cursor <= last) {
		buckets.push({
			key: monthKey(cursor),
			label: formatMonthLabel(cursor),
		})
		cursor = new Date(
			Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
		)
	}
	return buckets
}

function needsGroupBy(definition: ReportDefinition) {
	const style = definition.visualization.chartStyle
	return style === 'pie' || style === 'bar'
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
	if (isValueMeasure(measure) && !isListReport(definition)) {
		const field = valueField ? getField(subject, valueField) : null
		if (!field || valueMeasureLabel(measure, field) === null) {
			return {
				error: 'invalid_definition',
				message:
					measure === 'sum'
						? 'Choose a number to add up.'
						: 'Choose a number to average.',
			}
		}
		if (
			measure === 'average' &&
			definition.visualization.chartStyle === 'pie'
		) {
			return {
				error: 'invalid_definition',
				message:
					'Averages don’t add up to a whole, so they can’t be a pie chart. Choose a bar chart or table.',
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

function listResult(
	subject: ReportSubject,
	definition: ReportDefinition,
	matched: ReportRecord[],
	now: Date,
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
		for (const column of columns) {
			const field = getField(subject, column.id)
			row[column.id] = field ? formatListCell(record, field, subject) : '—'
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
	}
}

export function runReport(
	catalog: ReportCatalog,
	definition: ReportDefinition,
	records: ReportRecord[],
	now = new Date(),
): ReportResult | ReportRunError {
	const error = validateReportDefinition(catalog, definition)
	if (error) return error
	const subject = getSubject(catalog, definition.subject) as ReportSubject

	const matched = records.filter(
		(record) =>
			inTimeframe(record, definition, now) &&
			matchesGroup(record, definition.filters),
	)

	if (isListReport(definition)) {
		return listResult(subject, definition, matched, now)
	}

	const measured = measuredValue(subject, definition, matched)
	// Amounts in different currencies can't be added together, so a mixed
	// result keeps its value info for the notice but measures nothing.
	const valued = measured?.info.mixedCurrencies ? null : measured
	const valueOf = (tally: ValueTally) =>
		valued ? tallyValue(tally, valued.measure, valued.field) : undefined

	if (
		definition.visualization.chartStyle === 'single_number' ||
		definition.groupBy.length === 0
	) {
		const tally = emptyTally()
		for (const record of matched) addToTally(tally, record, valued?.field)
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
		const parts = groupFields.map((field) =>
			segmentValue(record, field, definition.timeBucket),
		)
		const key = parts.map((part) => part.key).join(' / ')
		const label = parts.map((part) => part.label).join(' / ')
		let bucket = buckets.get(key)
		if (!bucket) {
			bucket = { label, tally: emptyTally() }
			buckets.set(key, bucket)
		}
		addToTally(bucket.tally, record, valued?.field)
		addToTally(overall, record, valued?.field)
	}

	if (timeGrouped && matched.length > 0) {
		const range = resolveTimeframeRange(
			definition.timeframe.preset,
			now,
			definition.timeframe,
		)
		const earliest =
			matched
				.map((record) => asDate(record[definition.groupBy[0] ?? '']))
				.filter((date): date is Date => Boolean(date))
				.sort((a, b) => a.getTime() - b.getTime())[0] ?? now
		const fillStart = range.start ?? earliest
		for (const slot of iterateTimeBuckets(
			fillStart,
			range.end,
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
	}
}

type ValueTally = {
	count: number
	/** Records with a numeric value; averages divide by this, not `count`. */
	valued: number
	sum: number
}

function emptyTally(): ValueTally {
	return { count: 0, valued: 0, sum: 0 }
}

function addToTally(
	tally: ValueTally,
	record: ReportRecord,
	field: ReportField | undefined,
) {
	tally.count += 1
	if (!field) return
	const amount = asNumber(record[field.id])
	if (amount === null) return
	tally.valued += 1
	// Money adds up in minor units so sums don't pick up float drift.
	tally.sum += field.type === 'currency' ? Math.round(amount * 100) : amount
}

function tallyValue(
	tally: ValueTally,
	measure: ValueMeasure,
	field: ReportField,
): number | undefined {
	const sum = field.type === 'currency' ? tally.sum / 100 : tally.sum
	if (measure === 'sum') return sum
	// An average of no amounts is unknown rather than zero, so empty time
	// buckets don't chart as a drop to nothing.
	return tally.valued === 0 ? undefined : sum / tally.valued
}

function measuredValue(
	subject: ReportSubject,
	definition: ReportDefinition,
	matched: ReportRecord[],
): { measure: ValueMeasure; field: ReportField; info: ReportValueInfo } | null {
	const { measure, valueField } = definition.visualization
	if (!isValueMeasure(measure) || !valueField) return null
	const field = getField(subject, valueField)
	const label = field ? valueMeasureLabel(measure, field) : null
	if (!field || label === null) return null

	const info: ReportValueInfo = {
		measure,
		field: field.id,
		label,
		type: field.type === 'currency' ? 'currency' : 'number',
	}
	if (field.type === 'currency') {
		const currencies = new Set<string>()
		for (const record of matched) {
			if (asNumber(record[field.id]) === null) continue
			const currency = recordCurrency(record, subject)
			if (currency) currencies.add(currency)
		}
		if (currencies.size === 1) info.currency = [...currencies][0]
		else if (currencies.size > 1) info.mixedCurrencies = true
	}
	return { measure, field, info }
}

export function isReportRunError(
	value: ReportResult | ReportRunError,
): value is ReportRunError {
	return 'error' in value
}
