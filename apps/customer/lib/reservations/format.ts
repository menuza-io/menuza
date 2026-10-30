import { isValidTimeZone } from '@repo/zoned-time'
import { type BookingFailure } from './booking-flow'
import { countdownClock } from './models'

// Display helpers for the reservation screens. Server values (`date`, `time`)
// are business-day strings in the location's time zone; nothing here converts
// them to the device's zone. Every user-visible sentence is a message key the
// UI translates; these helpers only format the values that go into them.

/**
 * Wraps text that must keep its own direction (times, phone numbers, amounts)
 * in a left-to-right isolate, so it reads correctly in Arabic.
 */
export function ltr(text: string): string {
	return `\u2066${text}\u2069`
}

const BUSINESS_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** A `yyyy-MM-dd` business date as UTC midnight, the zone the date helpers format in. */
function parseBusinessDate(date: string): Date | null {
	const match = BUSINESS_DATE.exec(date)
	if (!match) return null
	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	const value = new Date(Date.UTC(year, month - 1, day))
	if (
		value.getUTCFullYear() !== year ||
		value.getUTCMonth() !== month - 1 ||
		value.getUTCDate() !== day
	) {
		return null
	}
	return value
}

function formatter(
	locale: string,
	options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
	try {
		return new Intl.DateTimeFormat(locale, options)
	} catch {
		return new Intl.DateTimeFormat('en', options)
	}
}

/** "Mon, Jun 24" for a business date, in the app language. An unreadable date is returned as is. */
export function dateLabel(date: string, locale: string): string {
	const parsed = parseBusinessDate(date)
	if (!parsed) return date
	return formatter(locale, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC',
	}).format(parsed)
}

/** "Mon" for a business date; empty for an unreadable one. */
export function shortWeekday(date: string, locale: string): string {
	const parsed = parseBusinessDate(date)
	if (!parsed) return ''
	return formatter(locale, { weekday: 'short', timeZone: 'UTC' }).format(parsed)
}

/** "4" for `2030-06-04`: the day of the month without a leading zero. */
export function dayNumber(date: string): string {
	return date.slice(-2).replace(/^0+/, '')
}

/** "5:00 PM" for an instant, in the booking's own time zone (UTC when the zone is unknown). */
export function timeOfDay(
	instantMs: number,
	timeZone: string,
	locale: string,
): string {
	return ltr(
		formatter(locale, {
			hour: 'numeric',
			minute: '2-digit',
			timeZone: isValidTimeZone(timeZone) ? timeZone : 'UTC',
		}).format(new Date(instantMs)),
	)
}

/** An amount in minor units with its ISO currency. */
export type Money = { readonly minor: number; readonly currency: string }

/** "$25.00" from minor units, with the currency's own number of decimals. */
export function money(minor: number, currency: string, locale: string): string {
	let format: Intl.NumberFormat
	try {
		format = new Intl.NumberFormat(locale, { style: 'currency', currency })
	} catch {
		try {
			format = new Intl.NumberFormat('en', { style: 'currency', currency })
		} catch {
			return String(minor)
		}
	}
	const digits = Math.max(
		format.resolvedOptions().maximumFractionDigits ?? 0,
		0,
	)
	return format.format(minor / 10 ** digits)
}

export function formatMoney(amount: Money, locale: string): string {
	return money(amount.minor, amount.currency, locale)
}

/** "6:42" for a countdown in milliseconds. */
export function clock(remainingMs: number): string {
	return countdownClock(remainingMs)
}

// Message keys -----------------------------------------------------------------

/**
 * Every key the reservation screens use, the same keys as the iOS
 * `Localizable.strings` (`rsv.*`), so translations can be shared.
 */
