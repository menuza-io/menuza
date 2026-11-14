/**
 * The promised time line on the order page: "Ready around 6:40 PM" for
 * pickup, "Arriving 7:05 – 7:20 PM" (a range) or "Arriving around 7:05 PM"
 * for delivery. Formatted in the location's time zone and the page locale.
 */

export type PromisedTimeLabels = {
	/** `{time}` placeholder. */
	readyAround: string
	/** `{time}` placeholder. */
	arrivingAround: string
	/** `{range}` placeholder. */
	arriving: string
}

export type PromisedTimeInput = {
	promisedAt: string | null | undefined
	promisedUntil?: string | null
	fulfillment: string
	status: string
	paymentStatus: string
	timeZone: string
	locale: string
}

/** Statuses after which a promise means nothing. */
const SETTLED_STATUSES = new Set(['completed', 'cancelled', 'expired'])
/** Payment states where the order is not confirmed yet. */
const UNCONFIRMED_PAYMENT = new Set(['pending', 'failed', 'expired'])

export function promisedTimeIsLive(input: {
	status: string
	paymentStatus: string
}): boolean {
	return (
		!SETTLED_STATUSES.has(input.status) &&
		input.status !== 'payment_review' &&
		!UNCONFIRMED_PAYMENT.has(input.paymentStatus)
	)
}

function parse(value: string | null | undefined): Date | null {
	if (!value) return null
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? null : date
}

function format(locale: string, timeZone: string): Intl.DateTimeFormat | null {
	const options: Intl.DateTimeFormatOptions = {
		hour: 'numeric',
		minute: '2-digit',
	}
	for (const zone of [timeZone, 'UTC']) {
		try {
			return new Intl.DateTimeFormat(locale, { ...options, timeZone: zone })
		} catch {
			// Unknown locale or zone: try the next fallback.
		}
	}
	return null
}

function fill(template: string, name: string, value: string): string {
	return template.replace(`{${name}}`, value)
}

/** The line to show, or null when there is nothing to promise. */
export function formatPromisedTime(
	input: PromisedTimeInput,
	labels: PromisedTimeLabels,
): string | null {
	if (!promisedTimeIsLive(input)) return null
	const at = parse(input.promisedAt)
	if (!at) return null
	const formatter = format(input.locale, input.timeZone)
	if (!formatter) return null
	if (input.fulfillment !== 'delivery') {
		return fill(labels.readyAround, 'time', formatter.format(at))
	}
	const until = parse(input.promisedUntil)
	if (until && until.getTime() > at.getTime()) {
		const range =
			typeof formatter.formatRange === 'function'
				? formatter.formatRange(at, until)
				: `${formatter.format(at)} – ${formatter.format(until)}`
		return fill(labels.arriving, 'range', range)
	}
	return fill(labels.arrivingAround, 'time', formatter.format(at))
}
