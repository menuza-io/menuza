import { isValidTimeZone } from '@repo/zoned-time'
import { z } from 'zod'
import { type OrderAlertKind } from './operator-alerts.ts'

/**
 * The words of an order or tablet alert for push, email and text (#106, #131,
 * #241, #300, #190). English and Arabic; the in-app bell translates its own copy
 * with Lingui from the same facts. Built only from a kind, a location name, an
 * order number, a count, a time and a total: nothing here can say who ordered
 * or what they ordered. A test order gets "TEST" in front.
 */

export type AlertLocale = 'en' | 'ar'

export function alertLocale(value: string | null | undefined): AlertLocale {
	return (value ?? 'en').toLowerCase().startsWith('ar') ? 'ar' : 'en'
}

export type AlertSubject =
	| {
			kind: 'orders_new'
			orderNumber: string
			fulfillment: 'pickup' | 'delivery'
			scheduledForMs: number | null
			totalCents: number
			currency: string
			dishCount: number
			large: boolean
	  }
	| {
			kind: 'orders_large'
			orderNumber: string
			fulfillment: 'pickup' | 'delivery'
			scheduledForMs: number | null
			totalCents: number
			currency: string
			dishCount: number
			/** The reminder before a scheduled large order starts. */
			soon: boolean
	  }
	| { kind: 'orders_waiting'; orderNumbers: readonly string[] }
	| {
			kind: 'orders_due_soon'
			orderNumbers: readonly string[]
			dueAtMs: number
	  }
	| { kind: 'orders_payment_review'; orderNumber: string }
	| { kind: 'ordering_paused_long'; mode: 'paused' | 'busy'; hours: number }
	| {
			kind: 'station_offline'
			label: string
			state: 'offline' | 'back_online'
			minutes: number
			allKitchenOffline: boolean
			waitingOrderNumber: string | null
	  }

const orderNo = z
	.string()
	.min(1)
	.max(40)
	.regex(/^[A-Za-z0-9_.#-]+$/)
const money = z.number().int().nonnegative().max(1_000_000_000)

/**
 * What a stored alert says, validated when it is read back (the bell, a held
 * push released later). Strict, so a payload with any other field is no alert.
 */
export const alertSubjectSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('orders_new'),
		orderNumber: orderNo,
		fulfillment: z.enum(['pickup', 'delivery']),
		scheduledForMs: z.number().int().positive().nullable(),
		totalCents: money,
		currency: z.string().regex(/^[A-Z]{3}$/),
		dishCount: z.number().int().nonnegative().max(10_000),
		large: z.boolean(),
	}),
	z.strictObject({
		kind: z.literal('orders_large'),
		orderNumber: orderNo,
		fulfillment: z.enum(['pickup', 'delivery']),
		scheduledForMs: z.number().int().positive().nullable(),
		totalCents: money,
		currency: z.string().regex(/^[A-Z]{3}$/),
		dishCount: z.number().int().nonnegative().max(10_000),
		soon: z.boolean(),
	}),
	z.strictObject({
		kind: z.literal('orders_waiting'),
		orderNumbers: z.array(orderNo).min(1).max(20),
	}),
	z.strictObject({
		kind: z.literal('orders_due_soon'),
		orderNumbers: z.array(orderNo).min(1).max(20),
		dueAtMs: z.number().int().positive(),
	}),
	z.strictObject({
		kind: z.literal('orders_payment_review'),
		orderNumber: orderNo,
	}),
	z.strictObject({
		kind: z.literal('ordering_paused_long'),
		mode: z.enum(['paused', 'busy']),
		hours: z.number().int().min(1).max(10_000),
	}),
	z.strictObject({
		kind: z.literal('station_offline'),
		label: z.string().min(1).max(60),
		state: z.enum(['offline', 'back_online']),
		minutes: z.number().int().nonnegative().max(100_000),
		allKitchenOffline: z.boolean(),
		waitingOrderNumber: orderNo.nullable(),
	}),
])