export const RESERVATION_MESSAGE_KEYS = [
	'app.loading',
	'app.retry',
	'profile.phone',
	'rsv.home.title',
	'rsv.home.book',
	'rsv.home.mine',
	'rsv.home.empty',
	'rsv.home.past',
	'rsv.home.waitlist',
	'rsv.home.profile',
	'rsv.unavailable',
	'rsv.ok',
	'rsv.location.title',
	'rsv.search.title',
	'rsv.search.party',
	'rsv.search.partyCount',
	'rsv.search.date',
	'rsv.search.times',
	'rsv.search.noTimes',
	'rsv.search.alternatives',
	'rsv.search.otherDays',
	'rsv.search.closed',
	'rsv.search.largeParty',
	'rsv.search.largePartyContact',
	'rsv.search.preferredTime',
	'rsv.search.request',
	'rsv.search.retry',
	'rsv.search.waitlist',
	'rsv.details.title',
	'rsv.details.holding',
	'rsv.details.firstName',
	'rsv.details.lastName',
	'rsv.details.email',
	'rsv.details.occasion',
	'rsv.details.none',
	'rsv.details.dietary',
	'rsv.details.requests',
	'rsv.details.area',
	'rsv.details.anyArea',
	'rsv.details.sms',
	'rsv.details.phoneNote',
	'rsv.details.review',
	'rsv.review.title',
	'rsv.review.confirm',
	'rsv.review.pay',
	'rsv.review.back',
	'rsv.review.name',
	'rsv.policy.deposit',
	'rsv.policy.guarantee',
	'rsv.policy.freeCancelHours',
	'rsv.policy.lateFee',
	'rsv.policy.noShowFee',
	'rsv.policy.consent',
	'rsv.pay.title',
	'rsv.pay.amount',
	'rsv.pay.amountLabel',
	'rsv.pay.open',
	'rsv.pay.hint',
	'rsv.pay.checking',
	'rsv.pay.expires',
	'rsv.pay.check',
	'rsv.pay.review',
	'rsv.pay.expired',
	'rsv.pay.failed',
	'rsv.pay.refunded',
	'rsv.confirmed.title',
	'rsv.confirmed.requested',
	'rsv.confirmed.requestedBody',
	'rsv.confirmed.code',
	'rsv.confirmed.view',
	'rsv.confirmed.done',
	'rsv.detail.title',
	'rsv.detail.when',
	'rsv.detail.where',
	'rsv.detail.party',
	'rsv.detail.modify',
	'rsv.detail.cancel',
	'rsv.detail.cancelConfirm',
	'rsv.detail.cancelKeep',
	'rsv.detail.late',
	'rsv.detail.lateMinutes',
	'rsv.detail.lateSent',
	'rsv.detail.call',
	'rsv.detail.deadline',
	'rsv.status.requested',
	'rsv.status.pending_payment',
	'rsv.status.booked',
	'rsv.status.confirmed',
	'rsv.status.arrived',
	'rsv.status.seated',
	'rsv.status.finished',
	'rsv.status.cancelled',
	'rsv.status.no_show',
	'rsv.status.declined',
	'rsv.status.expired',
	'rsv.status.other',
	'rsv.waitlist.title',
	'rsv.waitlist.join',
	'rsv.waitlist.name',
	'rsv.waitlist.position',
	'rsv.waitlist.quoted',
	'rsv.waitlist.notified',
	'rsv.waitlist.onMyWay',
	'rsv.waitlist.leave',
	'rsv.waitlist.left',
	'rsv.waitlist.seated',
	'rsv.waitlist.invalid',
	'rsv.waitlist.refreshFailed',
	'rsv.error.slotUnavailable',
	'rsv.error.holdExpired',
	'rsv.error.policyRequired',
	'rsv.error.paymentUnavailable',
	'rsv.error.rateLimited',
	'rsv.error.tooManyActive',
	'rsv.error.signIn',
	'rsv.error.phoneOverlap',
	'rsv.error.partySize',
	'rsv.error.invalid',
	'rsv.error.largeParty',
	'rsv.error.requestsClosed',
	'rsv.error.paused',
	'rsv.error.notFound',
	'rsv.error.offline',
	'rsv.error.generic',
	'rsv.error.waitlistDuplicate',
	'rsv.error.waitlistFull',
] as const

export type ReservationMessageKey = (typeof RESERVATION_MESSAGE_KEYS)[number]

export type FailureMessageKey = Extract<
	ReservationMessageKey,
	`rsv.error.${string}` | 'rsv.pay.failed' | 'rsv.pay.refunded'
>

export function isSlotUnavailable(failure: BookingFailure): boolean {
	return failure.kind === 'slotUnavailable'
}

/** The message shown for a failure. */
export function failureMessageKey(failure: BookingFailure): FailureMessageKey {
	switch (failure.kind) {
		case 'slotUnavailable':
			return 'rsv.error.slotUnavailable'
		case 'holdExpired':
			return 'rsv.error.holdExpired'
		case 'policyRequired':
			return 'rsv.error.policyRequired'
		case 'paymentUnavailable':
			return 'rsv.error.paymentUnavailable'
		case 'rateLimited':
			return failure.reason === 'phone_active_limit'
				? 'rsv.error.tooManyActive'
				: 'rsv.error.rateLimited'
		case 'signInRequired':
			return 'rsv.error.signIn'
		case 'phoneOverlap':
			return 'rsv.error.phoneOverlap'
		case 'partySizeInvalid':
			return 'rsv.error.partySize'
		case 'invalid':
			return 'rsv.error.invalid'
		case 'largePartyOnly':
			return 'rsv.error.largeParty'
		case 'requestsClosed':
			return 'rsv.error.requestsClosed'
		case 'paused':
			return 'rsv.error.paused'
		case 'notFound':
			return 'rsv.error.notFound'
		case 'alreadyOnWaitlist':
			return 'rsv.error.waitlistDuplicate'
		case 'waitlistFull':
			return 'rsv.error.waitlistFull'
		case 'paymentFailed':
			return 'rsv.pay.failed'
		case 'paymentRefunded':
			return 'rsv.pay.refunded'
		case 'offline':
			return 'rsv.error.offline'
		case 'idempotencyConflict':
		case 'generic':
			return 'rsv.error.generic'
	}
}

const KNOWN_STATUSES = new Set([
	'requested',
	'pending_payment',
	'booked',
	'confirmed',
	'arrived',
	'seated',
	'finished',
	'cancelled',
	'no_show',
	'declined',
	'expired',
])

export type ReservationStatusKey = Extract<
	ReservationMessageKey,
	`rsv.status.${string}`
>

/** `rsv.status.<status>`; an unknown status falls back to a generic label. */
export function reservationStatusKey(status: string): ReservationStatusKey {
	return KNOWN_STATUSES.has(status)
		? (`rsv.status.${status}` as ReservationStatusKey)
		: 'rsv.status.other'
}
