import { sendSms } from '@repo/sms'
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

const EN: Record<ToggleableMessageKind | PaymentEmailKind, string> = {
	confirmation: '{r}: booking confirmed for {when}, party of {n}.',
	modification: '{r}: your booking changed to {when}, party of {n}.',
	cancellation_guest: '{r}: your booking for {when} was cancelled.',
	cancellation_restaurant:
		'{r}: we had to cancel your booking for {when}. Please contact us.',
	reminder: '{r}: reminder of your booking at {when}, party of {n}.',
	reconfirm_request: '{r}: please confirm your booking at {when}.',
	request_received: '{r}: we received your request and will reply soon.',
	request_approved: '{r}: your request was approved for {when}.',
	request_declined: '{r}: we could not accept your request.',
	waitlist_joined: "{r}: you're on the waitlist.{wait}",
	waitlist_ready: '{r}: your table is ready.',
	notify_available: '{r}: a table opened up for {when}. Book now.',
	payment_received:
		'{r}: payment of {amount} received, booking confirmed for {when}.',
	refund_issued: '{r}: we refunded {amount} to your payment method.',
	fee_charged: '{r}: a fee of {amount} was charged to your card on file.',
	fee_action_required: '{r}: your bank needs you to confirm a fee of {amount}.',
	late_payment_refunded: '{r}: your payment of {amount} was refunded in full.',
}

const AR: Record<ToggleableMessageKind | PaymentEmailKind, string> = {
	confirmation: '{r}: تم تأكيد حجزك في {when} لـ {n} أشخاص.',
	modification: '{r}: تم تعديل حجزك إلى {when} لـ {n} أشخاص.',
	cancellation_guest: '{r}: تم إلغاء حجزك في {when}.',
	cancellation_restaurant:
		'{r}: اضطررنا إلى إلغاء حجزك في {when}. يرجى التواصل معنا.',
	reminder: '{r}: تذكير بحجزك في {when} لـ {n} أشخاص.',
	reconfirm_request: '{r}: يرجى تأكيد حجزك في {when}.',
	request_received: '{r}: استلمنا طلبك وسنرد قريباً.',
	request_approved: '{r}: تمت الموافقة على طلبك في {when}.',
	request_declined: '{r}: تعذّر علينا قبول طلبك.',
	waitlist_joined: '{r}: أنت في قائمة الانتظار.{wait}',
	waitlist_ready: '{r}: طاولتك جاهزة.',
	notify_available: '{r}: توفرت طاولة في {when}. احجز الآن.',
	payment_received: '{r}: تم استلام دفعة {amount}، وتم تأكيد حجزك في {when}.',
	refund_issued: '{r}: أعدنا مبلغ {amount} إلى وسيلة الدفع.',
	fee_charged: '{r}: تم خصم رسوم {amount} من بطاقتك المسجلة.',
	fee_action_required: '{r}: يطلب مصرفك تأكيد رسوم بمبلغ {amount}.',
	late_payment_refunded: '{r}: تم استرداد دفعتك {amount} بالكامل.',
}

const NOTIFY_WITHOUT_TIME = {
	en: '{r}: a table opened up. Book now.',
	ar: '{r}: توفرت طاولة. احجز الآن.',
} as const

export function renderReservationSms(input: ReservationSmsInput): string {
	const locale = normalizeReservationLocale(input.locale)
	const when =
		typeof input.whenMs === 'number'
			? formatWhen(input.whenMs, input.timeZone, locale)
			: null
	const wait =
		typeof input.quotedWaitMin === 'number'
			? locale === 'ar'
				? ` الانتظار المتوقع ${Math.round(input.quotedWaitMin)} دقيقة.`
				: ` Estimated wait ${Math.round(input.quotedWaitMin)} min.`
			: ''
	// A notify-me request spans a time range, so the message has no single time to name.
	const template =
		input.kind === 'notify_available' && !when
			? NOTIFY_WITHOUT_TIME[locale]
			: (locale === 'ar' ? AR : EN)[input.kind]
	const base = template
		.replace('{r}', input.restaurantName)
		.replace('{when}', when ? `${when.date}, ${when.time}` : '')
		.replace('{n}', input.partySize ? String(input.partySize) : '')
		.replace('{wait}', wait)
		.replace('{amount}', formatMoney(input.amountMinor, input.currency, locale))
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
