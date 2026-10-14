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

/**
 * Minutes as hours and minutes ("12h 30m"), in the viewer's language when a
 * locale is given. Whole hours drop the minutes, and a duration under an hour
 * shows minutes only. Negative durations (a variance) keep their sign.
 */
export function formatDuration(minutes: number, options: FormatOptions = {}) {
	if (!Number.isFinite(minutes)) return '—'
	const total = Math.round(Math.abs(minutes))
	const hours = Math.floor(total / 60)
	const rest = total % 60
	const unit = (value: number, name: 'hour' | 'minute') =>
		new Intl.NumberFormat(options.locale, {
			style: 'unit',
			unit: name,
			unitDisplay: 'narrow',
		}).format(value)
	const parts: string[] = []
	if (hours > 0) parts.push(unit(hours, 'hour'))
	if (rest > 0 || hours === 0) parts.push(unit(rest, 'minute'))
	const text = parts.join(' ')
	return minutes < 0 && total > 0 ? `-${text}` : text
}

/** Formats a sum, average or ratio the way its value field reads. */
export function formatMeasuredValue(
	value: number,
	info: ReportValueInfo | undefined,
	options: FormatOptions = {},
) {
	if (info?.type === 'duration') return formatDuration(value, options)
	if (info?.type === 'percent') {
		return `${new Intl.NumberFormat(options.locale, {
			maximumFractionDigits: 1,
		}).format(value)}%`
	}
	if (info?.perHour) {
		const amount =
			info.type === 'currency' && info.currency
				? formatCurrency(value, info.currency, options)
				: formatNumber(value, options)
		return `${amount}/h`
	}
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
 * amounts, and amounts in more than one currency, have no value and read as a
 * dash.
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
 * The value info of a result whose values can be shown. Amounts in more than
 * one currency aren't added together, so charts, tables, and exports of those
 * results fall back to record counts.
 */
export function shownValueInfo(result: Pick<ReportResult, 'valueInfo'>) {
	const info = result.valueInfo
	return info && !info.mixedCurrencies ? info : null
}

/**
 * A segment's percent. Sums show the segment's share of the report-wide sum;
 * counts and averages show its share of the matched records.
 */
export function segmentPercent(
	segment: ReportSegment,
	result: Pick<ReportResult, 'value' | 'valueInfo'>,
) {
	if (shownValueInfo(result)?.measure !== 'sum') return segment.percent
	if (!result.value || segment.value === undefined) return 0
	return (segment.value / result.value) * 100
}

/**
 * Columns a grouped table shows, on screen and in CSV. An average's or a
 * ratio's percent column would be a share of records next to a per-record
 * amount, so it is left out.
 */
export function segmentTableColumns(
	hideCounts: boolean,
	result: Pick<ReportResult, 'valueInfo'>,
) {
	const info = shownValueInfo(result)
	return {
		count: !hideCounts,
		value: info,
		percent: info?.measure !== 'average' && info?.measure !== 'ratio',
	}
}
