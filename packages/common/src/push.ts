import { z } from 'zod'
import { buildLink } from './links.ts'

/**
 * Guest push notifications (#105): the pure rules shared by tenant-api, App
 * and the customer app. No I/O.
 *
 * A push payload passes through Apple, Google and Expo, outside any one
 * region, so it carries NO personal data: no name, phone number, email or
 * address. The builders below take only an order number or a few ids and
 * produce fixed, translated wording; `pushPayloadSchema` is strict, so a
 * payload with any other key (a name smuggled in as `data.customer`) is
 * refused. The app fetches the details after opening, with the guest's token.
 */

export const PUSH_ERROR_CODES = [
	'push_not_enabled',
	'push_token_invalid',
	'push_device_limit',
] as const
export type PushErrorCode = (typeof PUSH_ERROR_CODES)[number]

/** At most this many devices per customer; the oldest is dropped. */
export const MAX_PUSH_DEVICES = 10

export const PUSH_CATEGORIES = ['orders', 'bookings', 'rewards'] as const
export type PushCategory = (typeof PUSH_CATEGORIES)[number]

export const PUSH_LOCALES = ['en', 'ar', 'de', 'es', 'fr', 'zh'] as const
export type PushLocale = (typeof PUSH_LOCALES)[number]

export function pushLocale(value: string | null | undefined): PushLocale {
	const base = (value ?? 'en').toLowerCase().split('-')[0]!
	return (PUSH_LOCALES as readonly string[]).includes(base)
		? (base as PushLocale)
		: 'en'
}

/** Expo push tokens, or the raw tokens a direct provider would use later. */
export const expoPushTokenSchema = z
	.string()
	.trim()
	.regex(/^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]{8,200}\]$/, {
		error: 'push_token_invalid',
	})

export const registerDeviceSchema = z.strictObject({
	token: expoPushTokenSchema,
	platform: z.enum(['ios', 'android']),
	locale: z.string().trim().min(2).max(16).default('en'),
	appId: z.string().trim().min(1).max(100).optional(),
})
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>

export const pushPreferencesSchema = z.strictObject({
	orders: z.boolean().optional(),
	bookings: z.boolean().optional(),
	rewards: z.boolean().optional(),
	/** Offers and news: marketing, recorded as a `push` subscription. */
	marketing: z.boolean().optional(),
	/** Where the marketing opt-in came from. */
	source: z.enum(['profile', 'app_prompt']).optional(),
})

export const PUSH_TITLE_MAX = 65
export const PUSH_BODY_MAX = 178

/** The only keys a payload may have. `data.url` is a link from the registry (never a token). */
export const pushPayloadSchema = z.strictObject({
	title: z.string().min(1).max(PUSH_TITLE_MAX),
	body: z.string().min(1).max(PUSH_BODY_MAX),
	data: z.strictObject({
		kind: z.enum(['order_status', 'booking', 'reward', 'marketing']),
		/** Where a tap goes: an https address on the restaurant's own site. */
		url: z.string().max(600).nullable(),
		/** The send-log id the app reports back when the push is opened. */
		messageId: z.string().max(64).optional(),
	}),
	imageUrl: z.string().url().max(600).optional(),
})
export type PushPayload = z.infer<typeof pushPayloadSchema>

// ---------------------------------------------------------------------------
// Wording (every site language)
// ---------------------------------------------------------------------------

type Copy = {
	orderAccepted: [string, string]
	orderReadyPickup: [string, string]
	orderOutForDelivery: [string, string]
	orderCancelled: [string, string]
	bookingConfirmed: [string, string]
	bookingReminder: [string, string]
	waitlistReady: [string, string]
	rewardAvailable: [string, string]
	pointsEarned: [string, string]
}

