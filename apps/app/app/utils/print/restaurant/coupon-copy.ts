import { localeCopy } from '@repo/common/print-shop'

/**
 * The words a coupon print starts with, written from the discount itself so
 * the owner does not retype the offer, and so a customer reads every term
 * that could turn them away at checkout: "10% off", then "Valid until …
 * First order only. One per customer. Pickup orders only. Minimum order …".
 * The owner can replace any of it in the editor.
 *
 * The printed QR opens the online menu, and a code discount is never a till
 * rule, so the call to action never sends anyone to the counter.
 */

type Key =
	| 'percentOff'
	| 'amountOff'
	| 'freeDelivery'
	| 'from'
	| 'until'
	| 'fromUntil'
	| 'minimum'
	| 'newCustomer'
	| 'signedIn'
	| 'member'
	| 'onePerCustomer'
	| 'pickupOnly'
	| 'deliveryOnly'
	| 'dineInOnly'
	| 'atLocation'
	| 'onlineOnly'
	| 'ctaCode'
	| 'ctaAutomatic'

const COPY: Record<string, Record<Key, string>> = {
	en: {
		percentOff: '{value} off',
		amountOff: '{value} off',
		freeDelivery: 'Free delivery',
		from: 'Valid from {start}.',
		until: 'Valid until {end}.',
		fromUntil: 'Valid {start} to {end}.',
		minimum: 'Minimum order {value}.',
		newCustomer: 'First order only.',
		signedIn: 'Sign in to use it.',
		member: 'For rewards members.',
		onePerCustomer: 'One per customer.',
		pickupOnly: 'Pickup orders only.',
		deliveryOnly: 'Delivery orders only.',
		dineInOnly: 'Dine-in orders only.',
		atLocation: 'At {location} only.',
		onlineOnly: 'Online orders only.',
		ctaCode: 'Scan to order. Your code is added for you.',
		ctaAutomatic: 'Scan to order. The offer applies by itself.',
	},
	ar: {
		percentOff: 'خصم {value}',
		amountOff: 'خصم {value}',
		freeDelivery: 'توصيل مجاني',
		from: 'صالح من {start}.',
		until: 'صالح حتى {end}.',
		fromUntil: 'صالح من {start} حتى {end}.',
		minimum: 'الحد الأدنى للطلب {value}.',
		newCustomer: 'للطلب الأول فقط.',
		signedIn: 'سجّل الدخول لاستخدامه.',
		member: 'لأعضاء برنامج المكافآت.',
		onePerCustomer: 'مرة واحدة لكل عميل.',
		pickupOnly: 'لطلبات الاستلام فقط.',
		deliveryOnly: 'لطلبات التوصيل فقط.',
		dineInOnly: 'للطلبات داخل المطعم فقط.',
		atLocation: 'في {location} فقط.',
		onlineOnly: 'للطلبات عبر الإنترنت فقط.',
		ctaCode: 'امسح للطلب، وسيُضاف الرمز تلقائيًا.',
		ctaAutomatic: 'امسح للطلب، ويُطبَّق العرض تلقائيًا.',
	},
	es: {
		percentOff: '{value} de descuento',
		amountOff: '{value} de descuento',
		freeDelivery: 'Envío gratis',
		from: 'Válido desde el {start}.',
		until: 'Válido hasta el {end}.',
		fromUntil: 'Válido del {start} al {end}.',
		minimum: 'Pedido mínimo {value}.',
		newCustomer: 'Solo en tu primer pedido.',
		signedIn: 'Inicia sesión para usarlo.',
		member: 'Para miembros del programa de recompensas.',
		onePerCustomer: 'Uno por cliente.',
		pickupOnly: 'Solo pedidos para recoger.',
		deliveryOnly: 'Solo pedidos a domicilio.',
		dineInOnly: 'Solo para comer en el local.',
		atLocation: 'Solo en {location}.',
		onlineOnly: 'Solo pedidos en línea.',
		ctaCode: 'Escanea para pedir. Tu código se añade solo.',
		ctaAutomatic: 'Escanea para pedir. La oferta se aplica sola.',
	},
	fr: {
		percentOff: '{value} de réduction',
		amountOff: '{value} de réduction',
		freeDelivery: 'Livraison gratuite',
		from: 'Valable à partir du {start}.',
		until: 'Valable jusqu’au {end}.',
		fromUntil: 'Valable du {start} au {end}.',
		minimum: 'Commande minimale {value}.',
		newCustomer: 'Première commande uniquement.',
		signedIn: 'Connectez-vous pour l’utiliser.',
		member: 'Pour les membres du programme de fidélité.',
		onePerCustomer: 'Un par client.',
		pickupOnly: 'Commandes à emporter uniquement.',
		deliveryOnly: 'Commandes en livraison uniquement.',
		dineInOnly: 'Sur place uniquement.',
		atLocation: 'À {location} uniquement.',
		onlineOnly: 'Commandes en ligne uniquement.',
		ctaCode: 'Scannez pour commander. Votre code est ajouté pour vous.',
		ctaAutomatic: 'Scannez pour commander. L’offre s’applique toute seule.',
	},
	de: {
		percentOff: '{value} Rabatt',
		amountOff: '{value} Rabatt',
		freeDelivery: 'Kostenlose Lieferung',
		from: 'Gültig ab {start}.',
		until: 'Gültig bis {end}.',
		fromUntil: 'Gültig vom {start} bis {end}.',
		minimum: 'Mindestbestellwert {value}.',
		newCustomer: 'Nur bei der ersten Bestellung.',
		signedIn: 'Zum Einlösen anmelden.',
		member: 'Für Mitglieder des Prämienprogramms.',
		onePerCustomer: 'Einmal pro Kunde.',
		pickupOnly: 'Nur für Abholung.',
		deliveryOnly: 'Nur für Lieferung.',
		dineInOnly: 'Nur vor Ort.',
		atLocation: 'Nur in {location}.',
		onlineOnly: 'Nur für Online-Bestellungen.',
		ctaCode: 'Scannen und bestellen. Der Code ist schon eingetragen.',
		ctaAutomatic: 'Scannen und bestellen. Das Angebot gilt automatisch.',
	},
	zh: {
		percentOff: '优惠 {value}',
		amountOff: '立减 {value}',
		freeDelivery: '免配送费',
		from: '自 {start} 起有效。',
		until: '有效期至 {end}。',
		fromUntil: '有效期 {start} 至 {end}。',
		minimum: '最低消费 {value}。',
		newCustomer: '仅限首单。',
		signedIn: '登录后使用。',
		member: '仅限会员。',
		onePerCustomer: '每位顾客限用一次。',
		pickupOnly: '仅限自取订单。',
		deliveryOnly: '仅限外送订单。',
		dineInOnly: '仅限堂食。',
		atLocation: '仅限 {location}。',
		onlineOnly: '仅限线上订单。',
		ctaCode: '扫码点餐，优惠码自动填写。',
		ctaAutomatic: '扫码点餐，优惠自动生效。',
	},
}

