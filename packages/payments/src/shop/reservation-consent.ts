/**
 * Provider-facing consent text for a card guarantee (Stripe setup mode,
 * `custom_text.submit.message`, at most 1200 characters). It states amounts,
 * triggers, the free-cancellation window and the time zone, never guest data.
 *
 * This is provider copy, not UI: a small local dictionary keyed by locale
 * (English and Arabic), no Lingui.
 */

export type GuaranteeConsentFacts = {
	currency: string
	capMinor: number
	noShowFeeMinor: number
	lateCancelFeeMinor: number
	freeCancelUntilMin: number
	timeZone: string
	startAtIso: string
}

export const STRIPE_CUSTOM_TEXT_MAX = 1200

type Dictionary = {
	intro: string
	noShow: (amount: string) => string
	lateCancel: (amount: string, window: string, deadline: string) => string
	cap: (amount: string) => string
	noCharge: string
	hours: (count: number) => string
	minutes: (count: number) => string
}

const DICTIONARY: Record<'en' | 'ar', Dictionary> = {
	en: {
		intro:
			'By saving your card you guarantee this reservation. Nothing is charged now.',
		noShow: (amount) =>
			`If you do not show up, the restaurant may charge up to ${amount}.`,
		lateCancel: (amount, window, deadline) =>
			`If you cancel less than ${window} before the reservation (after ${deadline}), the restaurant may charge up to ${amount}.`,
		cap: (amount) => `The most you can be charged in total is ${amount}.`,
		noCharge: 'Fees are charged only by the restaurant, never automatically.',
		hours: (count) => `${count} hour${count === 1 ? '' : 's'}`,
		minutes: (count) => `${count} minute${count === 1 ? '' : 's'}`,
	},
	ar: {
		intro: 'بحفظ بطاقتك تضمن هذا الحجز. لن يتم خصم أي مبلغ الآن.',
		noShow: (amount) =>
			`في حال عدم الحضور، قد يخصم المطعم ما يصل إلى ${amount}.`,
		lateCancel: (amount, window, deadline) =>
			`إذا ألغيت قبل أقل من ${window} من موعد الحجز (بعد ${deadline})، قد يخصم المطعم ما يصل إلى ${amount}.`,
		cap: (amount) => `أقصى مبلغ يمكن خصمه إجمالاً هو ${amount}.`,
		noCharge: 'يخصم المطعم الرسوم يدوياً فقط، ولا يتم الخصم تلقائياً.',
		hours: (count) => `${count} ساعة`,
		minutes: (count) => `${count} دقيقة`,
	},
}

function dictionaryFor(locale: string | null | undefined) {
	return (locale ?? 'en').toLowerCase().startsWith('ar')
		? { key: 'ar' as const, dictionary: DICTIONARY.ar }
		: { key: 'en' as const, dictionary: DICTIONARY.en }
}

function formatMoney(minor: number, currency: string, locale: string) {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
		}).format(minor / 100)
	} catch {
		return `${(minor / 100).toFixed(2)} ${currency}`
	}
}

function formatWindow(minutes: number, dictionary: Dictionary) {
	if (minutes > 0 && minutes % 60 === 0) return dictionary.hours(minutes / 60)
	return dictionary.minutes(minutes)
}

function formatDeadline(
	facts: GuaranteeConsentFacts,
	locale: string,
): string | null {
	const start = new Date(facts.startAtIso).getTime()
	if (!Number.isFinite(start)) return null
	const deadline = new Date(start - facts.freeCancelUntilMin * 60_000)
	try {
		return new Intl.DateTimeFormat(locale, {
			dateStyle: 'medium',
			timeStyle: 'short',
			timeZone: facts.timeZone,
		}).format(deadline)
	} catch {
		return null
	}
}

/** Consent text for the guarantee page, never longer than the Stripe limit. */
export function buildGuaranteeConsentText(
	facts: GuaranteeConsentFacts,
	locale: string | null | undefined,
): string {
	const { key, dictionary } = dictionaryFor(locale)
	const intlLocale = key === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US'
	const money = (minor: number) =>
		formatMoney(minor, facts.currency, intlLocale)
	const deadline = formatDeadline(facts, intlLocale)
	const zone = facts.timeZone
	const lines = [dictionary.intro]
	if (facts.noShowFeeMinor > 0) {
		lines.push(dictionary.noShow(money(facts.noShowFeeMinor)))
	}
	if (facts.lateCancelFeeMinor > 0) {
		lines.push(
			dictionary.lateCancel(
				money(facts.lateCancelFeeMinor),
				formatWindow(facts.freeCancelUntilMin, dictionary),
				deadline ? `${deadline} (${zone})` : zone,
			),
		)
	}
	lines.push(dictionary.cap(money(facts.capMinor)), dictionary.noCharge)
	return lines.join(' ').slice(0, STRIPE_CUSTOM_TEXT_MAX)
}