/** `{n}` is the order number. Nothing else is ever substituted. */
const COPY: Record<PushLocale, Copy> = {
	en: {
		orderAccepted: [
			'Order {n} accepted',
			'The restaurant is working on your order.',
		],
		orderReadyPickup: ['Order {n} is ready', 'Your order is ready for pickup.'],
		orderOutForDelivery: [
			'Order {n} is on its way',
			'Your order is out for delivery.',
		],
		orderCancelled: [
			'Order {n} was cancelled',
			'Open the app to see what happened.',
		],
		bookingConfirmed: [
			'Booking confirmed',
			'Your table is booked. Open the app for the details.',
		],
		bookingReminder: [
			'Your booking is coming up',
			'Open the app to see your booking.',
		],
		waitlistReady: ['Your table is ready', 'Please check in with the host.'],
		rewardAvailable: [
			'A reward is waiting',
			'You have a reward you can use. Open the app to see it.',
		],
		pointsEarned: ['You earned points', 'Open the app to see your balance.'],
	},
	ar: {
		orderAccepted: ['تم قبول الطلب {n}', 'المطعم يعمل على طلبك.'],
		orderReadyPickup: ['الطلب {n} جاهز', 'طلبك جاهز للاستلام.'],
		orderOutForDelivery: ['الطلب {n} في الطريق', 'طلبك في طريقه إليك.'],
		orderCancelled: ['تم إلغاء الطلب {n}', 'افتح التطبيق لمعرفة ما حدث.'],
		bookingConfirmed: [
			'تم تأكيد الحجز',
			'تم حجز طاولتك. افتح التطبيق للتفاصيل.',
		],
		bookingReminder: ['حجزك يقترب', 'افتح التطبيق لعرض حجزك.'],
		waitlistReady: ['طاولتك جاهزة', 'يرجى مراجعة المضيف.'],
		rewardAvailable: [
			'مكافأة بانتظارك',
			'لديك مكافأة يمكنك استخدامها. افتح التطبيق لعرضها.',
		],
		pointsEarned: ['لقد كسبت نقاطًا', 'افتح التطبيق لعرض رصيدك.'],
	},
	de: {
		orderAccepted: [
			'Bestellung {n} angenommen',
			'Das Restaurant bearbeitet deine Bestellung.',
		],
		orderReadyPickup: [
			'Bestellung {n} ist fertig',
			'Deine Bestellung liegt zur Abholung bereit.',
		],
		orderOutForDelivery: [
			'Bestellung {n} ist unterwegs',
			'Deine Bestellung wird geliefert.',
		],
		orderCancelled: [
			'Bestellung {n} wurde storniert',
			'Öffne die App, um mehr zu erfahren.',
		],
		bookingConfirmed: [
			'Reservierung bestätigt',
			'Dein Tisch ist reserviert. Details findest du in der App.',
		],
		bookingReminder: [
			'Deine Reservierung steht bevor',
			'Öffne die App, um deine Reservierung zu sehen.',
		],
		waitlistReady: ['Dein Tisch ist bereit', 'Bitte melde dich beim Personal.'],
		rewardAvailable: [
			'Eine Belohnung wartet',
			'Du hast eine Belohnung, die du einlösen kannst. Öffne die App.',
		],
		pointsEarned: [
			'Du hast Punkte gesammelt',
			'Öffne die App, um dein Guthaben zu sehen.',
		],
	},
	es: {
		orderAccepted: [
			'Pedido {n} aceptado',
			'El restaurante está preparando tu pedido.',
		],
		orderReadyPickup: [
			'El pedido {n} está listo',
			'Tu pedido está listo para recoger.',
		],
		orderOutForDelivery: [
			'El pedido {n} va en camino',
			'Tu pedido está en reparto.',
		],
		orderCancelled: [
			'El pedido {n} fue cancelado',
			'Abre la app para ver qué pasó.',
		],
		bookingConfirmed: [
			'Reserva confirmada',
			'Tu mesa está reservada. Abre la app para ver los detalles.',
		],
		bookingReminder: [
			'Tu reserva se acerca',
			'Abre la app para ver tu reserva.',
		],
		waitlistReady: ['Tu mesa está lista', 'Por favor, avisa al anfitrión.'],
		rewardAvailable: [
			'Te espera una recompensa',
			'Tienes una recompensa para usar. Abre la app.',
		],
		pointsEarned: ['Ganaste puntos', 'Abre la app para ver tu saldo.'],
	},
	fr: {
		orderAccepted: [
			'Commande {n} acceptée',
			'Le restaurant prépare votre commande.',
		],
		orderReadyPickup: [
			'La commande {n} est prête',
			'Votre commande est prête à être retirée.',
		],
		orderOutForDelivery: [
			'La commande {n} est en route',
			'Votre commande est en cours de livraison.',
		],
		orderCancelled: [
			'La commande {n} a été annulée',
			"Ouvrez l'application pour en savoir plus.",
		],
		bookingConfirmed: [
			'Réservation confirmée',
			"Votre table est réservée. Ouvrez l'application pour les détails.",
		],
		bookingReminder: [
			'Votre réservation approche',
			"Ouvrez l'application pour voir votre réservation.",
		],
		waitlistReady: [
			'Votre table est prête',
			"Merci de vous présenter à l'accueil.",
		],
		rewardAvailable: [
			'Une récompense vous attend',
			"Vous avez une récompense à utiliser. Ouvrez l'application.",
		],
		pointsEarned: [
			'Vous avez gagné des points',
			"Ouvrez l'application pour voir votre solde.",
		],
	},
	zh: {
		orderAccepted: ['订单 {n} 已接受', '餐厅正在处理您的订单。'],
		orderReadyPickup: ['订单 {n} 已备好', '您的订单可以取餐了。'],
		orderOutForDelivery: ['订单 {n} 正在配送', '您的订单正在派送中。'],
		orderCancelled: ['订单 {n} 已取消', '打开应用查看详情。'],
		bookingConfirmed: ['预订已确认', '您的餐桌已预订。打开应用查看详情。'],
		bookingReminder: ['您的预订即将到来', '打开应用查看您的预订。'],
		waitlistReady: ['您的餐桌已准备好', '请向接待员报到。'],
		rewardAvailable: [
			'有一份奖励在等您',
			'您有一份可使用的奖励。打开应用查看。',
		],
		pointsEarned: ['您获得了积分', '打开应用查看您的余额。'],
	},
}

