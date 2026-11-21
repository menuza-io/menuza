import { describe, expect, it } from 'vitest'
import {
	BOOKING_PUSH_KINDS,
	buildBookingPush,
	buildMarketingPush,
	buildOrderStatusPush,
	buildRewardPush,
	ORDER_PUSH_STATUSES,
	orderPushRef,
	orderStatusMatters,
	payloadHoldsPersonalData,
	PUSH_LOCALES,
	pushPayloadSchema,
	registerDeviceSchema,
	REWARD_PUSH_KINDS,
} from './push.ts'

const SITE = 'https://acme.menuza.io'
const GUEST = {
	name: 'Alice Wonderland',
	first: 'Alice',
	phone: '+15555550123',
	email: 'alice@example.com',
	address: '12 Rabbit Hole Lane',
}
const PII = Object.values(GUEST)

function everyPayload() {
	const payloads: unknown[] = []
	for (const locale of PUSH_LOCALES) {
		const context = { locale, siteOrigin: SITE }
		for (const status of ORDER_PUSH_STATUSES) {
			for (const fulfillment of ['pickup', 'delivery']) {
				payloads.push(
					buildOrderStatusPush(
						{ orderId: 'ord_1', number: 'A12', status, fulfillment },
						context,
					),
				)
			}
		}
		for (const kind of BOOKING_PUSH_KINDS)
			payloads.push(buildBookingPush({ kind }, context))
		for (const kind of REWARD_PUSH_KINDS)
			payloads.push(buildRewardPush({ kind }, context))
		payloads.push(
			buildMarketingPush(
				{ title: 'New dish', body: 'Try the lamb', link: '/menu?item=abc' },
				context,
			),
		)
	}
	return payloads
}

describe('push payloads carry no personal data (#105, tested)', () => {
	it('every kind, status and language is free of any name, phone, email or address', () => {
		const payloads = everyPayload()
		expect(payloads.length).toBeGreaterThan(60)
		for (const payload of payloads) {
			expect(payload).not.toBeNull()
			expect(payloadHoldsPersonalData(payload, PII)).toEqual([])
			expect(pushPayloadSchema.safeParse(payload).success).toBe(true)
		}
	})

	it('the builders take no personal input at all: only an order number and ids', () => {
		const payload = buildOrderStatusPush(
			{
				orderId: 'ord_1',
				number: 'A12',
				status: 'ready',
				fulfillment: 'pickup',
				...({ customerName: GUEST.name, phone: GUEST.phone } as object),
			} as never,
			{ locale: 'en', siteOrigin: SITE },
		)!
		expect(payloadHoldsPersonalData(payload, PII)).toEqual([])
		expect(payload).toEqual({
			title: 'Order A12 is ready',
			body: 'Your order is ready for pickup.',
			data: { kind: 'order_status', url: `${SITE}/menu/success?order=ord_1` },
		})
	})

	it('refuses a payload with any key outside the allow list', () => {
		const good = buildBookingPush(
			{ kind: 'confirmation' },
			{ locale: 'en', siteOrigin: SITE },
		)
		expect(
			pushPayloadSchema.safeParse({
				...good,
				data: { ...good.data, customer: GUEST.name },
			}).success,
		).toBe(false)
		expect(
			pushPayloadSchema.safeParse({ ...good, name: GUEST.name }).success,
		).toBe(false)
	})

	it('never puts a capability token in the link: an order link has no fragment', () => {
		const payload = buildOrderStatusPush(
			{
				orderId: 'ord_1',
				number: 'A12',
				status: 'accepted',
				fulfillment: 'pickup',
			},
			{ locale: 'en', siteOrigin: SITE },
		)!
		expect(payload.data.url).not.toContain('#')
		expect(payload.data.url).not.toMatch(/link=|token/)
	})

	it('refuses an order number that could carry text', () => {
		expect(
			buildOrderStatusPush(
				{
					orderId: 'o',
					number: 'Alice at 12 Rabbit Hole',
					status: 'ready',
					fulfillment: 'pickup',
				},
				{ locale: 'en', siteOrigin: SITE },
			),
		).toBeNull()
	})

	it('marketing push refuses merge tags, other hosts and non-https images', () => {
		const context = { locale: 'en', siteOrigin: SITE }
		expect(
			buildMarketingPush({ title: 'Hi {{firstName}}', body: 'x' }, context),
		).toBeNull()
		expect(
			buildMarketingPush({ title: 'Hi', body: 'Code {{couponCode}}' }, context),
		).toBeNull()
		expect(
			buildMarketingPush(
				{ title: 'Hi', body: 'x', link: '//evil.example/x' },
				context,
			),
		).toBeNull()
		expect(
			buildMarketingPush(
				{ title: 'Hi', body: 'x', imageUrl: 'http://x.test/a.png' },
				context,
			),
		).toBeNull()
		expect(
			buildMarketingPush(
				{
					title: 'Hi',
					body: 'x',
					link: '/menu?item=abc',
					imageUrl: 'https://cdn.test/a.png',
				},
				context,
			)!.data.url,
		).toBe(`${SITE}/menu?item=abc`)
	})
})

describe('what reaches the guest', () => {
	it('only accepted, ready and cancelled matter; payment_review and expired never push', () => {
		expect(ORDER_PUSH_STATUSES.every(orderStatusMatters)).toBe(true)
		for (const status of [
			'payment_review',
			'expired',
			'preparing',
			'completed',
			'pending_acceptance',
		]) {
			expect(orderStatusMatters(status)).toBe(false)
			expect(
				buildOrderStatusPush(
					{ orderId: 'o', number: 'A1', status, fulfillment: 'pickup' },
					{ locale: 'en', siteOrigin: SITE },
				),
			).toBeNull()
		}
	})

	it('is idempotent on order id and status', () => {
		expect(orderPushRef('ord_1', 'ready')).toBe('ord_1:ready')
		expect(orderPushRef('ord_1', 'ready')).not.toBe(
			orderPushRef('ord_1', 'cancelled'),
		)
	})

	it('speaks the device’s language, right to left for Arabic, and falls back to English', () => {
		const ar = buildOrderStatusPush(
			{ orderId: 'o', number: 'A1', status: 'ready', fulfillment: 'pickup' },
			{ locale: 'ar-SA', siteOrigin: SITE },
		)!
		expect(ar.title).toContain('A1')
		expect(/[؀-ۿ]/.test(ar.title)).toBe(true)
		const fallback = buildOrderStatusPush(
			{ orderId: 'o', number: 'A1', status: 'ready', fulfillment: 'pickup' },
			{ locale: 'xx', siteOrigin: SITE },
		)!
		expect(fallback.title).toBe('Order A1 is ready')
		const delivery = buildOrderStatusPush(
			{ orderId: 'o', number: 'A1', status: 'ready', fulfillment: 'delivery' },
			{ locale: 'en', siteOrigin: SITE },
		)!
		expect(delivery.title).toBe('Order A1 is on its way')
	})
})

describe('device registration input', () => {
	it('accepts an Expo token and nothing else', () => {
		expect(
			registerDeviceSchema.safeParse({
				token: 'ExponentPushToken[abcdefgh12345]',
				platform: 'ios',
			}).success,
		).toBe(true)
		expect(
			registerDeviceSchema.safeParse({ token: 'not-a-token', platform: 'ios' })
				.success,
		).toBe(false)
		expect(
			registerDeviceSchema.safeParse({
				token: 'ExponentPushToken[abcdefgh12345]',
				platform: 'ios',
				name: 'Alice',
			}).success,
		).toBe(false)
	})
})