const fill = (template: string, values: Record<string, string>) =>
	template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')

export type CouponOffer = {
	name: string
	application: string
	valueType: string
	percentBp: number | null
	amountMinor: number | null
	/** Tiers carry their own values, so there is no single figure to print. */
	hasTiers: boolean
	minSubtotalMinor: number | null
	/** `YYYY-MM-DDTHH:MM`, local to each location. */
	startsAt: string | null
	/** `YYYY-MM-DDTHH:MM`, local, exclusive. */
	endsAt: string | null
	eligibility: string
	perCustomerLimit: { count: number; period: string } | null
	fulfillments: readonly string[]
	channels: readonly string[]
	currency: string
	/** The one place it works, when the business has several; else null. */
	onlyLocationName: string | null
}

const HOUR = 60 * 60 * 1000
const localStamp = (ms: number) => new Date(ms).toISOString().slice(0, 16)

/**
 * Whether a printed QR to the online menu can use this offer now: online,
 * not a till-only manual discount, and not ended. Local times are compared
 * with the widest time-zone margin (UTC−12 to UTC+14), so an offer is only
 * called ended once it has ended everywhere.
 */
export function isPrintableOffer(
	offer: Pick<CouponOffer, 'application' | 'channels' | 'endsAt'>,
	now: number = Date.now(),
): boolean {
	if (offer.application === 'manual') return false
	if (!offer.channels.includes('web')) return false
	if (offer.endsAt && offer.endsAt <= localStamp(now - 12 * HOUR)) return false
	return true
}

