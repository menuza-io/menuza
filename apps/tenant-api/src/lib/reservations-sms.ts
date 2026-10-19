import { sendSms } from '@repo/sms'
import { fillCopy, messageCopyFor } from './reservations-copy/index.ts'
import {
	formatMoney,
	formatWhen,
	normalizeReservationLocale,
	type PaymentEmailKind,
} from './reservations-email.ts'
import { getNodeRegion } from './region.ts'
import { type ToggleableMessageKind } from './reservations-messaging-settings.ts'

/**
 * Guest reservation SMS. US node only: the KSA node uses email and the status
 * pages, and never reaches the SMS provider. The text is short, names the
 * restaurant and the time, and carries the manage or status link.
 */

export type ReservationSmsInput = {
	kind: ToggleableMessageKind | PaymentEmailKind
	amountMinor?: number | null
	currency?: string | null
	locale: string
	restaurantName: string
	whenMs?: number | null
	timeZone?: string | null
	partySize?: number | null
	url?: string | null
	quotedWaitMin?: number | null
}

export function renderReservationSms(input: ReservationSmsInput): string {
	const locale = normalizeReservationLocale(input.locale)
	const copyset = messageCopyFor(locale)
	const entry = copyset.kinds[input.kind]
	const when =
		typeof input.whenMs === 'number'
			? formatWhen(input.whenMs, input.timeZone, locale)
			: null
	const wait =
		typeof input.quotedWaitMin === 'number'
			? fillCopy(copyset.labels.smsWait, {
					min: String(Math.round(input.quotedWaitMin)),
				})
			: ''
	// A notify-me request spans a time range, so the message has no single time to name.
	const template = !when && entry.smsNoTime ? entry.smsNoTime : entry.sms
	const base = fillCopy(template, {
		r: input.restaurantName,
		when: when ? `${when.date}, ${when.time}` : '',
		n: input.partySize ? String(input.partySize) : '',
		wait,
		amount: formatMoney(input.amountMinor, input.currency, locale),
	})
	return input.url ? `${base} ${input.url}` : base
}

/**
 * Sends one SMS. Refuses anywhere but the US node as a second line of defense
 * behind the channel rule that decides whether an SMS row exists at all.
 */
export async function sendReservationSms(input: {
	to: string
	message: string
}): Promise<void> {
	if (getNodeRegion() !== 'us') throw new Error('sms_not_allowed')
	await sendSms({ to: input.to, message: input.message })
}
