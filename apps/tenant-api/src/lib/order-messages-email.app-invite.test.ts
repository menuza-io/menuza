import { type RestaurantOrder } from '@repo/common/restaurant-orders'
import { describe, expect, it } from 'vitest'
import { renderOrderEmail } from './order-messages-email.ts'

const ORDER = {
	id: 'ord_1',
	number: 'A12',
	locationName: 'Downtown',
	status: 'pending',
	fulfillment: 'pickup',
	currency: 'USD',
	lines: [],
	totalCents: 0,
	subtotalCents: 0,
	taxCents: 0,
	locale: 'en',
} as unknown as RestaurantOrder

const INVITE = [
	{
		store: 'app_store' as const,
		url: 'https://acme.menuza.io/get-app?store=app_store&p=email',
	},
	{
		store: 'play_store' as const,
		url: 'https://acme.menuza.io/get-app?store=play_store&p=email',
	},
]

function render(kind: 'receipt' | 'ready', locale: string, appInvite = INVITE) {
	return renderOrderEmail({
		kind,
		locale,
		theme: null,
		restaurantName: 'Acme',
		order: ORDER,
		timeZone: 'UTC',
		linkUrl: null,
		appInvite,
	} as never)
}

describe('"Track this order in the app" in the receipt email (#196)', () => {
	it('shows the live stores through the counting redirect, in html and text', () => {
		const email = render('receipt', 'en')
		expect(email.html).toContain('Track this order in the app')
		expect(email.html).toContain(
			'href="https://acme.menuza.io/get-app?store=app_store&amp;p=email"',
		)
		expect(email.html).toContain('Download on the App Store')
		expect(email.text).toContain(
			'Get it on Google Play: https://acme.menuza.io/get-app?store=play_store&p=email',
		)
	})

	it('shows only the stores it is given, and nothing without any', () => {
		const onlyApple = render('receipt', 'en', [INVITE[0]!])
		expect(onlyApple.html).toContain('Download on the App Store')
		expect(onlyApple.html).not.toContain('Google Play')
		const none = render('receipt', 'en', [])
		expect(none.html).not.toContain('Track this order in the app')
		expect(none.text).not.toContain('Track this order in the app')
	})

	it('is a receipt-only block', () => {
		expect(render('ready', 'en').html).not.toContain(
			'Track this order in the app',
		)
	})

	it('speaks the guest’s language, right to left for Arabic', () => {
		const arabic = render('receipt', 'ar')
		expect(arabic.html).toContain('dir="rtl"')
		expect(arabic.html).toContain('تتبع هذا الطلب في التطبيق')
		for (const locale of ['de', 'es', 'fr', 'zh']) {
			expect(render('receipt', locale).html).not.toContain(
				'Track this order in the app',
			)
		}
	})

	it('refuses a link that is not http(s)', () => {
		const email = render('receipt', 'en', [
			{ store: 'app_store', url: 'javascript:alert(1)' },
		])
		expect(email.html).not.toContain('javascript:')
		expect(email.html).not.toContain('Track this order in the app')
	})
})

describe('review and app codes in the receipt email (#263)', () => {
	const codes = [
		{ kind: 'review' as const, url: 'https://g.page/r/abc/review', caption: 'Enjoyed it? Tell us' },
		{ kind: 'app' as const, url: 'https://acme.menuza.io/get-app?p=print', caption: 'Order ahead next time' },
	]
	const withCodes = (kind: 'receipt' | 'ready', receiptCodes = codes) =>
		renderOrderEmail({
			kind,
			locale: 'en',
			theme: null,
			restaurantName: 'Acme',
			order: ORDER,
			timeZone: 'UTC',
			linkUrl: null,
			receiptCodes,
		} as never)

	it('shows what the owner switched on, as links with their captions', () => {
		const email = withCodes('receipt')
		expect(email.html).toContain('href="https://g.page/r/abc/review"')
		expect(email.html).toContain('Enjoyed it? Tell us')
		expect(email.html).toContain('Order ahead next time')
		expect(email.text).toContain('Enjoyed it? Tell us: https://g.page/r/abc/review')
	})

	it('shows nothing when nothing is switched on, and only on the receipt', () => {
		expect(withCodes('receipt', []).html).not.toContain('Tell us')
		expect(withCodes('ready').html).not.toContain('Tell us')
	})

	it('refuses an address that is not http(s)', () => {
		const email = withCodes('receipt', [
			{ kind: 'review', url: 'javascript:alert(1)', caption: 'Tell us' },
		])
		expect(email.html).not.toContain('javascript:')
	})
})
