import {
	type ReportResult,
	type ReportSegment,
	type ReportValueInfo,
} from './dsl.ts'

type FormatOptions = {
	locale?: string
	/** Short axis-style output such as "$1.2K". */
	compact?: boolean
}

export function formatNumber(value: number, options: FormatOptions = {}) {
	return new Intl.NumberFormat(
		options.locale,
		options.compact
			? { notation: 'compact', maximumFractionDigits: 1 }
			: { maximumFractionDigits: 2 },
	).format(value)
}

export function formatCurrency(
	amount: number,
	currency: string,
	options: FormatOptions = {},
) {
	const code = currency.trim().toUpperCase()
	try {
		return new Intl.NumberFormat(options.locale, {
			style: 'currency',
			currency: code,
			...(options.compact
				? { notation: 'compact', maximumFractionDigits: 1 }
				: {}),
		}).format(amount)
	} catch {
		// Not an ISO 4217 code Intl knows; show the amount and the raw code.
		return `${formatNumber(amount, options)} ${code}`.trim()
	}
}

export function formatPercent(value: number) {
	return `${value.toFixed(1)}%`
}

/** Formats a sum or average the way its value field reads. */
export function formatMeasuredValue(
	value: number,
	info: ReportValueInfo | undefined,
	options: FormatOptions = {},
) {
	if (info?.type === 'currency' && info.currency) {
		return formatCurrency(value, info.currency, options)
	}
	if (info?.type === 'currency' && !options.compact) {
		return new Intl.NumberFormat(options.locale, {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		}).format(value)
	}
	return formatNumber(value, options)
}

/**
 * A segment's or result's measured value for display. Averages over no
 * amounts have no value and read as a dash.
 */
export function formatOptionalValue(
	value: number | undefined,
	info: ReportValueInfo,
	options: FormatOptions = {},
) {
	return value === undefined ? '—' : formatMeasuredValue(value, info, options)
}

/** The number a single-number report shows: the measured value or the count. */
export function formatResultHeadline(
	result: Pick<ReportResult, 'total' | 'value' | 'valueInfo'>,
	options: FormatOptions = {},
) {
	if (result.valueInfo) {
		return formatOptionalValue(result.value, result.valueInfo, options)
	}
	return formatNumber(result.total, options)
}

/**
 * A segment's percent. Sums show the segment's share of the report-wide sum;
 * counts and averages show its share of the matched records.
 */
export function segmentPercent(
	segment: ReportSegment,
	result: Pick<ReportResult, 'value' | 'valueInfo'>,
) {
	if (result.valueInfo?.measure !== 'sum') return segment.percent
	if (!result.value || segment.value === undefined) return 0
	return (segment.value / result.value) * 100
}

/**
 * Columns a grouped table shows, on screen and in CSV. An average's percent
 * column would be a share of records next to a per-record amount, so it is
 * left out.
 */
export function segmentTableColumns(
	hideCounts: boolean,
	result: Pick<ReportResult, 'valueInfo'>,
) {
	return {
		count: !hideCounts,
		value: result.valueInfo ?? null,
		percent: result.valueInfo?.measure !== 'average',
	}
}