export function parseAlertSubject(value: unknown): AlertSubject | null {
	const parsed = alertSubjectSchema.safeParse(value)
	return parsed.success ? (parsed.data as AlertSubject) : null
}

export type AlertCopy = {
	/** Push title, notification subject, SMS lead. */
	title: string
	/** Push body. */
	body: string
	eyebrow: string
	subject: string
	headline: string
	detail: string
	actionLabel: string
}

type Context = {
	locale: AlertLocale
	locationName?: string | null
	/** The location's IANA zone, for "6:45 PM". */
	timeZone?: string | null
	test?: boolean
}

function numberLocale(locale: AlertLocale) {
	return locale === 'ar' ? 'ar-u-nu-latn' : 'en'
}

export function formatAlertMoney(
	cents: number,
	currency: string,
	locale: AlertLocale,
): string {
	try {
		const format = new Intl.NumberFormat(numberLocale(locale), {
			style: 'currency',
			currency,
		})
		const digits = format.resolvedOptions().maximumFractionDigits ?? 2
		return format.format(cents / 10 ** digits)
	} catch {
		return `${(cents / 100).toFixed(2)} ${currency}`
	}
}

export function formatAlertTime(
	ms: number,
	timeZone: string | null | undefined,
	locale: AlertLocale,
): string {
	return new Intl.DateTimeFormat(numberLocale(locale), {
		hour: 'numeric',
		minute: '2-digit',
		...(timeZone && isValidTimeZone(timeZone) ? { timeZone } : {}),
	}).format(new Date(ms))
}

type Words = {
	pickup: string
	delivery: string
	asap: string
	at: string
	dishes: (n: number) => string
	orders: (n: number) => string
	minutes: (n: number) => string
	hours: (n: number) => string
	large: string
	test: string
	openOrders: string
	seeTablets: string
	settingsNote: string
}

const EN: Words = {
	pickup: 'Pickup',
	delivery: 'Delivery',
	asap: 'as soon as possible',
	at: 'at',
	dishes: (n) => (n === 1 ? '1 dish' : `${n} dishes`),
	orders: (n) => (n === 1 ? '1 order' : `${n} orders`),
	minutes: (n) => (n === 1 ? '1 minute' : `${n} minutes`),
	hours: (n) => (n === 1 ? '1 hour' : `${n} hours`),
	large: 'Large order',
	test: 'TEST',
	openOrders: 'Open orders',
	seeTablets: 'See tablets',
	settingsNote: 'You can change these alerts in your notification settings.',
}

const AR: Words = {
	pickup: 'استلام',
	delivery: 'توصيل',
	asap: 'في أقرب وقت',
	at: 'في',
	dishes: (n) => (n === 1 ? 'طبق واحد' : `${n} أطباق`),
	orders: (n) => (n === 1 ? 'طلب واحد' : `${n} طلبات`),
	minutes: (n) => (n === 1 ? 'دقيقة واحدة' : `${n} دقائق`),
	hours: (n) => (n === 1 ? 'ساعة واحدة' : `${n} ساعات`),
	large: 'طلب كبير',
	test: 'تجريبي',
	openOrders: 'افتح الطلبات',
	seeTablets: 'عرض الأجهزة',
	settingsNote: 'يمكنك تغيير هذه التنبيهات من إعدادات الإشعارات.',
}

const words = (locale: AlertLocale) => (locale === 'ar' ? AR : EN)

function join(parts: ReadonlyArray<string | null | undefined | false>) {
	return parts.filter(Boolean).join(' · ')
}

function numbers(list: readonly string[]) {
	const shown = list.slice(0, 3).join(', ')
	return list.length > 3 ? `${shown} +${list.length - 3}` : shown
}

/** The settings note that closes every alert email. */
export function alertSettingsNote(locale: AlertLocale): string {
	return words(locale).settingsNote
}

/** Where an alert leads, relative to `/<orgSlug>`. */
export function alertPath(kind: OrderAlertKind): string {
	return kind === 'station_offline' ? '/settings/terminals' : '/orders'
}