function money(minor: number, currency: string, locale: string) {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
			minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
		}).format(minor / 100)
	} catch {
		return `${(minor / 100).toFixed(2)} ${currency}`
	}
}

function parseLocal(stamp: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(stamp)
	if (!match) return null
	const [, y, mo, d] = match.map(Number) as number[]
	return new Date(Date.UTC(y!, mo! - 1, d!))
}

/** The last day the offer works: the end is exclusive, so a midnight end is the day before. */
function lastDay(endsAt: string): Date | null {
	const day = parseLocal(endsAt)
	if (day && endsAt.endsWith('T00:00')) day.setUTCDate(day.getUTCDate() - 1)
	return day
}

function headlineFor(offer: CouponOffer, locale: string) {
	const t = (key: Key) => localeCopy(COPY, locale, key)
	if (offer.valueType === 'free_delivery') return t('freeDelivery')
	if (offer.hasTiers) return offer.name
	if (offer.valueType === 'percent' && offer.percentBp) {
		return fill(t('percentOff'), {
			value: new Intl.NumberFormat(locale, {
				style: 'percent',
				maximumFractionDigits: 2,
			}).format(offer.percentBp / 10_000),
		})
	}
	if (offer.valueType === 'fixed' && offer.amountMinor) {
		return fill(t('amountOff'), {
			value: money(offer.amountMinor, offer.currency, locale),
		})
	}
	return offer.name
}

function termsFor(offer: CouponOffer, locale: string, now: number) {
	const t = (key: Key) => localeCopy(COPY, locale, key)
	const date = (day: Date) =>
		new Intl.DateTimeFormat(locale, {
			dateStyle: 'long',
			timeZone: 'UTC',
		}).format(day)
	const terms: string[] = []

	// A start already passed everywhere is noise on the card.
	const start =
		offer.startsAt && offer.startsAt > localStamp(now - 12 * HOUR)
			? parseLocal(offer.startsAt)
			: null
	const end = offer.endsAt ? lastDay(offer.endsAt) : null
	if (start && end) {
		terms.push(fill(t('fromUntil'), { start: date(start), end: date(end) }))
	} else if (start) {
		terms.push(fill(t('from'), { start: date(start) }))
	} else if (end) {
		terms.push(fill(t('until'), { end: date(end) }))
	}

	if (offer.eligibility === 'new_customer') terms.push(t('newCustomer'))
	else if (offer.eligibility === 'signed_in') terms.push(t('signedIn'))
	else if (offer.eligibility === 'loyalty_member') terms.push(t('member'))

	if (
		offer.perCustomerLimit?.count === 1 &&
		offer.perCustomerLimit.period === 'lifetime' &&
		offer.eligibility !== 'new_customer'
	) {
		terms.push(t('onePerCustomer'))
	}

	const ways = new Set(offer.fulfillments)
	if (ways.size === 1 && ways.has('pickup')) terms.push(t('pickupOnly'))
	else if (ways.size === 1 && ways.has('delivery'))
		terms.push(t('deliveryOnly'))
	else if (ways.size === 1 && ways.has('dine_in')) terms.push(t('dineInOnly'))

	if (offer.onlyLocationName) {
		terms.push(fill(t('atLocation'), { location: offer.onlyLocationName }))
	}
	// An automatic offer that the till also applies works in person; a code
	// never does, so say so rather than have someone ask at the counter.
	if (offer.application === 'code' || !offer.channels.includes('pos')) {
		terms.push(t('onlineOnly'))
	}

	if (offer.minSubtotalMinor) {
		terms.push(
			fill(t('minimum'), {
				value: money(offer.minSubtotalMinor, offer.currency, locale),
			}),
		)
	}
	return terms.join(' ')
}

export function couponCopy(
	offer: CouponOffer,
	locale: string,
	now: number = Date.now(),
): { headline: string; body: string; callToAction: string } {
	return {
		headline: headlineFor(offer, locale).slice(0, 80),
		body: termsFor(offer, locale, now).slice(0, 280),
		callToAction: localeCopy(
			COPY,
			locale,
			offer.application === 'code' ? 'ctaCode' : 'ctaAutomatic',
		).slice(0, 60),
	}
}
