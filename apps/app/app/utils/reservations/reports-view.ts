import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { type ReportKind } from '#app/utils/reservations/reports-api.ts'
import { WAITLIST_STATUS_LABELS } from '#app/utils/reservations/waitlist-view.ts'

export const REPORT_TITLES: Record<ReportKind, MessageDescriptor> = {
	summary: msg`Summary`,
	'no-shows': msg`No-shows`,
	cancellations: msg`Cancellations`,
	'turn-times': msg`Turn times`,
	waitlist: msg`Waitlist`,
	pacing: msg`Pacing`,
}

export const CANCELLED_BY_LABELS: Record<string, MessageDescriptor> = {
	guest: msg`Guest`,
	restaurant: msg`Restaurant`,
	system: msg`System`,
	unknown: msg`Unknown`,
}

export const OUTCOME_LABELS = WAITLIST_STATUS_LABELS

export const REPORT_ERROR_MESSAGES: Record<string, MessageDescriptor> = {
	invalid_range: msg`The start date must be on or before the end date.`,
	range_too_long: msg`A report covers at most 366 days. Choose a shorter range.`,
	invalid: msg`Check the dates and try again.`,
}

/** Adds whole days to a `YYYY-MM-DD` business date without a time zone shift. */
export function addDays(date: string, days: number): string {
	const parsed = new Date(`${date}T00:00:00Z`)
	if (Number.isNaN(parsed.getTime())) return date
	parsed.setUTCDate(parsed.getUTCDate() + days)
	return parsed.toISOString().slice(0, 10)
}

/** Rate such as `12.5%`; the report sends one decimal of precision. */
export function formatPercent(value: number, locale: string): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'percent',
			maximumFractionDigits: 1,
		}).format(value / 100)
	} catch {
		return `${value}%`
	}
}

export function formatMinutes(
	value: number | null,
	locale: string,
): string | null {
	if (value === null) return null
	try {
		return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
			value,
		)
	} catch {
		return String(value)
	}
}