const fill = (template: string, number: string) =>
	template.replace('{n}', number)

/** A short order number: letters, digits and a few separators only. */
const ORDER_NUMBER = /^[A-Za-z0-9#_-]{1,24}$/

// ---------------------------------------------------------------------------
// Which statuses reach the guest
// ---------------------------------------------------------------------------

/** Statuses that matter to the guest; `payment_review`, `expired`, `preparing`... stay quiet. */
export const ORDER_PUSH_STATUSES = ['accepted', 'ready', 'cancelled'] as const
export type OrderPushStatus = (typeof ORDER_PUSH_STATUSES)[number]

export function orderStatusMatters(status: string): status is OrderPushStatus {
	return (ORDER_PUSH_STATUSES as readonly string[]).includes(status)
}

/** `<order id>:<status>`: one push per order and status (idempotent). */
export function orderPushRef(orderId: string, status: string): string {
	return `${orderId}:${status}`
}

export type PushBuildContext = {
	locale: string
	/** The restaurant's own site origin, for the tap's link. */
	siteOrigin: string | null | undefined
}

function link(
	type: 'order' | 'reserve' | 'loyalty' | 'menu_home',
	params: Record<string, string>,
	context: PushBuildContext,
): string | null {
	// Never a capability token: the app opens the screen with the guest's own sign-in.
	return buildLink(type, params, { origin: context.siteOrigin })
}

function done(payload: PushPayload): PushPayload {
	return pushPayloadSchema.parse(payload)
}

export function buildOrderStatusPush(
	input: {
		orderId: string
		number: string
		status: string
		fulfillment: string
	},
	context: PushBuildContext,
): PushPayload | null {
	if (!orderStatusMatters(input.status)) return null
	if (!ORDER_NUMBER.test(input.number)) return null
	const copy = COPY[pushLocale(context.locale)]
	const [title, body] =
		input.status === 'accepted'
			? copy.orderAccepted
			: input.status === 'ready'
				? input.fulfillment === 'delivery'
					? copy.orderOutForDelivery
					: copy.orderReadyPickup
				: copy.orderCancelled
	return done({
		title: fill(title, input.number),
		body,
		data: {
			kind: 'order_status',
			url: link('order', { order: input.orderId }, context),
		},
	})
}

export const BOOKING_PUSH_KINDS = [
	'confirmation',
	'reminder',
	'waitlist_ready',
] as const
export type BookingPushKind = (typeof BOOKING_PUSH_KINDS)[number]

export function buildBookingPush(
	input: { kind: BookingPushKind },
	context: PushBuildContext,
): PushPayload {
	const copy = COPY[pushLocale(context.locale)]
	const [title, body] =
		input.kind === 'confirmation'
			? copy.bookingConfirmed
			: input.kind === 'reminder'
				? copy.bookingReminder
				: copy.waitlistReady
	return done({
		title,
		body,
		data: { kind: 'booking', url: link('reserve', {}, context) },
	})
}

export const REWARD_PUSH_KINDS = ['reward_available', 'points_earned'] as const
export type RewardPushKind = (typeof REWARD_PUSH_KINDS)[number]

export function buildRewardPush(
	input: { kind: RewardPushKind },
	context: PushBuildContext,
): PushPayload {
	const copy = COPY[pushLocale(context.locale)]
	const [title, body] =
		input.kind === 'reward_available' ? copy.rewardAvailable : copy.pointsEarned
	return done({
		title,
		body,
		data: { kind: 'reward', url: link('loyalty', {}, context) },
	})
}

/** What an operator writes for a push broadcast or an automation step. */
export const marketingPushContentSchema = z.strictObject({
	title: z
		.string()
		.trim()
		.min(1)
		.max(PUSH_TITLE_MAX)
		.refine((value) => !value.includes('{{'), {
			error: 'merge_tags_not_allowed',
		}),
	body: z
		.string()
		.trim()
		.min(1)
		.max(PUSH_BODY_MAX)
		.refine((value) => !value.includes('{{'), {
			error: 'merge_tags_not_allowed',
		}),
	imageUrl: z.string().trim().url().max(600).startsWith('https://').optional(),
	/** A page or dish on the restaurant's site, as a path: `/menu`, `/menu?item=<id>`. */
	link: z
		.string()
		.trim()
		.max(300)
		.regex(/^\/(?!\/)[^\s#]*$/, { error: 'link_must_be_a_site_path' })
		.optional(),
})
export type MarketingPushContent = z.infer<typeof marketingPushContentSchema>

/**
 * A marketing push. Operators write the words once for everyone: merge tags
 * (a name, a code) are refused, because a push passes through outside
 * providers and must hold no personal data.
 */
export function buildMarketingPush(
	content: MarketingPushContent,
	context: PushBuildContext,
): PushPayload | null {
	const parsed = marketingPushContentSchema.safeParse(content)
	if (!parsed.success) return null
	let url: string | null = null
	if (context.siteOrigin) {
		try {
			const base = new URL(context.siteOrigin)
			// A path on the restaurant's own site, never another host.
			url = new URL(parsed.data.link ?? '/menu', base.origin).toString()
			if (new URL(url).origin !== base.origin) url = null
		} catch {
			url = null
		}
	}
	return done({
		title: parsed.data.title,
		body: parsed.data.body,
		data: { kind: 'marketing', url },
		...(parsed.data.imageUrl ? { imageUrl: parsed.data.imageUrl } : {}),
	})
}

/**
 * Test and review helper: the JSON of a payload must hold none of the values
 * given (a name, a phone, an address, an email). Strings are compared
 * case-insensitively after trimming; values shorter than 3 characters are
 * ignored (they would match anything).
 */
export function payloadHoldsPersonalData(
	payload: unknown,
	personalValues: readonly string[],
): string[] {
	const text = JSON.stringify(payload).toLowerCase()
	return personalValues
		.map((value) => value.trim())
		.filter((value) => value.length >= 3)
		.filter((value) => text.includes(value.toLowerCase()))
}