export function alertCopy(subject: AlertSubject, context: Context): AlertCopy {
	const locale = context.locale
	const w = words(locale)
	const place = context.locationName?.trim() || null
	const testTag = context.test ? `${w.test} · ` : ''
	const ar = locale === 'ar'

	switch (subject.kind) {
		case 'orders_new': {
			const type = subject.fulfillment === 'delivery' ? w.delivery : w.pickup
			const when =
				subject.scheduledForMs === null
					? null
					: formatAlertTime(subject.scheduledForMs, context.timeZone, locale)
			const total = formatAlertMoney(
				subject.totalCents,
				subject.currency,
				locale,
			)
			const title = `${testTag}${ar ? 'طلب جديد' : 'New order'} ${subject.orderNumber}`
			const body = join([
				when ? `${type} ${when}` : type,
				total,
				subject.large && w.large,
				place,
			])
			return {
				title,
				body,
				eyebrow: ar ? 'الطلبات' : 'Orders',
				subject: place ? `${title} ${w.at} ${place}` : title,
				headline: title,
				detail: join([
					when ? `${type} ${when}` : `${type}, ${w.asap}`,
					total,
					subject.large && w.large,
					place,
				]),
				actionLabel: w.openOrders,
			}
		}
		case 'orders_large': {
			const type = subject.fulfillment === 'delivery' ? w.delivery : w.pickup
			const when =
				subject.scheduledForMs === null
					? null
					: formatAlertTime(subject.scheduledForMs, context.timeZone, locale)
			const total = formatAlertMoney(
				subject.totalCents,
				subject.currency,
				locale,
			)
			const lead = subject.soon
				? ar
					? `${w.large} ${subject.orderNumber} يبدأ قريبا`
					: `${w.large} ${subject.orderNumber} starts soon`
				: `${w.large} ${subject.orderNumber}`
			const title = `${testTag}${lead}`
			const body = join([
				w.dishes(subject.dishCount),
				total,
				when ? `${type} ${when}` : type,
				place,
			])
			return {
				title,
				body,
				eyebrow: w.large,
				subject: place ? `${title} ${w.at} ${place}` : title,
				headline: title,
				detail: body,
				actionLabel: w.openOrders,
			}
		}
		case 'orders_waiting': {
			const count = subject.orderNumbers.length
			const title =
				count === 1
					? ar
						? `الطلب ${subject.orderNumbers[0]} بانتظارك`
						: `Order ${subject.orderNumbers[0]} is waiting`
					: ar
						? `${w.orders(count)} بانتظارك`
						: `${w.orders(count)} are waiting`
			const body = join([
				ar ? 'لم يُقبل بعد' : 'Not accepted yet',
				count > 1 && numbers(subject.orderNumbers),
				place,
			])
			return {
				title: `${testTag}${title}`,
				body,
				eyebrow: ar ? 'الطلبات' : 'Orders',
				subject: place ? `${title} ${w.at} ${place}` : title,
				headline: title,
				detail: ar
					? `${count === 1 ? 'طلب لم يُقبل بعد' : `${w.orders(count)} لم تُقبل بعد`}${place ? ` ${w.at} ${place}` : ''}. افتح الطلبات لقبوله.`
					: `${count === 1 ? 'An order has' : `${w.orders(count)} have`} not been accepted yet${place ? ` ${w.at} ${place}` : ''}. Open Orders to accept ${count === 1 ? 'it' : 'them'}.`,
				actionLabel: w.openOrders,
			}
		}
		case 'orders_due_soon': {
			const count = subject.orderNumbers.length
			const due = formatAlertTime(subject.dueAtMs, context.timeZone, locale)
			const title =
				count === 1
					? ar
						? `الطلب المجدول ${subject.orderNumbers[0]} يقترب موعده`
						: `Scheduled order ${subject.orderNumbers[0]} is due soon`
					: ar
						? `${w.orders(count)} مجدولة يقترب موعدها`
						: `${w.orders(count)} are due soon`
			const body = join([
				ar ? `الموعد ${due}` : `Due ${due}`,
				ar ? 'لم يبدأ بعد' : 'Not started yet',
				place,
			])
			return {
				title: `${testTag}${title}`,
				body,
				eyebrow: ar ? 'الطلبات' : 'Orders',
				subject: place ? `${title} ${w.at} ${place}` : title,
				headline: title,
				detail: body,
				actionLabel: w.openOrders,
			}
		}
		case 'orders_payment_review': {
			const title = ar ? 'دفعة تحتاج إلى مراجعة' : 'Payment needs review'
			const body = join([
				ar
					? `الطلب ${subject.orderNumber} يحتاج إلى مراجعة الدفع`
					: `Order ${subject.orderNumber} needs its payment reviewed`,
				place,
			])
			return {
				title: `${testTag}${title}`,
				body,
				eyebrow: ar ? 'الدفع' : 'Payments',
				subject: place ? `${title} ${w.at} ${place}` : title,
				headline: title,
				detail: body,
				actionLabel: w.openOrders,
			}
		}
		case 'ordering_paused_long': {
			const length = w.hours(subject.hours)
			const title =
				subject.mode === 'paused'
					? ar
						? 'الطلب عبر الإنترنت ما زال متوقفا'
						: 'Online ordering is still paused'
					: ar
						? 'وضع الازدحام ما زال مفعلا'
						: 'Busy mode is still on'
			const body = join([
				subject.mode === 'paused'
					? ar
						? `متوقف منذ أكثر من ${length}`
						: `Paused for more than ${length}`
					: ar
						? `مفعل منذ أكثر من ${length}`
						: `On for more than ${length}`,
				place,
			])
			return {
				title,
				body,
				eyebrow: ar ? 'الطلبات' : 'Orders',
				subject: place ? `${title} ${w.at} ${place}` : title,
				headline: title,
				detail: body,
				actionLabel: w.openOrders,
			}
		}
		case 'station_offline': {
			const label = subject.label
			if (subject.state === 'back_online') {
				const title = ar
					? `${label} عاد إلى الاتصال`
					: `${label} is back online`
				const body = join([
					ar
						? `كان غير متصل ${w.minutes(subject.minutes)}`
						: `It was offline for ${w.minutes(subject.minutes)}`,
					place,
				])
				return {
					title,
					body,
					eyebrow: ar ? 'الأجهزة' : 'Tablets',
					subject: title,
					headline: title,
					detail: body,
					actionLabel: w.seeTablets,
				}
			}
			if (subject.allKitchenOffline) {
				const title = ar
					? 'كل أجهزة المطبخ غير متصلة'
					: 'Every kitchen tablet is offline'
				const body = join([
					ar
						? `طلب جديد${subject.waitingOrderNumber ? ` ${subject.waitingOrderNumber}` : ''} بانتظار المطبخ`
						: `An order${subject.waitingOrderNumber ? ` (${subject.waitingOrderNumber})` : ''} is waiting and no kitchen screen can see it`,
					place,
				])
				return {
					title,
					body,
					eyebrow: ar ? 'عاجل' : 'Urgent',
					subject: place ? `${title} ${w.at} ${place}` : title,
					headline: title,
					detail: body,
					actionLabel: w.openOrders,
				}
			}
			const title = ar
				? `${label} غير متصل`
				: `${label} has been offline for ${w.minutes(subject.minutes)}`
			const body = join([
				ar
					? `لم يتصل منذ ${w.minutes(subject.minutes)}`
					: 'Check its power and its internet',
				place,
			])
			return {
				title,
				body,
				eyebrow: ar ? 'الأجهزة' : 'Tablets',
				subject: place ? `${title} ${w.at} ${place}` : title,
				headline: title,
				detail: body,
				actionLabel: w.seeTablets,
			}
		}
	}
}

/** The text message: the lead, the link and the opt-out phrase carriers expect. */
export function alertSmsText(copy: AlertCopy, url: string): string {
	return `${copy.title}. ${copy.body}\n${url}\nReply STOP to opt out.`
}
